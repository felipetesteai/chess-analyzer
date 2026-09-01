"""Ponto de entrada do Chess Analyzer.

Sobe o servidor local numa thread e abre a interface numa janela nativa
(pywebview). Se a janela nativa nao estiver disponivel, cai para o navegador
padrao.
"""

from __future__ import annotations

import argparse
import socket
import sys
import threading
import time
import urllib.request

from app import server


def free_port(preferred: int = 8765) -> int:
    for port in range(preferred, preferred + 20):
        with socket.socket() as sock:
            if sock.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return preferred


def wait_until_up(url: str, timeout: float = 20.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(url, timeout=3)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Chess Analyzer - revisao de partidas do chess.com")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--browser", action="store_true", help="abre no navegador padrao")
    parser.add_argument("--no-window", action="store_true", help="so sobe o servidor")
    args = parser.parse_args()

    port = free_port(args.port)
    url = f"http://127.0.0.1:{port}/"

    threading.Thread(
        target=server.run, kwargs={"port": port}, daemon=True
    ).start()

    if not wait_until_up(url + "api/ping"):
        print("O servidor nao subiu a tempo.", file=sys.stderr)
        return 1

    print(f"Chess Analyzer rodando em {url}")

    if args.no_window:
        threading.Event().wait()
        return 0

    if not args.browser:
        try:
            import webview

            webview.create_window(
                "Chess Analyzer", url, width=1400, height=900, min_size=(1024, 700)
            )
            webview.start()
            return 0
        except Exception as exc:
            print(f"Janela nativa indisponivel ({exc}); abrindo no navegador.")

    import webbrowser

    webbrowser.open(url)
    threading.Event().wait()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
