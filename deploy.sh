#!/usr/bin/env bash
# Deploy de Elffuss Claw a claw.elffuss.com (servidor UtopiaIA).
# El sitio (nginx + certbot + servicio elffuss-proxy) ya está configurado;
# esto sincroniza la web y el backend de /proxy (ver abajo). Los pesos de
# web/models/ del servidor están protegidos frente a --delete.
set -euo pipefail
cd "$(dirname "$0")"

# La IP y el usuario del servidor NO se publican: se leen del entorno.
# Estuvieron cinco semanas en este fichero dentro de un repo público, que es
# regalar la superficie de ataque entera a quien escanee GitHub.
#   export ELFFUSS_HOST=usuario@servidor  ELFFUSS_KEY=~/.ssh/tu_clave
HOST=${ELFFUSS_HOST:?define ELFFUSS_HOST (usuario@servidor) antes de desplegar}
KEY=${ELFFUSS_KEY:?define ELFFUSS_KEY (ruta a la clave ssh)}
# El docroot conserva el nombre del primer host: es un directorio del
# servidor, no una URL, y renombrarlo no aporta nada.
DEST=/var/www/elffuss-claw.utopiaia.com

# El motor propio (js/engine/) NO viaja con un despliegue normal. Vive
# gitignorado en el árbol pero se sirve al navegador, así que el .gitignore
# protege de un «git add -A» y NO del rsync — que es justo el mecanismo elegido
# para desplegarlo. Con dos sesiones compartiendo árbol de trabajo, eso hizo que
# acabara en producción sin que nadie lo decidiera.
#   Para desplegarlo a propósito:  ./deploy.sh --con-motor
# El filtro «P» evita además que el --delete borre el que ya esté en el servidor.
# Los PESOS nunca viajan en este rsync: en local son enlaces a un disco externo
# y rsync los copia COMO ENLACES, así que el servidor acababa con symlinks rotos
# apuntando a un volumen que allí no existe. Daban 404 —el sondeo del selector
# ocultaba el modelo, que es lo correcto— pero dejaban basura que el día que
# alguien ponga el fichero de verdad le va a costar entender. Los gigabytes se
# suben aparte; aquí solo se protege de que --delete borre los que ya estén.
# El SDK de medios (web/vendor/elffuss-ai/) viaja con la web: sus runtimes no están en git, los restaura ai-sync.mjs
# desde su PIN.json y se comprueban byte a byte antes de subir nada. Sin ellos, imagen, audio, vídeo y PDF no van.
node ai-sync.mjs --check || { echo "✗ web/vendor/elffuss-ai no casa con su PIN.json: node ai-sync.mjs (con ELFFUSS_AI_REPO)"; exit 1; }
PESOS=(--filter='P models/*' --exclude='models/*.gguf')
MOTOR=("${PESOS[@]}" --filter='P js/engine/**' --exclude='js/engine/**')
# El blog diario (elffuss-blog) publica en <docroot>/blog/, que NO existe en
# web/. Sin protegerlo, este --delete lo BORRA en cada despliegue de la app:
# pasó el 2026-09-07, tres días de posts fuera sin que nada avisara.
BLOG=(--filter='P blog/***')
for a in "$@"; do
  if [ "$a" = "--con-motor" ]; then
    echo "▲ el motor propio (js/engine/) SE INCLUYE en este despliegue"
    # El protocolo de publicación pide BARRER antes de publicar. Hasta el
    # 2026-10-10 ese barrido se hacía a mano, o sea que un día no se hizo:
    # veinte de los veintiún ficheros que servía este sitio decían dentro
    # «Licencia: código propio y PRIVADO — no se publica», más el fabricante
    # del chip, la cuota de disco medida en este equipo y un tiempo de espera
    # absoluto. Estuvieron semanas ahí porque nada lo comprobaba.
    #
    # Ahora lo comprueba el mismo instrumento que genera la copia pública, con
    # su propio control positivo, y el despliegue se para si no pasa. Si el
    # guardia no está, tampoco se despliega: un barrido que no se puede
    # ejecutar no es un barrido aprobado.
    GUARDIA=../elffuss-engine/scripts/publica-motor.mjs
    if [ ! -f "$GUARDIA" ]; then
      echo "✗ no encuentro $GUARDIA: no despliego el motor sin barrerlo" >&2; exit 1
    fi
    node "$GUARDIA" --revisa web/js/engine || {
      echo "✗ el motor que ibas a servir no pasa el protocolo. No se ha subido nada." >&2; exit 1; }
    MOTOR=("${PESOS[@]}")
  fi
done

rsync -az --delete "${MOTOR[@]}" "${BLOG[@]}" -e "ssh -i $KEY" web/ "$HOST:$DEST/"

# anti-caché: versionar assets del index con el commit y sellar el build.
# Con cambios sin commitear en web/ (o ficheros nuevos sin añadir) el sello lleva
# «-dirty»: lo desplegado NO es ese commit, y la web solo enlaza el sello a
# GitHub cuando es un commit limpio. Antes se sellaba HEAD tal cual y el enlace
# habría llevado a un código distinto del que se sirve.
V=$(git rev-parse --short HEAD 2>/dev/null || date +%s)
if [ -n "$(git status --porcelain -- web 2>/dev/null)" ]; then V="$V-dirty"; fi
ssh -i "$KEY" "$HOST" "sed -i 's|href=\"css/\([^\"]*\)\.css\"|href=\"css/\1.css?v=$V\"|g; s|src=\"js/\([^\"]*\)\.js\"|src=\"js/\1.js?v=$V\"|g; s|__BUILD__|$V|g' $DEST/index.html"

# El backend de /proxy y /proxy/report (servicio elffuss-proxy) vive en
# ~/elffuss-proxy/, una ruta que no escribe ningún deploy.sh anterior a este.
# Aquellos copiaban serve.py a ~/elffuss/ y reiniciaban el servicio: con el
# ExecStart apuntando aquí, desplegar una rama vieja ya no vuelve a poner el
# proxy abierto, solo escribe un fichero que nadie arranca. Este lo sube como
# serve.py.new y server/install-proxy.sh lo pone en su sitio, reinicia y pasa
# la sonda (server/proxy-probe.py): si no pasa vuelve al anterior, y si
# tampoco, para el servicio. No apuntes ELFFUSS_APPDIR (la variable de los
# deploy.sh viejos) a este directorio.
PROXYDIR=${ELFFUSS_PROXYDIR:-elffuss-proxy}   # relativo al $HOME del servidor
ssh -i "$KEY" "$HOST" "mkdir -p '$PROXYDIR'"
rsync -az -e "ssh -i $KEY" server/proxy-probe.py server/install-proxy.sh "$HOST:$PROXYDIR/"
rsync -az -e "ssh -i $KEY" server/serve.py "$HOST:$PROXYDIR/serve.py.new"
if ! ssh -i "$KEY" "$HOST" "ELFFUSS_PROXYDIR='$PROXYDIR' bash '$PROXYDIR/install-proxy.sh'"; then
  echo "✗ la web está desplegada (build $V), pero el backend de /proxy NO: el motivo, arriba." >&2
  exit 1
fi

echo "✳ desplegado → https://claw.elffuss.com (build $V)"
