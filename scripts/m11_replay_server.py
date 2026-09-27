#!/usr/bin/env python3
"""M1.1-a corpus replay server: the local 412->200 two-stage flow.

Serves a captured corpus site (wrapper + first-stage bundle) as the
stage-1 challenge document. The FIRST document request answers 412
(Ruishu-style pre-challenge status); once the client's requests carry a
cookie the FIRST request did not have (name-agnostic: the challenge
cookie name is site-dynamic), the same URL answers 200 with the stage-2
document — the pre-authorized degraded form (the true second-stage
bundle is not in the corpus; XJ stage-2 blob explicitly unavailable).

Every request is echoed to an NDJSON log (path / status / cookie
header / which cookies are NEW vs the baseline) — that log is the
PRIMARY oracle for the two-stage flow: it is outside the engine and
records the Cookie header the browser actually sent.

Grades (recorded in every run report):
  - stage-1 document body: derived (reconstructed corpus wrapper, not
    the originally captured 412 HTML)
  - 412/200 transition rule: observed (server-side fact)
  - stage-2 document: synthetic (declared)
  - anchor value: observed at L1 (echo log), derived at L2/L3
"""
import argparse
import json
import time
from http.server import SimpleHTTPRequestHandler
import socketserver
import pathlib

STAGE2_HTML = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>m11 stage-2</title></head>
<body><pre id="result"></pre>
<script>
(async () => {
  const out = { stage: 2 };
  out.cookieSeen = document.cookie.length > 0;
  out.result = 'ok';
  document.getElementById('result').textContent = JSON.stringify(out);
})();
</script></body></html>
"""

# The stage-1 (412) body: a DRIVER document that embeds the corpus
# first stage UNMODIFIED as an iframe. The corpus VM blocks its own
# renderer's main thread in the local context (no server challenge
# material), so the browser is launched with --isolate-origins for
# this origin: the iframe spins in an isolated process while the top
# frame stays responsive for the stage transition. Declared grade:
# stage-1 document = driver + corpus first stage (wrapper unmodified).
def stage1_html(iframe_src):
    return ('<!DOCTYPE html><html><head><meta charset="utf-8">'
            '<title>m11 stage-1</title></head>'
            '<body><pre id="result">stage-1</pre>'
            f'<iframe id="vm" src="{iframe_src}" '
            'style="width:400px;height:100px"></iframe>'
            '</body></html>')


class ReplayHandler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _echo(self, status, new_cookies):
        if self.server.echo_log:
            with open(self.server.echo_log, 'a') as f:
                f.write(json.dumps({
                    'ts': time.time(),
                    'path': self.path,
                    'status': status,
                    'cookie_header': self.headers.get('Cookie'),
                    'cookies_new_vs_baseline': sorted(new_cookies),
                }) + '\n')

    def _cookie_names(self):
        header = self.headers.get('Cookie') or ''
        return {p.split('=', 1)[0].strip()
                for p in header.split(';') if p.strip()}

    def _serve_bytes(self, status, body, ctype, extra=None):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?')[0]
        corpus = self.server.corpus_dir

        # ONE server, TWO origins (same port): the corpus origin is the
        # `localhost` HOST (cross-site vs the 127.0.0.1 IP origin, so
        # the corpus iframe is an OOPIF in its own process); the driver
        # origin is the 127.0.0.1 IP host.
        host = (self.headers.get('Host') or '').split(':')[0]
        if host == 'localhost' and path in ('/', '/index.html', '/stage1'):
            self._echo(200, set())
            wrapper = (corpus / f'wrapper-{self.server.site}.html') \
                .read_bytes()
            self._serve_bytes(200, wrapper, 'text/html; charset=utf-8')
            return

        if path == '/set-iframe':
            # driver-only control endpoint: point the stage-1 driver's
            # iframe at the corpus origin (set BEFORE the page loads)
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(self.path).query)
            src = (q.get('src') or [''])[0]
            self.server.iframe_src = src
            body = json.dumps({'ok': True, 'iframe_src': src}).encode()
            self._echo(200, set())
            self._serve_bytes(200, body, 'application/json')
            return

        if path == '/stage1':
            # the corpus wrapper itself — served verbatim (the real
            # first-stage VM), normally fetched by the driver's iframe
            self._echo(200, set())
            wrapper = (corpus / f'wrapper-{self.server.site}.html') \
                .read_bytes()
            self._serve_bytes(200, wrapper, 'text/html; charset=utf-8')
            return

        if self.server.direct_corpus and (
                path == '/' or path == '/index.html' or path == '/stage1'):
            self._echo(200, set())
            wrapper = (corpus / f'wrapper-{self.server.site}.html') \
                .read_bytes()
            self._serve_bytes(200, wrapper, 'text/html; charset=utf-8')
            return

        if path == '/' or path == '/index.html':
            names = self._cookie_names()
            new = names - self.server.baseline_cookies
            if not self.server.baseline_seen and names:
                # first document request already carried cookies: those
                # ARE the baseline (e.g. a retry after VM set cookies)
                self.server.baseline_cookies |= names
                new = set()
            self.server.baseline_seen = True
            if new:
                self.server.stage2_unlocked = True
                self._echo(200, new)
                self._serve_bytes(200, STAGE2_HTML.encode(),
                                  'text/html; charset=utf-8')
            else:
                self._echo(412, set())
                self._serve_bytes(
                    412,
                    stage1_html(
                        self.server.iframe_src or '/stage1').encode(),
                                  'text/html; charset=utf-8')
            return

        bundle = self.server.bundle_name
        if bundle and path == '/' + bundle:
            self._echo(200, set())
            self._serve_bytes(200, (corpus / bundle).read_bytes(),
                              'application/javascript')
            return

        self._echo(404, set())
        self._serve_bytes(404, b'not found\n', 'text/plain')


class ReplayServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--corpus-dir', required=True, type=pathlib.Path)
    ap.add_argument('--site', required=True,
                    choices=['xj1', 'sc', 'jibei'])
    ap.add_argument('--port', type=int, default=0)
    ap.add_argument('--echo-log', required=True, type=pathlib.Path)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--direct-corpus', action='store_true',
                    help='standalone corpus server (B origin): serve the '
                         'wrapper at / unconditionally')
    ap.add_argument('--iframe-src', default=None,
                    help='the stage-1 driver embeds this URL (the corpus '
                         'origin) in its iframe')
    args = ap.parse_args()

    manifest = json.loads(
        (args.corpus_dir / 'corpus-manifest.json').read_text())
    site = next(s for s in manifest if s['name'] == args.site)

    server = ReplayServer((args.host, args.port), ReplayHandler)
    server.corpus_dir = args.corpus_dir
    server.site = args.site
    server.direct_corpus = args.direct_corpus
    server.iframe_src = args.iframe_src
    server.bundle_name = site['js']
    server.echo_log = args.echo_log
    server.baseline_cookies = set()
    server.baseline_seen = False
    server.stage2_unlocked = False
    args.echo_log.parent.mkdir(parents=True, exist_ok=True)
    print(json.dumps({'port': server.server_address[1],
                      'host': args.host,
                      'site': args.site,
                      'bundle': site['js'],
                      'direct_corpus': args.direct_corpus}), flush=True)
    try:
        server.serve_forever()
    finally:
        print(json.dumps({'stage2_unlocked': server.stage2_unlocked}),
              flush=True)


if __name__ == '__main__':
    main()
