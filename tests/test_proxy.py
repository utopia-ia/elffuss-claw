#!/usr/bin/env python3
"""Pruebas del proxy endurecido (/proxy?url=…) de server/serve.py.

Sin red: el DNS (serve._getaddrinfo) y la conexión TCP (serve._dial) se
sustituyen, e «internet» es un servidor HTTP local al que el dialer desvía las
direcciones públicas de la prueba. Cualquier otra dirección a la que el proxy
intentara conectar queda apuntada en el dialer y se rechaza, así que cada
vector rechazado comprueba también que NO hubo conexión.

    python3 tests/test_proxy.py
    python3 -m unittest discover -s tests -p 'test_*.py'
"""
import gzip
import http.client
import http.server
import importlib.util
import ipaddress
import json
import os
import socket
import socketserver
import ssl
import sys
import tempfile
import threading
import time
import tracemalloc
import types
import unittest
import urllib.parse
import zlib
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True   # que la prueba no deje __pycache__ junto a serve.py
SERVE_PY = Path(__file__).resolve().parent.parent / 'server' / 'serve.py'
_spec = importlib.util.spec_from_file_location('elffuss_serve', SERVE_PY)
serve = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(serve)
REAL_SELF_ADDRESSES = serve._self_addresses   # las pruebas lo sustituyen; esta copia es la de verdad

PUBLIC_V4 = '93.184.215.14'
PUBLIC_V4_B = '93.184.215.15'
PUBLIC_V6 = '2606:4700:4700::1111'
# Una respuesta de doble pila como la de un CDN: primero cuatro AAAA.
DUAL_V6 = ('2a04:4e42::223', '2a04:4e42:200::223', '2a04:4e42:400::223', '2a04:4e42:600::223')
MANY_V4 = tuple('93.184.216.%d' % i for i in range(1, 11))
NON_PUBLIC_V4 = ('127.0.0.1', '127.255.255.254', '0.0.0.0', '10.0.0.1', '172.16.0.1', '172.31.255.255',
                 '192.168.0.1', '169.254.169.254', '100.64.0.1', '100.100.100.200', '224.0.0.1',
                 '239.255.255.250', '240.0.0.1', '255.255.255.255', '192.0.0.170', '192.0.2.1',
                 '198.18.0.1', '198.51.100.1', '203.0.113.1', '192.88.99.1')
NON_PUBLIC_V6 = ('::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:8.8.8.8',
                 '::127.0.0.1', '::ffff:0:7f00:1', 'fe80::1', 'fc00::1', 'fd00:ec2::254', 'ff02::1',
                 '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', '2001::1',
                 '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:db8::1', '100::1', '3fff::1')


class Upstream:
    """El «internet» de las pruebas: responde según la ruta y apunta cada
    petición con sus cabeceras."""

    def __init__(self):
        self.requests = []
        self.routes = {}
        upstream = self

        class H(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def do_GET(self):
                upstream.requests.append({'path': self.path,
                                          'headers': {k.lower(): v for k, v in self.headers.items()}})
                route = upstream.routes.get(urllib.parse.urlsplit(self.path).path)
                if route is None:
                    route = (404, {'Content-Type': 'text/plain'}, b'no existe')
                if callable(route):
                    return route(self)
                status, headers, body = route
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                if 'Content-Length' not in headers:
                    self.send_header('Content-Length', str(len(body)))
                self.send_header('Connection', 'close')
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
        self.addr = self.httpd.server_address[:2]
        threading.Thread(target=self.httpd.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class FakeDNS:
    """Sustituye a getaddrinfo: nombre → lista de IP (o función que la da)."""

    def __init__(self, table):
        self.table = table
        self.calls = []

    def __call__(self, host, port, *args):
        self.calls.append(host)
        answer = self.table.get(host)
        if callable(answer):
            answer = answer()
        if not answer:
            raise socket.gaierror(socket.EAI_NONAME, 'Name or service not known')
        out = []
        for ip in answer:
            if ':' in ip:
                out.append((socket.AF_INET6, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', (ip, port, 0, 0)))
            else:
                out.append((socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', (ip, port)))
        return out


class Dialer:
    """Sustituye a la conexión TCP: las IP públicas de la prueba van al
    servidor local; cualquier otra se apunta y se rechaza."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, family, sockaddr, timeout):
        self.calls.append((sockaddr[0], sockaddr[1]))
        dest = self.routes.get(sockaddr[0])
        if dest is None:
            raise ConnectionRefusedError('dirección no prevista en la prueba')
        return socket.create_connection(dest, timeout=timeout)


class _PlainAsTLS(socket.socket):
    def do_handshake(self):
        pass


class FakeTLSContext:
    """Contexto TLS de mentira: apunta el server_hostname (SNI y nombre que se
    verifica) y deja la conexión en claro hacia el servidor local."""
    verify_mode = ssl.CERT_REQUIRED
    check_hostname = True
    post_handshake_auth = None

    def __init__(self):
        self.server_hostnames = []

    def wrap_socket(self, sock, server_hostname=None, do_handshake_on_connect=True):
        self.server_hostnames.append(server_hostname)
        return _PlainAsTLS(sock.family, sock.type, sock.proto, fileno=sock.detach())


def _flip(first, then):
    """Respuesta DNS que cambia tras la primera consulta (DNS rebinding)."""
    answers = [first]

    def answer():
        out = answers[0]
        answers[0] = then
        return out
    return answer


class ProxyCase(unittest.TestCase):
    def setUp(self):
        self.upstream = Upstream()
        self.addCleanup(self.upstream.close)
        self.upstream.routes['/ok'] = (200, {'Content-Type': 'text/html; charset=utf-8'}, b'<p>hola</p>')
        self.dns = FakeDNS({
            'example.com': [PUBLIC_V4],
            'www.example.com': [PUBLIC_V4],
            'other.example.org': [PUBLIC_V4_B],
            'xn--bcher-kva.example.com': [PUBLIC_V4],
            'internal.example.com': ['10.0.0.7'],
            'meta.example.com': ['169.254.169.254'],
            'loop.example.com': ['127.0.0.1'],
            'zero.example.com': ['0.0.0.0'],
            'cgnat.example.com': ['100.100.100.200'],
            'mcast.example.com': ['224.0.0.251'],
            'bcast.example.com': ['255.255.255.255'],
            'v6loop.example.com': ['::1'],
            'mapped.example.com': ['::ffff:10.0.0.1'],
            'ula.example.com': ['fd00:ec2::254'],
            'linklocal6.example.com': ['fe80::1'],
            'nat64.example.com': ['64:ff9b::a9fe:a9fe'],
            'mixed.example.com': [PUBLIC_V4, '192.168.1.10'],
            'rebind.example.com': _flip([PUBLIC_V4], ['127.0.0.1']),
            'flip.example.com': _flip([PUBLIC_V4], ['127.0.0.1']),
            'dual.example.com': list(DUAL_V6) + [PUBLIC_V4, PUBLIC_V4_B],
            'many.example.com': list(MANY_V4),
            'late.example.com': list(MANY_V4[:4]) + [PUBLIC_V4],
        })
        self.dialer = Dialer({PUBLIC_V4: self.upstream.addr, PUBLIC_V4_B: self.upstream.addr,
                              PUBLIC_V6: self.upstream.addr})
        self.tls = FakeTLSContext()
        self.own = frozenset()   # las direcciones de «esta máquina» en la prueba
        self.logs = []
        logs = self.logs
        for name, value in (('_getaddrinfo', self.dns), ('_dial', self.dialer),
                            ('_tls_context', lambda: self.tls),
                            ('_self_addresses', lambda: self.own),
                            ('PROXY_RATE', serve._RateLimiter(60, 10_000)),
                            ('PROXY_GLOBAL_RATE', serve._RateLimiter(60, 10_000)),
                            ('PROXY_SLOTS', threading.BoundedSemaphore(8))):
            patcher = mock.patch.object(serve, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = mock.patch.object(serve.Handler, 'log_message', lambda h, fmt, *a: logs.append(fmt % a))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), serve.Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def get(self, url=None, headers=None, path=None):
        if path is None:
            path = '/proxy?url=' + urllib.parse.quote(url, safe='')
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=30)
        try:
            conn.request('GET', path, headers=headers or {})
            resp = conn.getresponse()
            return resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read()
        finally:
            conn.close()

    def assertRefused(self, url, status, code=None, headers=None):
        dials_before = list(self.dialer.calls)
        got, hdrs, body = self.get(url, headers=headers)
        self.assertEqual(got, status, '%s → %s %s' % (url, got, body[:200]))
        if code is not None:
            self.assertEqual(hdrs.get('x-proxy-error'), code, url)
        self.assertEqual(hdrs.get('x-content-type-options'), 'nosniff', url)
        self.assertNotIn('access-control-allow-origin', hdrs, url)
        self.assertEqual(self.dialer.calls, dials_before, '%s: el proxy llegó a conectar' % url)
        return hdrs, body


class RefusedVectors(ProxyCase):
    def test_only_http_and_https(self):
        for url in ('file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/',
                    'dict://example.com:11211/', 'ws://example.com/', 'javascript:alert(1)',
                    'data:text/html,hola', 'example.com/ok', '//example.com/ok'):
            with self.subTest(url=url):
                self.assertRefused(url, 400, 'bad-scheme')

    def test_missing_or_malformed_url(self):
        status, hdrs, _ = self.get(path='/proxy?otra=1')
        self.assertEqual((status, hdrs.get('x-proxy-error')), (400, 'bad-url'))
        for url in ('http://', 'http:///solo-ruta', 'http://exa mple.com/', 'http://example.com:80:80/',
                    'http://ex%61mple.com/', 'http://[::1/', 'http://[zz::1]/', 'http://[::1]x/',
                    'http://example.com/\r\nX-Inyectada: 1', 'http://example.com/' + 'a' * 5000):
            with self.subTest(url=url):
                self.assertRefused(url, 400)

    def test_userinfo_refused(self):
        for url in ('http://user:pw@example.com/', 'http://example.com@127.0.0.1/',
                    'http://@example.com/', 'http://example.com\\@127.0.0.1/'):
            with self.subTest(url=url):
                self.assertRefused(url, 400, 'userinfo')

    def test_only_ports_80_and_443(self):
        for url in ('http://example.com:22/', 'http://example.com:8643/', 'http://example.com:6379/',
                    'https://example.com:8443/', 'http://example.com:0/', 'http://example.com:65536/',
                    'http://example.com:99999999/', 'http://127.0.0.1:1/'):
            with self.subTest(url=url):
                self.assertRefused(url, 403, 'forbidden-port')
        self.assertEqual(self.dns.calls, [], 'un puerto prohibido no debe ni resolverse')

    def test_non_public_ipv4_literals(self):
        for ip in NON_PUBLIC_V4 + ('127.0.0.1.',):
            with self.subTest(ip=ip):
                self.assertRefused('http://%s/' % ip, 403, 'forbidden-destination')
        self.assertEqual(self.dns.calls, [], 'una IP literal no pasa por el DNS')

    def test_odd_ipv4_spellings(self):
        for host in ('2130706433', '0x7f000001', '0X7F000001', '017700000001', '0177.0.0.1', '0x7f.0.0.1',
                     '127.1', '127.0.1', '127.0.0.01', '0x7f.1', '0', '0x0', '010.0.0.1', '1.2.3.4.5',
                     '256.1.1.1', '1.2.3', '134744072', '0x08.0x08.0x08.0x08',
                     '\uff10x7f.0.0.1',            # cero de ancho completo: NFKC lo deja en 0x7f
                     '\u2460\u2461\u2466.0.0.1.1'):  # dígitos en círculo: NFKC los deja en 127
            with self.subTest(host=host):
                self.assertRefused('http://%s/' % host, 400, 'odd-ip')
        self.assertEqual(self.dns.calls, [])

    def test_non_public_ipv6_literals(self):
        for host in ['[%s]' % ip for ip in NON_PUBLIC_V6] + ['[fe80::1%25eth0]']:
            with self.subTest(host=host):
                self.assertRefused('http://%s/' % host, 403, 'forbidden-destination')
        self.assertEqual(self.dns.calls, [])

    def test_local_and_reserved_names_are_never_resolved(self):
        for host in ('localhost', 'LOCALHOST.', 'foo.localhost', 'metadata.google.internal', 'printer.local',
                     'router.home.arpa', 'intranet', 'x.test', 'foo.example', 'nas.localdomain'):
            with self.subTest(host=host):
                self.assertRefused('http://%s/' % host, 403, 'forbidden-destination')
        self.assertEqual(self.dns.calls, [])

    def test_names_resolving_to_non_public_addresses(self):
        for host in ('internal.example.com', 'meta.example.com', 'loop.example.com', 'zero.example.com',
                     'cgnat.example.com', 'mcast.example.com', 'bcast.example.com', 'v6loop.example.com',
                     'mapped.example.com', 'ula.example.com', 'linklocal6.example.com', 'nat64.example.com'):
            with self.subTest(host=host):
                _, body = self.assertRefused('http://%s/' % host, 403, 'forbidden-destination')
                ip = self.dns.table[host][0]
                self.assertNotIn(ip.encode(), body, 'el error no debe decir a qué resuelve')

    def test_one_non_public_answer_refuses_the_whole_name(self):
        self.assertRefused('http://mixed.example.com/ok', 403, 'forbidden-destination')

    def test_dns_failure_is_a_502(self):
        self.assertRefused('http://nxdomain.example.com/', 502, 'dns')

    def test_deny_list_from_the_environment(self):
        with mock.patch.object(serve, 'PROXY_DENY', (ipaddress.ip_network(PUBLIC_V4 + '/32'),)):
            self.assertRefused('http://example.com/ok', 403, 'forbidden-destination')

    def test_own_public_addresses_are_refused_without_any_configuration(self):
        # Pedir la IP pública de la propia máquina, o un nombre alojado en
        # ella, vuelve a entrar por su nginx con origen la propia máquina.
        self.assertEqual(serve.PROXY_DENY, ())
        self.own = frozenset({ipaddress.ip_address(PUBLIC_V4_B), ipaddress.ip_address(PUBLIC_V6)})
        for url in ('http://%s/' % PUBLIC_V4_B, 'https://%s/ok' % PUBLIC_V4_B, 'http://[%s]/ok' % PUBLIC_V6,
                    'http://other.example.org/ok'):   # este nombre resuelve a PUBLIC_V4_B
            with self.subTest(url=url):
                _, body = self.assertRefused(url, 403, 'forbidden-destination')
                self.assertNotIn(PUBLIC_V4_B.encode(), body, 'el error no debe decir a qué resuelve')
        self.upstream.routes['/to-self'] = (302, {'Location': 'http://other.example.org/ok'}, b'')
        got, hdrs, _ = self.get('http://example.com/to-self')
        self.assertEqual((got, hdrs.get('x-proxy-error')), (403, 'forbidden-redirect'))
        self.assertEqual(self.dialer.calls, [(PUBLIC_V4, 80)], 'solo el primer salto conecta')
        self.assertEqual(self.get('http://example.com/ok')[0], 200, 'las demás direcciones públicas siguen sirviendo')

    def test_callers_other_than_the_app_itself(self):
        for headers in ({'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty'},
                        {'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty'},
                        {'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document'},
                        {'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe'},
                        {'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image'},
                        {'Origin': 'https://evil.example.net'},
                        {'Origin': 'null'}):
            with self.subTest(headers=headers):
                self.assertRefused('http://example.com/ok', 403, 'cross-site', headers=headers)


class Redirects(ProxyCase):
    def redirect(self, path, location, status=302):
        self.upstream.routes[path] = (status, {'Location': location}, b'')

    def test_redirect_to_non_public_destinations(self):
        cases = {
            '/to-loopback': ('http://127.0.0.1/admin', 403),
            '/to-metadata': ('http://169.254.169.254/latest/meta-data/', 403),
            '/to-v6-loopback': ('http://[::1]/', 403),
            '/to-mapped': ('http://[::ffff:127.0.0.1]/', 403),
            '/to-internal-name': ('http://internal.example.com/', 403),
            '/to-localhost': ('http://localhost/', 403),
            '/to-port': ('http://example.com:6379/', 403),
            '/to-odd': ('http://2130706433/', 502),
            '/to-file': ('file:///etc/passwd', 502),
            '/to-gopher': ('gopher://example.com/', 502),
            '/to-userinfo': ('http://user@example.com/', 502),
        }
        for i, (path, (location, status)) in enumerate(cases.items()):
            self.redirect(path, location, status=(301, 302, 303, 307, 308)[i % 5])
        for path, (location, status) in cases.items():
            with self.subTest(location=location):
                self.dialer.calls.clear()
                got, hdrs, _ = self.get('http://example.com' + path)
                self.assertEqual(got, status)
                self.assertEqual(hdrs.get('x-proxy-error'), 'forbidden-redirect' if status == 403 else 'bad-redirect')
                self.assertEqual(self.dialer.calls, [(PUBLIC_V4, 80)], 'solo el primer salto conecta')

    def test_every_hop_is_resolved_again(self):
        # Mismo nombre en los dos saltos: la segunda vez resuelve a loopback.
        self.redirect('/hop', 'http://flip.example.com/ok')
        got, hdrs, _ = self.get('http://flip.example.com/hop')
        self.assertEqual((got, hdrs.get('x-proxy-error')), (403, 'forbidden-redirect'))
        self.assertEqual(self.dns.calls.count('flip.example.com'), 2)
        self.assertEqual(self.dialer.calls, [(PUBLIC_V4, 80)])

    def test_redirect_loop_stops(self):
        self.redirect('/loop', '/loop')
        got, hdrs, _ = self.get('http://example.com/loop')
        self.assertEqual((got, hdrs.get('x-proxy-error')), (502, 'too-many-redirects'))
        self.assertEqual(len(self.upstream.requests), serve.PROXY_MAX_REDIRECTS + 1)

    def test_redirect_without_location(self):
        self.upstream.routes['/nowhere'] = (302, {}, b'')
        got, hdrs, _ = self.get('http://example.com/nowhere')
        self.assertEqual((got, hdrs.get('x-proxy-error')), (502, 'bad-redirect'))

    def test_relative_and_cross_host_redirects_are_followed(self):
        self.redirect('/rel', '/ok', status=301)
        got, hdrs, body = self.get('http://example.com/rel')
        self.assertEqual((got, body), (200, b'<p>hola</p>'))
        self.assertEqual([r['path'] for r in self.upstream.requests], ['/rel', '/ok'])
        self.redirect('/away', 'https://other.example.org/ok', status=307)
        got, _, body = self.get('http://example.com/away')
        self.assertEqual((got, body), (200, b'<p>hola</p>'))
        self.assertEqual(self.tls.server_hostnames, ['other.example.org'])
        self.assertEqual(self.dialer.calls[-1], (PUBLIC_V4_B, 443))
        self.assertEqual(self.upstream.requests[-1]['headers']['host'], 'other.example.org')

    def test_the_final_address_is_told(self):
        self.redirect('/moved', 'https://other.example.org/ok?x=1', status=301)
        got, hdrs, _ = self.get('http://example.com/moved')
        self.assertEqual(got, 200)
        self.assertEqual(hdrs['x-proxy-final-url'], 'https://other.example.org/ok?x=1')
        _, hdrs, _ = self.get('http://bücher.example.com/ok')
        self.assertEqual(hdrs['x-proxy-final-url'], 'http://xn--bcher-kva.example.com/ok', 'ASCII: el host en IDNA')


class NormalFetch(ProxyCase):
    def test_public_http_fetch(self):
        status, hdrs, body = self.get('http://example.com/ok')
        self.assertEqual((status, body), (200, b'<p>hola</p>'))
        self.assertEqual(hdrs['content-type'], 'text/html; charset=utf-8')
        self.assertEqual(hdrs['x-proxy-truncated'], '0')
        self.assertEqual(hdrs['x-proxy-upstream-status'], '200')
        self.assertEqual(self.dialer.calls, [(PUBLIC_V4, 80)])
        self.assertEqual(self.upstream.requests[0]['headers']['host'], 'example.com')

    def test_https_connects_to_the_checked_address_with_the_name_as_sni(self):
        status, _, body = self.get('https://example.com/ok')
        self.assertEqual((status, body), (200, b'<p>hola</p>'))
        self.assertEqual(self.dialer.calls, [(PUBLIC_V4, 443)])
        self.assertEqual(self.tls.server_hostnames, ['example.com'])
        self.assertEqual(self.upstream.requests[0]['headers']['host'], 'example.com')

    def test_ipv4_is_reached_when_the_first_answers_are_unreachable_ipv6(self):
        # Máquina con IPv6 configurada pero sin ruta: las AAAA fallan al
        # conectar. Antes se probaban solo las tres primeras (todas IPv6).
        status, _, body = self.get('http://dual.example.com/ok')
        self.assertEqual((status, body), (200, b'<p>hola</p>'))
        self.assertEqual(self.dialer.calls, [(DUAL_V6[0], 80), (PUBLIC_V4, 80)])

    def test_every_address_is_tried_up_to_the_cap(self):
        status, _, _ = self.get('http://late.example.com/ok')   # la buena es la quinta
        self.assertEqual(status, 200)
        self.assertEqual([ip for ip, _ in self.dialer.calls], list(MANY_V4[:4]) + [PUBLIC_V4])
        self.dialer.calls.clear()
        status, hdrs, _ = self.get('http://many.example.com/ok')   # diez, ninguna contesta
        self.assertEqual((status, hdrs.get('x-proxy-error')), (502, 'upstream'))
        self.assertEqual([ip for ip, _ in self.dialer.calls], list(MANY_V4[:serve.PROXY_MAX_ADDRS]))

    def test_resolved_once_then_pinned(self):
        # El DNS cambia de respuesta tras la primera consulta: no se le vuelve a preguntar.
        status, _, _ = self.get('http://rebind.example.com/ok')
        self.assertEqual(status, 200)
        self.assertEqual(self.dns.calls, ['rebind.example.com'])
        self.assertEqual(self.dialer.calls, [(PUBLIC_V4, 80)])

    def test_public_ipv6_literal_and_explicit_default_port(self):
        status, _, _ = self.get('http://[%s]/ok' % PUBLIC_V6)
        self.assertEqual(status, 200)
        self.assertEqual(self.dialer.calls, [(PUBLIC_V6, 80)])
        self.assertEqual(self.upstream.requests[0]['headers']['host'], '[%s]' % PUBLIC_V6)
        status, _, _ = self.get('http://example.com:80/ok')
        self.assertEqual(status, 200)

    def test_international_domain_names(self):
        status, _, _ = self.get('http://bücher.example.com/ok')
        self.assertEqual(status, 200)
        self.assertEqual(self.upstream.requests[0]['headers']['host'], 'xn--bcher-kva.example.com')

    def test_client_headers_never_reach_the_destination(self):
        status, _, _ = self.get('http://example.com/ok', headers={
            'Cookie': 'session=secreto', 'Authorization': 'Bearer secreto', 'Proxy-Authorization': 'Basic eA==',
            'User-Agent': 'otro', 'Referer': 'https://claw.elffuss.com/', 'X-Forwarded-For': '192.0.2.1',
            'Accept-Language': 'es'})
        self.assertEqual(status, 200)
        sent = self.upstream.requests[0]['headers']
        self.assertEqual(set(sent), {'host', 'user-agent', 'accept-encoding', 'connection'})
        self.assertEqual(sent['user-agent'], serve.PROXY_USER_AGENT)
        self.assertEqual(sent['accept-encoding'], 'identity')

    def test_response_headers_are_minimal(self):
        self.upstream.routes['/noisy'] = (200, {
            'Content-Type': 'text/html', 'Set-Cookie': 'a=b', 'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': 'true', 'X-Frame-Options': 'ALLOWALL',
            'Content-Security-Policy': "script-src *", 'Link': '</x>; rel=preload'}, b'cuerpo')
        status, hdrs, body = self.get('http://example.com/noisy')
        self.assertEqual((status, body), (200, b'cuerpo'))
        allowed = {'content-type', 'content-length', 'x-proxy-truncated', 'x-proxy-upstream-status', 'x-proxy-final-url',
                   'x-content-type-options', 'content-security-policy', 'cross-origin-resource-policy',
                   'referrer-policy', 'cache-control', 'server', 'date'}
        self.assertLessEqual(set(hdrs), allowed)
        self.assertEqual(hdrs['x-content-type-options'], 'nosniff')
        self.assertIn('sandbox', hdrs['content-security-policy'])
        self.assertNotIn('script-src', hdrs['content-security-policy'])

    def test_odd_content_type_is_replaced(self):
        self.upstream.routes['/ct'] = (200, {'Content-Type': 'text/html\x7f'}, b'x')
        _, hdrs, _ = self.get('http://example.com/ct')
        self.assertEqual(hdrs['content-type'], 'application/octet-stream')

    def test_truncation_is_announced(self):
        self.upstream.routes['/big'] = (200, {'Content-Type': 'text/plain'}, b'a' * 5000)
        self.upstream.routes['/exact'] = (200, {'Content-Type': 'text/plain'}, b'b' * 1000)
        with mock.patch.object(serve, 'MAX_PROXY_BYTES', 1000):
            status, hdrs, body = self.get('http://example.com/big')
            self.assertEqual((status, len(body), hdrs['x-proxy-truncated']), (200, 1000, '1'))
            status, hdrs, body = self.get('http://example.com/exact')
            self.assertEqual((status, len(body), hdrs['x-proxy-truncated']), (200, 1000, '0'))

    def test_upstream_status_is_passed_through(self):
        self.upstream.routes['/boom'] = (500, {'Content-Type': 'text/plain'}, b'roto')
        for path, code in (('/missing', 404), ('/boom', 500)):
            status, hdrs, _ = self.get('http://example.com' + path)
            self.assertEqual((status, hdrs['x-proxy-upstream-status']), (code, str(code)))

    def test_gzip_is_decoded_with_a_ceiling(self):
        self.upstream.routes['/gz'] = (200, {'Content-Type': 'text/plain', 'Content-Encoding': 'gzip'},
                                       gzip.compress(b'hola ' * 100))
        self.upstream.routes['/bomb'] = (200, {'Content-Type': 'text/plain', 'Content-Encoding': 'gzip'},
                                         gzip.compress(b'\0' * 5_000_000))
        self.upstream.routes['/br'] = (200, {'Content-Type': 'text/plain', 'Content-Encoding': 'br'}, b'xx')
        status, hdrs, body = self.get('http://example.com/gz')
        self.assertEqual((status, body), (200, b'hola ' * 100))
        self.assertNotIn('content-encoding', hdrs)
        with mock.patch.object(serve, 'MAX_PROXY_BYTES', 1000):
            status, hdrs, body = self.get('http://example.com/bomb')
        self.assertEqual((status, len(body), hdrs['x-proxy-truncated']), (200, 1000, '1'))
        status, hdrs, _ = self.get('http://example.com/br')
        self.assertEqual((status, hdrs.get('x-proxy-error')), (502, 'encoding'))

    def test_total_deadline_cuts_a_dripping_server(self):
        def drip_body(h):
            h.send_response(200)
            h.send_header('Content-Type', 'text/plain')
            h.end_headers()
            try:
                for _ in range(400):
                    h.wfile.write(b'x')
                    h.wfile.flush()
                    time.sleep(0.05)
            except OSError:
                pass

        def drip_headers(h):
            try:
                h.wfile.write(b'HTTP/1.1 200 OK\r\n')
                for _ in range(400):
                    h.wfile.write(b'X-Goteo: 1\r\n')
                    h.wfile.flush()
                    time.sleep(0.05)
            except OSError:
                pass
        self.upstream.routes['/drip-body'] = drip_body
        self.upstream.routes['/drip-headers'] = drip_headers
        with mock.patch.object(serve, 'PROXY_TOTAL_TIMEOUT_S', 1), mock.patch.object(serve, 'PROXY_READ_TIMEOUT_S', 10):
            for path in ('/drip-body', '/drip-headers'):
                with self.subTest(path=path):
                    started = time.monotonic()
                    status, hdrs, _ = self.get('http://example.com' + path)
                    self.assertEqual((status, hdrs.get('x-proxy-error')), (504, 'timeout'))
                    self.assertLess(time.monotonic() - started, 8, 'el plazo total no cortó la conexión')

    def test_rate_limit_per_client_ip(self):
        with mock.patch.object(serve, 'PROXY_RATE', serve._RateLimiter(60, 3)):
            codes = [self.get('http://example.com/ok', headers={'X-Forwarded-For': '192.0.2.10'})[0]
                     for _ in range(4)]
            self.assertEqual(codes, [200, 200, 200, 429])
            # La entrada que cuenta es la última (la que pone nginx), no la que escribe el cliente.
            status, hdrs, _ = self.get('http://example.com/ok',
                                       headers={'X-Forwarded-For': '192.0.2.99, 192.0.2.10'})
            self.assertEqual((status, hdrs.get('x-proxy-error')), (429, 'rate-limited'))
            self.assertIn('retry-after', hdrs)
            status, _, _ = self.get('http://example.com/ok', headers={'X-Forwarded-For': '192.0.2.11'})
            self.assertEqual(status, 200)
        self.assertEqual(len(self.upstream.requests), 4)

    def test_global_limit_counts_every_client(self):
        # El límite por IP se salta repartiendo las peticiones entre muchas IP:
        # el global no.
        with mock.patch.object(serve, 'PROXY_GLOBAL_RATE', serve._RateLimiter(60, 3)):
            answers = [self.get('http://example.com/ok', headers={'X-Forwarded-For': '192.0.2.%d' % (20 + i)})
                       for i in range(4)]
        self.assertEqual([a[0] for a in answers], [200, 200, 200, 503])
        self.assertEqual(answers[-1][1].get('x-proxy-error'), 'overloaded')
        self.assertIn('retry-after', answers[-1][1])
        self.assertEqual(len(self.upstream.requests), 3)

    def test_non_browser_clients_are_served_the_proxy_is_an_open_relay(self):
        # Lo que hay que saber de /proxy: sin Sec-Fetch-* ni Origin (curl, un
        # script) se atiende. Las cabeceras de navegador frenan a OTRAS webs que
        # usen el navegador del usuario, no a nadie más; lo que acota el relé
        # son los destinos permitidos y los límites.
        status, _, body = self.get('http://example.com/ok', headers={'User-Agent': 'curl/8.7.1'})
        self.assertEqual((status, body), (200, b'<p>hola</p>'))

    def test_busy_when_every_slot_is_taken(self):
        slots = threading.BoundedSemaphore(1)
        slots.acquire()
        with mock.patch.object(serve, 'PROXY_SLOTS', slots):
            status, hdrs, _ = self.get('http://example.com/ok')
        slots.release()
        self.assertEqual((status, hdrs.get('x-proxy-error')), (503, 'busy'))
        self.assertEqual(self.dialer.calls, [])

    def test_same_origin_callers_are_served(self):
        for headers in ({'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty'},
                        {'Origin': 'http://127.0.0.1:%d' % self.port}):
            with self.subTest(headers=headers):
                status, _, _ = self.get('http://example.com/ok', headers=headers)
                self.assertEqual(status, 200)

    def test_log_keeps_only_the_destination_host(self):
        self.get('http://example.com/ruta-secreta?token=abc123')
        line = [entry for entry in self.logs if '/proxy?' in entry]
        self.assertEqual(len(line), 1, self.logs)
        self.assertIn('http://example.com', line[0])
        self.assertNotIn('ruta-secreta', line[0])
        self.assertNotIn('abc123', line[0])

    @unittest.skipUnless(hasattr(serve.Handler, 'report'), 'solo el servidor de Claw recoge /proxy/report')
    def test_report_counts_the_address_nginx_appended(self):
        with tempfile.TemporaryDirectory() as tmp:
            reports = os.path.join(tmp, 'reports.jsonl')
            with mock.patch.object(serve, 'REPORTS_PATH', reports), mock.patch.object(serve, 'REPORT_RATE', {}):
                conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
                conn.request('POST', '/proxy/report', body=json.dumps({'app': 'prueba', 'message': 'hola'}),
                             headers={'Content-Type': 'application/json',
                                      'X-Forwarded-For': 'escrito-por-el-cliente, 192.0.2.44'})
                self.assertEqual(conn.getresponse().status, 200)
                conn.close()
            with open(reports, encoding='utf-8') as f:
                self.assertEqual(json.loads(f.readline())['ip'], '192.0.2.44')


FIB_TRIE = """Main:
  +-- 0.0.0.0/0 3 0 5
     |-- 0.0.0.0
        /0 universe UNICAST
     +-- 93.184.215.0/24 2 0 2
        |-- 93.184.215.0
           /24 link UNICAST
        |-- 93.184.215.20
           /32 host LOCAL
        |-- 93.184.215.255
           /32 link BROADCAST
     +-- 127.0.0.0/8 2 0 2
        |-- 127.0.0.1
           /32 host LOCAL
     +-- 172.17.0.0/16 2 0 2
        |-- 172.17.0.1
           /32 host LOCAL
Local:
  +-- 0.0.0.0/0 3 0 5
     |-- 93.184.215.20
        /32 host LOCAL
"""
IF_INET6 = """00000000000000000000000000000001 01 80 10 80       lo
fe80000000000000021122fffe334455 02 40 20 80     eth0
2a0000000000abcd0000000000000020 02 40 00 80     eth0
"""


class Units(unittest.TestCase):
    def setUp(self):
        # Nada de las direcciones reales de la máquina que corre la prueba.
        patcher = mock.patch.object(serve, '_self_addresses', lambda: frozenset())
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_own_addresses_from_proc_and_the_egress_route(self):
        self.assertEqual(serve._local_v4_from_fib_trie(FIB_TRIE), {'93.184.215.20', '127.0.0.1', '172.17.0.1'})
        self.assertEqual(serve._local_v6_from_if_inet6(IF_INET6),
                         {'::1', 'fe80::211:22ff:fe33:4455', '2a00:0:0:abcd::20'})
        with tempfile.TemporaryDirectory() as tmp:
            fib, inet6 = os.path.join(tmp, 'fib_trie'), os.path.join(tmp, 'if_inet6')
            Path(fib).write_text(FIB_TRIE, encoding='ascii')
            Path(inet6).write_text(IF_INET6, encoding='ascii')
            with mock.patch.object(serve, '_PROC_FIB_TRIE', fib), mock.patch.object(serve, '_PROC_IF_INET6', inet6), \
                    mock.patch.object(serve, '_egress_addresses', lambda: {'192.168.1.20', '2001:4860:4860::8888'}):
                own = serve._own_addresses()
            # Solo las de internet: loopback, docker, enlace local y LAN ya se rechazan solas.
            self.assertEqual(own, frozenset(ipaddress.ip_address(a) for a in
                                            ('93.184.215.20', '2a00:0:0:abcd::20', '2001:4860:4860::8888')))
            with mock.patch.object(serve, '_PROC_FIB_TRIE', os.path.join(tmp, 'no-existe')), \
                    mock.patch.object(serve, '_PROC_IF_INET6', os.path.join(tmp, 'no-existe')), \
                    mock.patch.object(serve, '_egress_addresses', lambda: {'93.184.215.21'}):
                self.assertEqual(serve._own_addresses(), frozenset({ipaddress.ip_address('93.184.215.21')}),
                                 'sin /proc (fuera de Linux) queda la dirección de salida')

    def test_own_addresses_are_refused_by_ip_is_public(self):
        own = frozenset({ipaddress.ip_address('93.184.215.20')})
        with mock.patch.object(serve, '_self_addresses', lambda: own):
            self.assertFalse(serve._ip_is_public(ipaddress.ip_address('93.184.215.20')))
            self.assertTrue(serve._ip_is_public(ipaddress.ip_address('93.184.215.21')))

    def test_own_addresses_are_enumerated_again_after_a_while(self):
        answers = iter([frozenset({ipaddress.ip_address('93.184.215.20')}),
                        frozenset({ipaddress.ip_address('93.184.215.21')})])
        calls = []

        def enumerate_once():
            calls.append(1)
            return next(answers)
        # REAL_SELF_ADDRESSES: el de verdad, no el sustituto del setUp.
        with mock.patch.object(serve, '_own_addresses', enumerate_once), \
                mock.patch.dict(serve._self_cache, {'at': None, 'addrs': frozenset()}):
            with mock.patch.object(serve, 'PROXY_SELF_REFRESH_S', 3600):
                first = REAL_SELF_ADDRESSES()
                self.assertEqual(REAL_SELF_ADDRESSES(), first)
                self.assertEqual(len(calls), 1, 'cada petición no vuelve a enumerar')
            with mock.patch.object(serve, 'PROXY_SELF_REFRESH_S', 0):
                self.assertEqual(REAL_SELF_ADDRESSES(), frozenset({ipaddress.ip_address('93.184.215.21')}))
            self.assertEqual(len(calls), 2)

    def test_dial_order_alternates_families_and_has_a_cap(self):
        v6 = [(socket.AF_INET6, (ip, 80, 0, 0)) for ip in DUAL_V6]
        v4 = [(socket.AF_INET, (ip, 80)) for ip in (PUBLIC_V4, PUBLIC_V4_B)]
        self.assertEqual([a[1][0] for a in serve._dial_order(v6 + v4)],
                         [DUAL_V6[0], PUBLIC_V4, DUAL_V6[1], PUBLIC_V4_B, DUAL_V6[2], DUAL_V6[3]])
        self.assertEqual([a[1][0] for a in serve._dial_order(v4 + v6)][:3], [PUBLIC_V4, DUAL_V6[0], PUBLIC_V4_B])
        many = [(socket.AF_INET, (ip, 80)) for ip in MANY_V4]
        self.assertEqual(len(serve._dial_order(many)), serve.PROXY_MAX_ADDRS)
        self.assertEqual(serve._dial_order([]), [])

    def test_public_addresses_pass(self):
        for ip in ('8.8.8.8', '1.1.1.1', PUBLIC_V4, PUBLIC_V6, '2001:4860:4860::8888', '2a00:1450:4001:80b::200e'):
            with self.subTest(ip=ip):
                self.assertTrue(serve._ip_is_public(ipaddress.ip_address(ip)))

    def test_block_lists_alone_refuse_every_special_range(self):
        # Las banderas de ipaddress cambian entre versiones de Python: las
        # listas propias tienen que bastar por sí solas.
        for ip in NON_PUBLIC_V4 + NON_PUBLIC_V6:
            with self.subTest(ip=ip):
                self.assertTrue(serve._in_block_lists(ipaddress.ip_address(ip)))
        for ip in ('8.8.8.8', PUBLIC_V4, PUBLIC_V6, '2001:4860:4860::8888'):
            self.assertFalse(serve._in_block_lists(ipaddress.ip_address(ip)))

    def test_a_gzip_bomb_never_expands_past_the_ceiling(self):
        packer = zlib.compressobj(9, zlib.DEFLATED, 16 + zlib.MAX_WBITS)
        zeros = b'\0' * (1 << 20)
        bomb = b''.join(packer.compress(zeros) for _ in range(64)) + packer.flush()   # 64 MB al descomprimir
        tracemalloc.start()
        try:
            body, truncated = serve._inflate(bomb, 'gzip', 1000)
            peak = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
        self.assertEqual((len(body), truncated), (1000, True))
        self.assertLess(peak, 8 << 20, 'descomprimió la bomba entera en memoria')

    def test_forwarded_for_is_trusted_only_from_loopback(self):
        def ip(peer, xff=None):
            fake = types.SimpleNamespace(client_address=(peer, 40000),
                                         headers={'X-Forwarded-For': xff} if xff is not None else {})
            return serve.Handler.client_ip(fake)
        self.assertEqual(ip('127.0.0.1', '203.0.113.5, 192.0.2.9'), '192.0.2.9')
        self.assertEqual(ip('::1', '192.0.2.9'), '192.0.2.9')
        self.assertEqual(ip('::ffff:127.0.0.1', '192.0.2.9'), '192.0.2.9')
        self.assertEqual(ip('198.51.100.20', '192.0.2.9'), '198.51.100.20')
        self.assertEqual(ip('127.0.0.1'), '127.0.0.1')

    def test_ipv6_clients_are_limited_per_64(self):
        self.assertEqual(serve._rate_key('2001:db8:1:2:3:4:5:6'), serve._rate_key('2001:db8:1:2:ffff::1'))
        self.assertNotEqual(serve._rate_key('2001:db8:1:2::1'), serve._rate_key('2001:db8:1:3::1'))
        self.assertEqual(serve._rate_key('::ffff:192.0.2.1'), '192.0.2.1')

    def test_real_tls_context_verifies_certificates_and_names(self):
        ctx = serve._tls_context()
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(ctx.check_hostname)

    def test_listens_on_loopback_unless_told_otherwise(self):
        seen = []

        class FakeServer:
            allow_reuse_address = False

            def __init__(self, address, handler):
                seen.append(address)

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def serve_forever(self):
                pass
        env = {k: v for k, v in os.environ.items() if k != 'ELFFUSS_BIND'}
        with mock.patch.object(serve.socketserver, 'ThreadingTCPServer', FakeServer), \
                mock.patch.dict(os.environ, env, clear=True), mock.patch('builtins.print') as printed:
            serve.main(['serve.py', '8642'])
            os.environ['ELFFUSS_BIND'] = '0.0.0.0'
            serve.main(['serve.py', '8650'])
        self.assertEqual(seen, [('127.0.0.1', 8642), ('0.0.0.0', 8650)])
        said = ' '.join(str(c.args[0]) for c in printed.call_args_list)
        self.assertIn('/proxy rechaza 0 dirección(es) pública(s) de esta máquina', said,
                      'al arrancar dice cuántas direcciones propias rechaza (nunca cuáles)')


if __name__ == '__main__':
    unittest.main()
