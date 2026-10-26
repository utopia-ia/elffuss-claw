# Broker de modelos

La página que se sirve en `models`, `m1` y `m2` `.elffuss.com` (y, mientras
dura el cambio de dominio, también en los mismos hosts de `.elffuss.utopiaia.com`,
que siguen sirviendo sin redirigir). Se embebe como iframe oculto desde las webs
de Elffuss y guarda los modelos en el almacén del navegador, para que se
descarguen **una vez** en vez de en cada sesión.

Solo responde a las webs de Elffuss que lo embeben: `elffuss.com` y `claw`,
`code`, `t2t`, `translator`, `copilot`, `models`, `m1`, `m2`… `.elffuss.com`, lo
mismo bajo `elffuss.utopiaia.com`, los alias viejos `elffuss-claw` y
`elffuss-code` `.utopiaia.com`, y `localhost` en desarrollo. No a todo
`*.utopiaia.com`, y tampoco a todo `*.elffuss.com`: `git.*` es un Gitea que pinta
markdown escrito por cualquiera y, al ser del mismo site, un script colado ahí
hablaría con el broker en su caché compartida; `key.*` no lo necesita.

Las herramientas (`tools`, `cutout`, `ocr`, `detect` y `depth` `.elffuss.com`, del
repo `elffuss-ai`) entran con menos permisos: solo pueden bajar, consultar o
cancelar uno de los ficheros de su registro (`FICHEROS_HERRAMIENTAS`: cada URL de
Hugging Face fijada a su commit, con su tamaño exacto; el bloque lo imprime
`scripts/broker-repos.mjs` de `elffuss-ai`), y si dicen un tamaño tiene que ser el
de la lista. Ni otros ficheros u otros commits de esos repos, ni vaciar el
almacén, ni guardar copias, ni el diagnóstico. Y solo leen: lo que pide una
herramienta nunca cura (borra) una copia guardada. Si una copia completa no mide
lo que debe, la herramienta recibe «integridad» y la copia se queda; se vacía
desde Claw. Esas páginas abren ficheros del usuario; si una fallara, no podría
llenar el almacén ni borrar los modelos de las demás webs, tampoco con un tamaño
falso.

Estaba solo en el servidor, editada a mano. Se versiona aquí porque lleva
lógica que costó encontrar y que se perdería con un despliegue o una limpieza.

## Lo que NO es obvio y hay que respetar

**Guarda TROCEADO, en partes de 16 MiB.** El navegador corta un fichero suelto
sobre los **1,94 GB** —medido— pase lo que pase con la cuota. Un modelo de
3,8 GB en un solo fichero fallaba con «exceed its storage quota», que suena a
falta de espacio y no lo es: es el tope por fichero. Con el troceado entra.

Las partes eran de 1 GiB, luego de 64 MiB y ahora de 16 MiB por la
**recarga**: con `createWritable` los bytes no están en el fichero hasta
`close()` —viven en un `.crswap` que el navegador tira al recargar—, así que
solo sobrevive lo que ya se cerró. Con 1 GiB una recarga o un corte perdía hasta
un giga; con 16 MiB, como mucho un tramo. El paso de 64 a 16 es por los modelos
de voz del Translator y del Copiloto: son ficheros de unas decenas de MB y, con
64 MiB, cerrar la pestaña a mitad de uno no dejaba ninguna parte cerrada. Lo
guardado antes en partes de 64 MiB se sigue leyendo y reanudando (el marcador
dice cuántas partes hay y lo guardado es la suma de las que haya).

**Reanuda.** Lo guardado es la suma de las partes `k.p0, k.p1…` seguidas y no
vacías; `k.parte` guarda `{total, v}` (tamaño y ETag/Last-Modified del
servidor). Si el fichero del servidor sigue siendo el mismo, se pide el resto
con `Range: bytes=<guardado>-`. Un corte de red cierra la parte en curso (sus
bytes cuentan) y el broker reintenta SOLO, con espera creciente, hasta 6 fallos
seguidos sin avanzar. El progreso lleva `reanudadoDesde` y `reintento`.

**Nunca marca completo lo que no llegó entero.** `k.done` se escribe solo si lo
llegado mide lo que dijo el servidor. Si quien pide manda `bytes` y una copia
guardada no mide eso (la dejaba el broker anterior con un 200 corto), se borra
y se vuelve a bajar.

**Integridad en las dos puertas.** Al escribir: antes de poner `.done` se mide
lo que hay de verdad en las partes y se compara con el total del servidor
(Content-Length / Content-Range) y con `bytes` si el llamador lo mandó. Corte
limpio (llegó menos que el total) = de red, se reanuda; cualquier otra
discrepancia = error `tipo:'integridad'`, se descarta lo bajado y NO se marca ni
se reintenta lo mismo. Si el servidor dice un tamaño distinto del declarado se
corta antes de bajar nada. Al leer (`get` y `has`): el marcador solo vale si
cuadra con lo que hay en disco y con `bytes`; si no (parte corta, marcador
antiguo de solo un número, parte que falta) se **borra marcador y partes** y se
trata como no cacheado. Fallo visto en vivo el 30-sep: una parte de Bonsai quedó
381 MB corta con su `.done`, y el cargador bajaba el modelo entero en cada
arranque. Test: `tests/broker-integridad.mjs`.

**Una descarga por fichero entre pestañas** (Web Locks) y **se puede cancelar**
(`elffuss-model-cancel`): antes, al rendirse la app, el iframe seguía bajando
por detrás mientras la app lo bajaba otra vez por la red.

**Acepta una copia que la web ya tiene** (`elffuss-model-put`), para que el
Translator y el Copiloto pasen aquí lo que guardaban en su propia Cache API sin
volver a bajarlo. Como lo que se guarda lo lee después otra web, solo se acepta
un fichero de Hugging Face cuyos bytes casan con la huella que publica el Hub
(SHA-256 de LFS para los pesos, SHA-1 de blob de git para los JSON), y como
mucho de 512 MiB, porque se lee entero para comprobarlo. El aviso de listo dice
qué mensajes entiende (`puede`), así una web no espera respuesta de un broker
viejo que no conoce `put`.

**El marcador `.done` guarda tamaño y número de partes.** Sin eso, un fichero
truncado por un desalojo del navegador se lee sin error y el modelo sale con
basura dentro.

**Juntar las partes con `new Blob(partes)` no copia los bytes:** el navegador
guarda referencias a los ficheros, así que no se traga los gigabytes en memoria.

## Cómo se despliega

A los TRES hosts. El 27B se guarda en el broker de m1 y m2 (el de su propio
origen), no en el de models: desplegar solo en models deja al 27B con la versión
vieja. Pasó: el 28-sep solo se actualizó models, y m1/m2 siguieron con la de
c4bad40, que borra lo bajado en cada intento.

Los docroots se llaman como el host anterior:

    scp server/broker/index.html <host>:/tmp/br.html
    scp server/broker/sw.js <host>:/tmp/br-sw.js
    ssh <host> 'for h in models m1 m2; do
      sudo cp /tmp/br.html /var/www/$h.elffuss.utopiaia.com/index.html
      sudo cp /tmp/br-sw.js /var/www/$h.elffuss.utopiaia.com/sw.js; done'

`sw.js` es el service worker de la página del broker: la guarda para que abra
sin red (sin ella no hay forma de leer los modelos de esta OPFS). Red primero;
cambiar su `VERSION` si cambia lo que guarda.

Y comprobar que los tres sirven lo mismo que el repo, con el nombre nuevo y,
mientras dure el cambio de dominio, también con el anterior (que sigue sirviendo
sin redirigir):

    for h in models m1 m2; do for d in elffuss.com elffuss.utopiaia.com; do
      curl -s https://$h.$d/ | shasum; done; done
    shasum server/broker/index.html
    curl -s https://models.elffuss.com/sw.js | shasum; shasum server/broker/sw.js

La prueba local, sin producción: `node tests/resume-download.mjs`.

## Cómo se comprueba que cachea de verdad

Por TIEMPOS no vale: la caché HTTP del navegador imita a un almacén compartido y
las dos responden en milisegundos. El único testigo fiable es contar las
peticiones que llegan al servidor:

    sudo grep -c "<fichero>" /var/log/nginx/access.log

Si la segunda carga no añade ninguna, vino del almacén. Medido así: la segunda carga va un orden
de magnitud más rápida, con cero peticiones nuevas.
