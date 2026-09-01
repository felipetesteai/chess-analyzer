"""Descoberta e operacao do Stockfish via UCI.

Baseado no wrapper UCI da skill robominds/stockfish-skill, adaptado para Windows
e para o modulo `chess.engine` do python-chess (que ja fala UCI corretamente).
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import chess
import chess.engine

ROOT = Path(__file__).resolve().parent.parent
ENGINE_DIR = ROOT / "engine"


def find_stockfish() -> str:
    """Localiza o binario do Stockfish.

    Ordem: STOCKFISH_PATH -> binario embarcado em ./engine -> PATH do sistema.
    """
    env = os.environ.get("STOCKFISH_PATH", "").strip('"')
    if env and Path(env).is_file():
        return env

    if ENGINE_DIR.is_dir():
        candidates = sorted(ENGINE_DIR.rglob("stockfish*.exe")) or sorted(
            p for p in ENGINE_DIR.rglob("stockfish*") if p.is_file()
        )
        if candidates:
            return str(candidates[0])

    found = shutil.which("stockfish")
    if found:
        return found

    raise RuntimeError(
        "Stockfish nao encontrado. Baixe em https://stockfishchess.org/download/ "
        "e coloque o executavel em ./engine, ou defina STOCKFISH_PATH."
    )


def open_engine(threads: int | None = None, hash_mb: int = 128) -> chess.engine.SimpleEngine:
    """Abre o Stockfish com opcoes adequadas a uma maquina modesta."""
    binary = find_stockfish()
    kwargs = {}
    if os.name == "nt":
        # Evita piscar uma janela de console a cada partida analisada.
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        kwargs["startupinfo"] = si

    engine = chess.engine.SimpleEngine.popen_uci(binary, **kwargs)
    if threads is None:
        threads = max(1, (os.cpu_count() or 2) - 1)
    try:
        engine.configure({"Threads": threads, "Hash": hash_mb})
    except chess.engine.EngineError:
        pass
    return engine


def engine_name() -> str:
    try:
        eng = open_engine(threads=1, hash_mb=16)
    except Exception as exc:  # pragma: no cover - caminho de diagnostico
        return f"indisponivel ({exc})"
    try:
        return eng.id.get("name", "Stockfish")
    finally:
        eng.quit()


if __name__ == "__main__":
    print("binario:", find_stockfish())
    print("engine :", engine_name())
    print("cpus   :", os.cpu_count())
