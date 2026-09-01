"""Servidor estatico so para testar a versao web localmente.

Manda os mesmos cabecalhos COOP/COEP que o Cloudflare Pages vai mandar (ver
`_headers`), senao o Stockfish multi-thread nao roda em localhost e o teste nao
representa a producao.

    python web/serve.py [porta]

Em producao nao existe servidor nenhum: sao arquivos estaticos.
"""

from __future__ import annotations

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB = Path(__file__).resolve().parent


class Handler(SimpleHTTPRequestHandler):
    # HTTP/1.1 com keep-alive: o Stockfish multi-thread abre varios workers de
    # pthread ao mesmo tempo e, em HTTP/1.0, os pedidos simultaneos do mesmo
    # script morriam com ERR_ABORTED.
    protocol_version = "HTTP/1.1"

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
    }

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        # args[0] nem sempre e string (log_error passa um int), entao converte.
        if args and "GET" in str(args[0]):
            super().log_message(fmt, *args)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    handler = partial(Handler, directory=str(WEB))
    print(f"versao web em http://127.0.0.1:{port}/  (COOP/COEP ligados)")
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
