#!/usr/bin/env python3
"""Servidor de desarrollo de Elffuss: sirve web/, hace de proxy en /proxy?url=…
y recoge /proxy/report.

En producción este mismo fichero es el backend del servicio elffuss-proxy,
detrás de nginx, que solo le pasa /proxy y /proxy/report. Se instala con
deploy.sh en ~/elffuss-proxy/ (ver server/install-proxy.sh), no en ~/elffuss/.

/proxy es un relé GET ABIERTO hacia la web pública (http y https, puertos 80
y 443): no autentica a nadie. Ver el bloque de /proxy más abajo.

Uso:  python3 server/serve.py [puerto]   (por defecto 8642)
      Escucha solo en 127.0.0.1; ELFFUSS_BIND=0.0.0.0 lo abre a la red.
"""
import functools
import http.client
import http.server
import ipaddress
import json
import re
import socket
import socketserver
import ssl
import sys
import threading
import time
import urllib.parse
import urllib.request
import zlib
from collections import namedtuple
from http import HTTPStatus
from pathlib import Path

import os

ROOT = os.environ.get('ELFFUSS_ROOT') or str(Path(__file__).resolve().parent.parent / 'web')
MAX_PROXY_BYTES = 2_000_000
# En desarrollo, /v1 (modelo) se reenvía a producción; en producción lo
# resuelve nginx directamente contra llama-server, no este forward.
LM_UPSTREAM = os.environ.get('ELFFUSS_LM') or 'https://elffuss.com'

# /proxy/report — buzón de errores/feedback (opt-in, ver web/js/telemetry.js).
# Nunca lleva código del proyecto del usuario, solo el mensaje técnico y
# metadatos (app, versión, user-agent) — se anexa tal cual a un .jsonl para
# revisarlo a mano, sin base de datos ni dependencias.
REPORTS_PATH = os.environ.get('ELFFUSS_REPORTS') or str(Path.home() / 'elffuss' / 'reports.jsonl')
MAX_REPORT_BYTES = 20_000
REPORT_RATE = {}  # ip -> [timestamps] — límite simple sin dependencias
RATE_WINDOW_S, RATE_MAX = 60, 20


# ---------------------------------------------------------------- /proxy?url=…
# El agente lee por aquí las webs que no mandan CORS. La petición la hace EL
# SERVIDOR, así que sin cerrojos esto es un SSRF de manual: cualquiera podría
# pedirle 127.0.0.1:<otro servicio de la máquina> o la metadata de la nube
# (169.254.169.254). Reglas:
#  · solo http/https a los puertos 80 y 443, sin usuario:contraseña en la url;
#  · el nombre se resuelve UNA vez, se rechaza si CUALQUIERA de sus direcciones
#    no es pública, y se conecta a ESA dirección (Host y SNI siguen siendo el
#    nombre): un DNS que cambie de respuesta entre la comprobación y la
#    conexión (DNS rebinding) no cuela nada;
#  · IPv4 solo en forma canónica a.b.c.d: 2130706433, 0x7f.1 o 0177.0.0.1 son
#    127.0.0.1 para el resolver, y se rechazan antes de llegar a él;
#  · las redirecciones se siguen a mano y cada salto se valida igual;
#  · no viaja ninguna cabecera del cliente (ni cookies ni Authorization) y el
#    User-Agent es fijo;
#  · las direcciones de ESTA máquina tampoco: pedir su IP pública (o un nombre
#    que resuelva a ella, como cualquier otro vhost alojado aquí) vuelve a
#    entrar por el nginx de aquí mismo con origen la propia máquina, y /proxy
#    se podría llamar a sí mismo en bucle;
#  · tope de bytes con aviso (X-Proxy-Truncated: 1, nunca un 200 mudo), plazo
#    total, y límites por IP, global y de peticiones simultáneas.
#
# QUÉ NO ES: control de acceso. /proxy es un relé GET ABIERTO a la web pública,
# y no puede ser otra cosa: la app corre entera en el navegador y sin cuentas,
# así que cualquier secreto o cabecera que la página mandase la mandaría igual
# un script (está en el JS que se sirve a todo el mundo). _proxy_caller_ok solo
# impide que OTRA web use el navegador del usuario contra este origen; curl, o
# cualquier cliente que no sea un navegador, pasa. Lo que acota el relé son las
# reglas de destino y los topes: el global existe porque el límite por IP se
# salta repartiendo las peticiones entre muchas IP.
# El mismo código vive en server/serve.py de elffuss-code: cambiar los dos.
PROXY_USER_AGENT = 'Mozilla/5.0 (Elffuss)'
PROXY_PORTS = (80, 443)
PROXY_MAX_URL = 4096
PROXY_MAX_REDIRECTS = 5
PROXY_MAX_ADDRS = 8          # direcciones a las que se intenta conectar, como mucho, por salto
PROXY_CONNECT_TIMEOUT_S = 8
PROXY_READ_TIMEOUT_S = 15
PROXY_TOTAL_TIMEOUT_S = 30   # el proxy_read_timeout de nginx tiene que quedar por encima
PROXY_RATE_WINDOW_S, PROXY_RATE_MAX = 60, 30
# Entre TODOS los clientes, por ventana. Holgado para el uso de la app (una
# búsqueda son dos peticiones), y lo que acota el relé ante una red de bots.
PROXY_GLOBAL_MAX = int(os.environ.get('ELFFUSS_PROXY_GLOBAL_MAX') or 300)
PROXY_SLOTS = threading.BoundedSemaphore(8)
PROXY_SELF_REFRESH_S = 300   # cada cuánto se vuelven a enumerar las direcciones propias

# Además de lo no público y de las direcciones propias que se ven desde aquí, lo
# que se liste en ELFFUSS_PROXY_DENY (CIDR separados por comas): por ejemplo la
# IP pública de la máquina cuando está detrás de NAT y no aparece en ninguna
# interfaz, que es el único caso que la enumeración no ve.
PROXY_DENY = tuple(ipaddress.ip_network(n.strip(), strict=False)
                   for n in (os.environ.get('ELFFUSS_PROXY_DENY') or '').split(',') if n.strip())

_V4_BLOCKED = tuple(ipaddress.ip_network(n) for n in (
    '0.0.0.0/8',          # «esta red»: 0.0.0.0 acaba en localhost en Linux
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',   # privadas
    '100.64.0.0/10',      # CGNAT, con la metadata de algunas nubes (100.100.100.200)
    '127.0.0.0/8',        # loopback
    '169.254.0.0/16',     # enlace local, con la metadata de la nube (169.254.169.254)
    '192.0.0.0/24', '192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24',   # IETF y documentación
    '192.88.99.0/24',     # relé 6to4
    '198.18.0.0/15',      # bancos de pruebas
    '224.0.0.0/4',        # multicast (Python lo da por «global»)
    '240.0.0.0/4',        # reservada, con 255.255.255.255
))
# Fuera de 2000::/3 queda todo lo que no es unicast global: ::, ::1, las
# IPv4-mapeadas (::ffff:a.b.c.d) y compatibles (::a.b.c.d), NAT64 (64:ff9b::),
# ULA (fc00::/7), enlace local (fe80::/10) y multicast (ff00::/8).
_V6_UNICAST = ipaddress.ip_network('2000::/3')
_V6_BLOCKED = tuple(ipaddress.ip_network(n) for n in (
    '2001::/23',          # asignaciones del IETF, con Teredo (2001::/32)
    '2001:db8::/32',      # documentación
    '2002::/16',          # 6to4: lleva una IPv4 dentro
    '3fff::/20',          # documentación (RFC 9637)
))
# Nombres que nunca son internet, se resuelvan a lo que se resuelvan.
_RESERVED_NAMES = ('localhost', 'local', 'internal', 'localdomain', 'home.arpa',
                   'invalid', 'test', 'example', 'onion', 'alt')

_CTRL_RE = re.compile(r'[\x00-\x1f\x7f]')
_NETLOC_RE = re.compile(r'(\[[^\[\]]*\]|[^\[\]:]*)(?::([0-9]*))?')
_LABEL_RE = re.compile(r'[a-z0-9_-]{1,63}')
_NUMERIC_LABEL_RE = re.compile(r'0x[0-9a-f]*|[0-9]+')
_OCTET_RE = re.compile(r'0|[1-9][0-9]{0,2}')
_CONTENT_TYPE_RE = re.compile(r'[\x21-\x7e][\x20-\x7e]{0,199}')
_REDIRECTS = (301, 302, 303, 307, 308)
_UPSTREAM_HEADERS = {   # lo ÚNICO que se manda al destino, además de Host
    'User-Agent': PROXY_USER_AGENT,
    'Accept-Encoding': 'identity',
    'Connection': 'close',
}
_AI_FLAGS = getattr(socket, 'AI_ADDRCONFIG', 0)

Target = namedtuple('Target', 'scheme host port path url addrs')
ProxyResult = namedtuple('ProxyResult', 'status upstream_status content_type body truncated final_url')


class ProxyRefused(Exception):
    """Respuesta de error del proxy: estado HTTP, código corto para la cabecera
    X-Proxy-Error y un motivo legible. Nunca lleva la dirección resuelta."""

    def __init__(self, status, code, detail):
        super().__init__(detail)
        self.status, self.code, self.detail = status, code, detail


def _parse_ip(text):
    try:
        return ipaddress.ip_address(str(text).split('%', 1)[0])
    except ValueError:
        return None


def _in_block_lists(ip):
    """Las listas de arriba, solas: no dependen de la versión de Python."""
    if ip.version == 6:
        return ip not in _V6_UNICAST or any(ip in n for n in _V6_BLOCKED)
    return any(ip in n for n in _V4_BLOCKED)


def _routable(ip):
    """¿Es una dirección de internet? Las listas propias, y además las banderas
    de ipaddress, que cambian de una versión de Python a otra (para ellas
    224.0.0.1 es «global»)."""
    if _in_block_lists(ip):
        return False
    return not (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
                or ip.is_reserved or ip.is_unspecified or not ip.is_global)


def _ip_is_public(ip):
    """¿Se puede conectar a esta dirección? De internet, fuera de
    ELFFUSS_PROXY_DENY y que no sea de esta misma máquina."""
    return (_routable(ip) and not any(ip in n for n in PROXY_DENY)
            and ip not in _self_addresses())


# ------------------------------------------------- las direcciones de esta máquina
_PROC_FIB_TRIE = '/proc/net/fib_trie'    # Linux: cada IPv4 local, «/32 host LOCAL»
_PROC_IF_INET6 = '/proc/net/if_inet6'    # Linux: cada IPv6 de cada interfaz


def _local_v4_from_fib_trie(text):
    """Las IPv4 locales de /proc/net/fib_trie: cada hoja «|-- a.b.c.d» que
    lleva debajo una línea «/32 host LOCAL»."""
    found, leaf = set(), None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith('|-- '):
            leaf = line[4:].strip()
        elif leaf and line.startswith('/32 host LOCAL'):
            found.add(leaf)
    return found


def _local_v6_from_if_inet6(text):
    """Las IPv6 de /proc/net/if_inet6: la primera columna, 32 cifras hex."""
    found = set()
    for line in text.splitlines():
        cols = line.split()
        if cols and len(cols[0]) == 32:
            try:
                found.add(str(ipaddress.IPv6Address(int(cols[0], 16))))
            except ValueError:
                pass
    return found


def _egress_addresses():
    """La dirección con la que la máquina sale a internet, por familia: un
    connect() UDP elige ruta y origen sin mandar ningún paquete. Es lo único
    que hay donde no existe /proc (fuera de Linux)."""
    found = set()
    for family, probe in ((socket.AF_INET, ('192.0.2.1', 9)), (socket.AF_INET6, ('2001:db8::1', 9, 0, 0))):
        try:
            with socket.socket(family, socket.SOCK_DGRAM) as s:
                s.connect(probe)
                found.add(s.getsockname()[0])
        except OSError:
            pass
    return found


def _own_addresses():
    """Las direcciones de internet de esta máquina: las de sus interfaces y la
    de salida. Las privadas y de loopback ya se rechazan por sí solas."""
    found = set()
    for path, parse in ((_PROC_FIB_TRIE, _local_v4_from_fib_trie), (_PROC_IF_INET6, _local_v6_from_if_inet6)):
        try:
            with open(path, encoding='ascii', errors='replace') as f:
                found |= parse(f.read())
        except OSError:
            pass
    found |= _egress_addresses()
    ips = (_parse_ip(a) for a in found)
    return frozenset(ip for ip in ips if ip is not None and _routable(ip))


_self_lock = threading.Lock()
_self_cache = {'at': None, 'addrs': frozenset()}


def _self_addresses():
    """_own_addresses(), vuelta a enumerar como mucho cada PROXY_SELF_REFRESH_S
    (una IP que se añade con la máquina en marcha también cuenta)."""
    with _self_lock:
        now = time.monotonic()
        if _self_cache['at'] is None or now - _self_cache['at'] >= PROXY_SELF_REFRESH_S:
            _self_cache['addrs'] = _own_addresses()
            _self_cache['at'] = now
        return _self_cache['addrs']


def _is_loopback(text):
    ip = _parse_ip(text)
    if ip is not None and ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip is not None and ip.is_loopback


def _rate_key(ip_text):
    """Clave del límite por IP: una IPv6 cuenta por su /64, que es lo que
    tiene cualquier cliente para él solo."""
    ip = _parse_ip(ip_text)
    if ip is None:
        return str(ip_text)[:64]
    if ip.version == 6:
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
        return str(ipaddress.IPv6Network((int(ip) >> 64 << 64, 64)))
    return str(ip)


def _parse_host(raw):
    """→ (ip, host): ip si el host es una dirección literal (y host su forma
    canónica); si es un nombre, (None, nombre en ASCII y minúsculas)."""
    if raw.startswith('['):
        inner = raw[1:-1]
        if '%' in inner:   # zona (fe80::1%eth0): solo existe en enlace local
            raise ProxyRefused(403, 'forbidden-destination', 'destino no permitido (dirección de enlace local)')
        try:
            ip = ipaddress.IPv6Address(inner)
        except ValueError:
            raise ProxyRefused(400, 'bad-host', 'dirección IPv6 mal formada') from None
        return ip, str(ip)
    host = raw[:-1] if raw.endswith('.') else raw
    try:
        host = host.encode('idna').decode('ascii').lower()
    except UnicodeError:
        raise ProxyRefused(400, 'bad-host', 'nombre de host no válido') from None
    labels = host.split('.')
    if not all(_LABEL_RE.fullmatch(label) for label in labels):
        raise ProxyRefused(400, 'bad-host', 'nombre de host no válido')
    # Si la última etiqueta es un número, el resolver lo toma por una IPv4
    # (inet_aton acepta decimal, octal, hex y formas cortas): solo se admite
    # la forma a.b.c.d, en decimal y sin ceros a la izquierda.
    if _NUMERIC_LABEL_RE.fullmatch(labels[-1]):
        if len(labels) != 4 or not all(_OCTET_RE.fullmatch(x) and int(x) <= 255 for x in labels):
            raise ProxyRefused(400, 'odd-ip', 'las IPv4 van en forma a.b.c.d, en decimal')
        return ipaddress.IPv4Address(host), host
    if len(labels) < 2 or any(host == s or host.endswith('.' + s) for s in _RESERVED_NAMES):
        raise ProxyRefused(403, 'forbidden-destination', 'destino no permitido (nombre local o reservado)')
    return None, host


def _getaddrinfo(*args):   # los tests sustituyen esto: es el único punto de DNS
    return socket.getaddrinfo(*args)


def _resolve(host, port):
    """Resuelve UNA vez. Si alguna dirección no es pública se rechaza todo:
    elegir la buena dejaría a un DNS hostil decidir a cuál se conecta."""
    try:
        infos = _getaddrinfo(host, port, 0, socket.SOCK_STREAM, socket.IPPROTO_TCP, _AI_FLAGS)
    except (OSError, UnicodeError):
        raise ProxyRefused(502, 'dns', 'no se pudo resolver el host') from None
    addrs = []
    for family, _type, _proto, _canon, sockaddr in infos:
        ip = _parse_ip(sockaddr[0]) if family in (socket.AF_INET, socket.AF_INET6) else None
        if ip is None or not _ip_is_public(ip):
            raise ProxyRefused(403, 'forbidden-destination',
                               'destino no permitido (el nombre resuelve a una dirección no pública o de esta máquina)')
        if (family, sockaddr) not in addrs:
            addrs.append((family, sockaddr))
    if not addrs:
        raise ProxyRefused(502, 'dns', 'el host no tiene direcciones')
    return addrs


def _check_url(url):
    """Valida una url y la resuelve: → Target con las direcciones ya
    comprobadas, que son las únicas a las que se conectará."""
    if not url:
        raise ProxyRefused(400, 'bad-url', 'falta el parámetro url')
    if len(url) > PROXY_MAX_URL or _CTRL_RE.search(url):
        raise ProxyRefused(400, 'bad-url', 'url demasiado larga o con caracteres de control')
    try:
        parts = urllib.parse.urlsplit(url.strip())
    except ValueError:
        raise ProxyRefused(400, 'bad-url', 'url mal formada') from None
    scheme = parts.scheme.lower()
    if scheme not in ('http', 'https'):
        raise ProxyRefused(400, 'bad-scheme', 'solo http:// y https://')
    if '@' in parts.netloc:
        raise ProxyRefused(400, 'userinfo', 'la url no puede llevar usuario ni contraseña')
    m = _NETLOC_RE.fullmatch(parts.netloc)
    if not m or not m.group(1):
        raise ProxyRefused(400, 'bad-host', 'url sin host válido')
    default_port = 443 if scheme == 'https' else 80
    port = int(m.group(2)) if m.group(2) else default_port
    if port not in PROXY_PORTS:
        raise ProxyRefused(403, 'forbidden-port', 'solo se permiten los puertos 80 y 443')
    ip, host = _parse_host(m.group(1))
    if ip is None:
        addrs = _resolve(host, port)
    elif not _ip_is_public(ip):
        raise ProxyRefused(403, 'forbidden-destination', 'destino no permitido (dirección no pública o de esta máquina)')
    elif ip.version == 6:
        addrs = [(socket.AF_INET6, (host, port, 0, 0))]
    else:
        addrs = [(socket.AF_INET, (host, port))]
    try:
        path = urllib.parse.quote(parts.path or '/', safe="/%:@!$&'()*+,;=~")
        if parts.query:
            path += '?' + urllib.parse.quote(parts.query, safe="/?%:@!$&'()*+,;=~")
    except UnicodeError:
        raise ProxyRefused(400, 'bad-url', 'url mal formada') from None
    netloc = ('[%s]' % host if ':' in host else host) + ('' if port == default_port else ':%d' % port)
    return Target(scheme, host, port, path, '%s://%s%s' % (scheme, netloc, path), tuple(addrs))


def _shutdown(sock):
    try:   # socket.socket.shutdown también sobre un SSLSocket: corta el fd sin tocar el estado TLS
        socket.socket.shutdown(sock, socket.SHUT_RDWR)
    except (OSError, TypeError, ValueError):
        pass


class _Deadline:
    """Plazo TOTAL de una petición al proxy, redirecciones incluidas. Los
    timeouts de socket cuentan por operación, y un servidor que gotea un byte
    cada pocos segundos los esquiva todos: al vencer el plazo se corta el
    socket en uso y la lectura bloqueada falla."""

    def __init__(self, seconds):
        self._end = time.monotonic() + seconds
        self._lock = threading.Lock()
        self._sock = None
        self._fired = False
        self._timer = threading.Timer(seconds, self._fire)
        self._timer.daemon = True
        self._timer.start()

    def remaining(self):
        return self._end - time.monotonic()

    def expired(self):
        return self._fired or self.remaining() <= 0

    def watch(self, sock):
        with self._lock:
            self._sock = sock
            fired = self._fired
        if fired:
            _shutdown(sock)

    def _fire(self):
        with self._lock:
            self._fired = True
            sock = self._sock
        if sock is not None:
            _shutdown(sock)

    def cancel(self):
        self._timer.cancel()
        with self._lock:
            self._sock = None


def _dial(family, sockaddr, timeout):
    """Conexión TCP a una dirección YA validada (los tests sustituyen esto)."""
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.settimeout(timeout)
        sock.connect(sockaddr)
    except BaseException:
        sock.close()
        raise
    return sock


def _dial_order(addrs):
    """Orden de intento: alternando familias, empezando por la que dio primero
    el resolver (RFC 8305 §4). Con IPv6 configurada pero sin ruta, y una
    respuesta que trae primero cuatro AAAA, la primera IPv4 es el segundo
    intento y no queda fuera. Como mucho PROXY_MAX_ADDRS: quien controla el DNS
    de un nombre no convierte una petición en cien conexiones."""
    if not addrs:
        return []
    first = [a for a in addrs if a[0] == addrs[0][0]]
    other = [a for a in addrs if a[0] != addrs[0][0]]
    order = []
    for i in range(max(len(first), len(other))):
        order.extend(group[i] for group in (first, other) if i < len(group))
    return order[:PROXY_MAX_ADDRS]


def _connect(target, deadline):
    last = None
    for family, sockaddr in _dial_order(target.addrs):
        remaining = deadline.remaining()
        if remaining <= 0:
            break
        try:
            sock = _dial(family, sockaddr, min(PROXY_CONNECT_TIMEOUT_S, remaining))
        except OSError as e:
            last = e
            continue
        sock.settimeout(PROXY_READ_TIMEOUT_S)
        deadline.watch(sock)
        return sock
    if deadline.expired():
        raise socket.timeout('plazo agotado')
    raise last or OSError('sin conexión')


@functools.lru_cache(maxsize=None)
def _tls_context():
    ctx = ssl.create_default_context()   # verifica certificado y nombre
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return ctx


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """HTTP contra la dirección ya validada; Host sigue siendo el nombre."""

    def __init__(self, target, deadline):
        super().__init__(target.host, target.port, timeout=PROXY_READ_TIMEOUT_S)
        self._target, self._deadline = target, deadline

    def connect(self):
        self.sock = _connect(self._target, self._deadline)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS contra la dirección ya validada; el SNI y la verificación del
    certificado van contra el nombre, no contra la IP."""

    def __init__(self, target, deadline):
        self._tls = _tls_context()
        super().__init__(target.host, target.port, timeout=PROXY_READ_TIMEOUT_S, context=self._tls)
        self._target, self._deadline = target, deadline

    def connect(self):
        raw = _connect(self._target, self._deadline)
        try:
            tls = self._tls.wrap_socket(raw, server_hostname=self._target.host,
                                        do_handshake_on_connect=False)
        except BaseException:
            raw.close()
            raise
        try:
            tls.settimeout(PROXY_READ_TIMEOUT_S)
            self._deadline.watch(tls)   # el socket de antes ya no es dueño del fd
            tls.do_handshake()
        except BaseException:
            tls.close()
            raise
        self.sock = tls


def _header_text(value):
    """http.client entrega las cabeceras como latin-1; una Location con UTF-8
    crudo se recupera aquí antes de volver a codificarla."""
    try:
        return value.encode('latin-1').decode('utf-8')
    except UnicodeError:
        return value


def _inflate(data, encoding, limit):
    for wbits in ((16 + zlib.MAX_WBITS,) if encoding != 'deflate' else (zlib.MAX_WBITS, -zlib.MAX_WBITS)):
        try:
            out = zlib.decompressobj(wbits).decompress(data, limit + 1)   # nunca más de limit+1
        except zlib.error:
            continue
        return out[:limit], len(out) > limit
    raise ProxyRefused(502, 'encoding', 'la web mandó un cuerpo comprimido corrupto')


def _read_body(resp):
    limit = MAX_PROXY_BYTES
    chunks, total = [], 0
    while total <= limit:
        chunk = resp.read(min(1 << 16, limit + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    raw, truncated = b''.join(chunks), total > limit
    # Se pide identity; si aun así llega comprimido, se descomprime con tope
    # (una bomba gzip no pasa de limit+1 bytes) y el cliente lo recibe plano.
    encoding = (resp.getheader('Content-Encoding') or '').strip().lower()
    if encoding in ('', 'identity'):
        return raw[:limit], truncated
    if encoding not in ('gzip', 'x-gzip', 'deflate'):
        raise ProxyRefused(502, 'encoding', 'la web respondió comprimida en un formato no soportado')
    body, more = _inflate(raw, encoding, limit)
    return body, truncated or more


def _fetch(url, deadline):
    for hop in range(PROXY_MAX_REDIRECTS + 1):
        try:
            target = _check_url(url)
        except ProxyRefused as e:
            if hop == 0 or e.code == 'dns':
                raise
            if e.status == 403:
                raise ProxyRefused(403, 'forbidden-redirect', 'la web redirige a un destino no permitido') from None
            raise ProxyRefused(502, 'bad-redirect', 'la web redirige a una url no válida') from None
        conn_class = _PinnedHTTPSConnection if target.scheme == 'https' else _PinnedHTTPConnection
        conn = conn_class(target, deadline)
        try:
            conn.request('GET', target.path, headers=_UPSTREAM_HEADERS)
            resp = conn.getresponse()
            if resp.status in _REDIRECTS:
                location = resp.getheader('Location')
                if not location or not location.strip():
                    raise ProxyRefused(502, 'bad-redirect', 'redirección sin destino')
                url = urllib.parse.urljoin(target.url, _header_text(location).strip())
                continue
            content_type = (resp.getheader('Content-Type') or '').strip()
            if not _CONTENT_TYPE_RE.fullmatch(content_type):
                content_type = 'application/octet-stream'
            body, truncated = _read_body(resp)
            # Cortar el socket al vencer el plazo se lee como un fin de
            # fichero, y para http.client eso puede ser un final normal (unas
            # cabeceras a medias, un cuerpo sin longitud): lo leído después
            # del corte no es la respuesta, es un 504.
            if deadline.expired():
                raise socket.timeout('plazo agotado')
            # El estado real del destino (un 404 es un 404, no un 200 ni un
            # 502); lo que no es un final normal (1xx, 3xx sueltos) es un 502.
            status = resp.status if 200 <= resp.status < 300 or 400 <= resp.status < 600 else 502
            return ProxyResult(status, resp.status, content_type, body, truncated, target.url)
        finally:
            conn.close()
    raise ProxyRefused(502, 'too-many-redirects', 'demasiadas redirecciones')


def proxy_fetch(url):
    """GET a una url pública con todas las reglas de arriba → ProxyResult, o
    ProxyRefused con el estado y el motivo."""
    deadline = _Deadline(PROXY_TOTAL_TIMEOUT_S)
    try:
        return _fetch(url, deadline)
    except ProxyRefused:
        raise
    except Exception as e:  # noqa: BLE001 — cualquier fallo del destino es un 502/504 con motivo
        if deadline.expired() or isinstance(e, socket.timeout):
            raise ProxyRefused(504, 'timeout', 'la web no respondió a tiempo') from None
        if isinstance(e, ssl.SSLError):
            raise ProxyRefused(502, 'tls', 'fallo TLS con la web (%s)' % type(e).__name__) from None
        raise ProxyRefused(502, 'upstream', 'no se pudo leer la web (%s)' % type(e).__name__) from None
    finally:
        deadline.cancel()


class _RateLimiter:
    """Ventana deslizante por clave, segura entre hilos, que olvida las claves
    viejas (la de /proxy/report crece sin fin)."""

    def __init__(self, window_s, max_hits):
        self.window_s, self.max_hits = window_s, max_hits
        self._hits = {}
        self._lock = threading.Lock()
        self._swept = time.monotonic()

    def allow(self, key):
        now = time.monotonic()
        with self._lock:
            if now - self._swept > self.window_s:
                self._hits = {k: v for k, v in self._hits.items() if v and now - v[-1] < self.window_s}
                self._swept = now
            hits = [t for t in self._hits.get(key, ()) if now - t < self.window_s]
            ok = len(hits) < self.max_hits
            if ok:
                hits.append(now)
            self._hits[key] = hits
            return ok


PROXY_RATE = _RateLimiter(PROXY_RATE_WINDOW_S, PROXY_RATE_MAX)
PROXY_GLOBAL_RATE = _RateLimiter(PROXY_RATE_WINDOW_S, PROXY_GLOBAL_MAX)   # una sola clave: '*'


def _log_target(path):
    """Para el log, solo esquema y host del destino: la ruta y la query pueden
    llevar tokens, y lo que el usuario lee no tiene por qué quedar escrito."""
    try:
        url = (urllib.parse.parse_qs(urllib.parse.urlsplit(path).query).get('url') or [''])[0]
        parts = urllib.parse.urlsplit(url.strip())
        host = parts.hostname or ''
        shown = '%s://%s' % (parts.scheme, '[%s]' % host if ':' in host else host)
    except ValueError:
        shown = '?'
    return re.sub(r'[^A-Za-z0-9.:_\-\[\]/]', '?', shown)[:120]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    # SimpleHTTPRequestHandler NO implementa Range, y el runtime propio lee los
    # pesos por TROZOS: sin esto, un GGUF de cientos de MB simplemente no se
    # puede cargar contra el servidor de desarrollo — falla en la primera
    # petición parcial, no al final. En producción lo resuelve nginx.
    def send_head(self):
        rng = self.headers.get('Range')
        if not rng:
            return super().send_head()
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        try:
            f = open(path, 'rb')
        except OSError:
            self.send_error(404)
            return None
        size = os.fstat(f.fileno()).st_size
        m = re.match(r'^bytes=(\d*)-(\d*)$', rng.strip())
        if not m:
            f.close()
            self.send_error(400, 'Range mal formado')
            return None
        ini, fin = m.group(1), m.group(2)
        if ini == '':                       # sufijo: los últimos N bytes
            start, end = max(0, size - int(fin or 0)), size - 1
        else:
            start = int(ini)
            end = int(fin) if fin else size - 1
        if start >= size or start > end:
            f.close()
            self.send_response(416)
            self.send_header('Content-Range', 'bytes */%d' % size)
            self.end_headers()
            return None
        end = min(end, size - 1)
        f.seek(start)
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Accept-Ranges', 'bytes')
        self.end_headers()
        self._range_left = end - start + 1
        return f

    # copyfile() del padre volcaría el fichero ENTERO desde el offset: hay que
    # cortarlo en los bytes pedidos o una petición de 4 bytes devuelve gigas.
    def copyfile(self, source, outputfile):
        left = getattr(self, '_range_left', None)
        if left is None:
            return super().copyfile(source, outputfile)
        self._range_left = None
        while left > 0:
            chunk = source.read(min(1 << 16, left))
            if not chunk:
                break
            outputfile.write(chunk)
            left -= len(chunk)

    def do_GET(self):
        if self.path.startswith('/proxy?'):
            return self.proxy()
        if self.path.startswith('/v1/'):
            return self.forward_lm()
        super().do_GET()

    def do_POST(self):
        if self.path.startswith('/v1/'):
            return self.forward_lm()
        if self.path == '/proxy/report':
            return self.report()
        self.send_error(404)

    def client_ip(self):
        """IP del cliente para los límites. Detrás de nginx la conexión llega
        SIEMPRE de 127.0.0.1, así que manda X-Forwarded-For, pero solo si lo
        pone alguien en loopback (nginx) y tomando la ÚLTIMA entrada: con
        $proxy_add_x_forwarded_for las anteriores las escribe el propio cliente."""
        peer = self.client_address[0]
        xff = self.headers.get('X-Forwarded-For') or ''
        if xff.strip() and _is_loopback(peer):
            last = xff.split(',')[-1].strip()
            if last:
                return last[:64]
        return peer

    def forward_lm(self):
        """Reenvía /v1/* (API del modelo) al servidor de producción, con streaming."""
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(
            LM_UPSTREAM + self.path, data=body, method=self.command,
            headers={'Content-Type': self.headers.get('Content-Type', 'application/json')})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                self.send_response(r.status)
                self.send_header('Content-Type', r.headers.get('Content-Type', 'application/json'))
                self.end_headers()
                while True:
                    chunk = r.read(1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except Exception as e:  # noqa: BLE001
            self.send_error(502, f'lm: {e}')

    def _proxy_caller_ok(self):
        """Solo la propia página (fetch del mismo origen) o un cliente que no es
        un navegador (curl, el chequeo de salud). Fuera navegaciones, iframes,
        <img>/<script> y cualquier otro origen: así una web ajena no usa el
        navegador del usuario contra este proxy ni abre aquí HTML de terceros
        con nuestro origen. NO es control de acceso: las cabeceras Sec-Fetch-*
        y Origin solo las ponen los navegadores, y quien no las manda pasa."""
        site = (self.headers.get('Sec-Fetch-Site') or '').strip().lower()
        dest = (self.headers.get('Sec-Fetch-Dest') or '').strip().lower()
        if site not in ('', 'same-origin') or dest not in ('', 'empty'):
            return False
        origin = self.headers.get('Origin')
        if origin is not None:
            host = (self.headers.get('Host') or '').strip().lower()
            try:
                return urllib.parse.urlsplit(origin.strip()).netloc.lower() == host
            except ValueError:
                return False
        return True

    def _proxy_safety_headers(self):
        # Lo que sale de aquí es contenido de TERCEROS servido con NUESTRO
        # origen: si alguien abre /proxy?url=<su html> como página, el sandbox
        # sin scripts le quita el origen y no ejecuta nada. Sin CORS: la app lo
        # pide desde su mismo origen y ninguna otra web tiene por qué leerlo.
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'")
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Referrer-Policy', 'no-referrer')

    def _proxy_fail(self, status, code, detail, retry_after=None):
        body = (detail + '\n').encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Proxy-Error', code)
        if retry_after:
            self.send_header('Retry-After', str(retry_after))
        self._proxy_safety_headers()
        self.end_headers()
        self.wfile.write(body)

    def proxy(self):
        if not PROXY_RATE.allow(_rate_key(self.client_ip())):
            return self._proxy_fail(429, 'rate-limited', 'demasiadas peticiones al proxy, espera un poco',
                                    retry_after=PROXY_RATE_WINDOW_S)
        if not self._proxy_caller_ok():
            return self._proxy_fail(403, 'cross-site', 'el proxy solo atiende a la propia app')
        if not PROXY_GLOBAL_RATE.allow('*'):
            return self._proxy_fail(503, 'overloaded', 'el proxy llegó a su límite de peticiones, prueba en un minuto',
                                    retry_after=PROXY_RATE_WINDOW_S)
        qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        url = (qs.get('url') or [''])[0]
        if not PROXY_SLOTS.acquire(blocking=False):
            return self._proxy_fail(503, 'busy', 'proxy ocupado, prueba en unos segundos', retry_after=5)
        try:
            res = proxy_fetch(url)
        except ProxyRefused as e:
            return self._proxy_fail(e.status, e.code, e.detail)
        finally:
            PROXY_SLOTS.release()
        body = b'' if res.status in (204, 205) else res.body
        self.send_response(res.status)
        self.send_header('Content-Type', res.content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Proxy-Truncated', '1' if res.truncated else '0')
        self.send_header('X-Proxy-Upstream-Status', str(res.upstream_status))
        # Dónde acabaron las redirecciones: sin esto, el cliente resuelve los
        # enlaces relativos de la página contra la url que pidió y no contra la
        # que respondió (web-research.js de las apps). Es ASCII siempre: el host
        # va en IDNA y la ruta citada; nunca lleva caracteres de control.
        self.send_header('X-Proxy-Final-Url', res.final_url)
        self._proxy_safety_headers()
        self.end_headers()
        self.wfile.write(body)

    def report(self):
        """Recibe {app, kind, message, stack, url, userAgent, extra} y lo
        anexa a REPORTS_PATH. Solo texto/metadatos — nunca código ni
        contenido del proyecto del usuario (eso jamás sale de su navegador)."""
        # nginx (proxy_pass) hace que client_address SIEMPRE sea 127.0.0.1:
        # con X-Forwarded-For (ver client_ip), el límite es por IP real.
        ip = self.client_ip()
        now = time.time()
        hits = [t for t in REPORT_RATE.get(ip, []) if now - t < RATE_WINDOW_S]
        if len(hits) >= RATE_MAX:
            return self.send_error(429, 'demasiados informes, espera un poco')
        hits.append(now)
        REPORT_RATE[ip] = hits

        length = int(self.headers.get('Content-Length') or 0)
        if length > MAX_REPORT_BYTES:
            return self.send_error(413, 'informe demasiado grande')
        body = self.rfile.read(length) if length else b''
        try:
            payload = json.loads(body or b'{}')
            if not isinstance(payload, dict):
                raise ValueError('payload no es un objeto')
        except Exception:
            return self.send_error(400, 'JSON inválido')

        record = {
            'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now)),
            'ip': ip,
            'app': str(payload.get('app', ''))[:60],
            'kind': str(payload.get('kind', ''))[:30],
            'message': str(payload.get('message', ''))[:2000],
            'stack': str(payload.get('stack', ''))[:4000],
            'url': str(payload.get('url', ''))[:300],
            'userAgent': str(payload.get('userAgent', ''))[:300],
            'extra': str(payload.get('extra', ''))[:2000],
        }
        try:
            path = Path(REPORTS_PATH)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('a', encoding='utf-8') as f:
                f.write(json.dumps(record, ensure_ascii=False) + '\n')
        except Exception as e:  # noqa: BLE001
            return self.send_error(500, f'no pude guardar: {e}')

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_request(self, code='-', size='-'):
        if isinstance(code, HTTPStatus):
            code = code.value
        line = self.requestline
        path = getattr(self, 'path', '') or ''
        if path.startswith('/proxy?'):
            line = '%s /proxy?url=%s' % (self.command, _log_target(path))
        self.log_message('"%s" %s %s', line, str(code), str(size))

    def log_message(self, fmt, *args):
        sys.stderr.write('· %s\n' % (fmt % args))


def main(argv=None):
    argv = sys.argv if argv is None else argv
    port = int(argv[1]) if len(argv) > 1 else 8642
    # Solo loopback salvo que se pida: en producción delante va nginx, y en
    # local basta localhost. Abrirlo a la red expone también el proxy.
    bind = os.environ.get('ELFFUSS_BIND', '127.0.0.1')
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer((bind, port), Handler) as httpd:
        print(f'✳ Elffuss · http://localhost:{port}')
        # Cuántas, no cuáles: si sale 0 en un servidor con IP pública, esa IP
        # no está en ninguna interfaz (NAT) y va a mano en ELFFUSS_PROXY_DENY.
        print(f'  /proxy rechaza {len(_self_addresses())} dirección(es) pública(s) de esta máquina'
              f' y {len(PROXY_DENY)} red(es) de ELFFUSS_PROXY_DENY', flush=True)
        httpd.serve_forever()


if __name__ == '__main__':
    main()
