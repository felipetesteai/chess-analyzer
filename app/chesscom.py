"""Cliente da Published-Data API publica do chess.com.

Baseado no fetch_games.py da skill hhkarimi/claude-chess-skills: le apenas os
arquivos publicos de partidas, sem login e sem token.
"""

from __future__ import annotations

import io
import re
from datetime import datetime, timezone

import chess.pgn
import requests

API = "https://api.chess.com/pub"
HEADERS = {"User-Agent": "chess-analyzer/0.1 (local desktop app)"}
TIMEOUT = 30


class ChessComError(RuntimeError):
    pass


def _get(url: str) -> dict:
    resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    if resp.status_code == 404:
        raise ChessComError(
            "Perfil nao encontrado no chess.com. Confira o nome de usuario exato."
        )
    if resp.status_code == 403:
        raise ChessComError("O chess.com bloqueou a requisicao (403). Tente de novo em alguns minutos.")
    resp.raise_for_status()
    return resp.json()


def profile(username: str) -> dict:
    return _get(f"{API}/player/{username.lower()}")


def _archives(username: str) -> list[str]:
    data = _get(f"{API}/player/{username.lower()}/games/archives")
    return data.get("archives", [])


def _headers_of(pgn: str) -> dict:
    return dict(re.findall(r'\[(\w+)\s+"([^"]*)"\]', pgn or ""))


def _result_for(game: dict, color: str) -> str:
    side = game.get(color, {})
    res = side.get("result", "")
    if res == "win":
        return "win"
    if res in ("agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"):
        return "draw"
    return "loss"


def list_games(username: str, count: int = 30) -> list[dict]:
    """Devolve as `count` partidas mais recentes, da mais nova para a mais antiga."""
    user = username.lower()
    archives = _archives(user)
    if not archives:
        raise ChessComError("Esse perfil nao tem partidas publicas.")

    out: list[dict] = []
    for url in reversed(archives):
        payload = _get(url)
        for game in reversed(payload.get("games", [])):
            pgn = game.get("pgn")
            if not pgn:
                continue
            white = (game.get("white", {}).get("username") or "").lower()
            black = (game.get("black", {}).get("username") or "").lower()
            if user == white:
                color = "white"
            elif user == black:
                color = "black"
            else:
                continue

            hdr = _headers_of(pgn)
            accuracies = game.get("accuracies") or {}
            end_ts = game.get("end_time")
            out.append(
                {
                    "id": str(game.get("uuid") or game.get("url", "")),
                    "url": game.get("url"),
                    "pgn": pgn,
                    "color": color,
                    "opponent": (black if color == "white" else white),
                    "opponent_rating": (
                        game.get("black", {}) if color == "white" else game.get("white", {})
                    ).get("rating"),
                    "my_rating": (
                        game.get("white", {}) if color == "white" else game.get("black", {})
                    ).get("rating"),
                    "result": _result_for(game, color),
                    "termination": hdr.get("Termination", ""),
                    "time_class": game.get("time_class"),
                    "time_control": game.get("time_control"),
                    "rated": game.get("rated", True),
                    "opening": opening_name(hdr),
                    "chesscom_accuracy": accuracies.get(color),
                    "played_at": (
                        datetime.fromtimestamp(end_ts, tz=timezone.utc).isoformat()
                        if end_ts
                        else hdr.get("UTCDate", "")
                    ),
                }
            )
            if len(out) >= count:
                return out
    return out


def opening_name(headers: dict) -> str:
    """Extrai o nome da abertura do PGN do chess.com (vem na tag ECOUrl).

    O slug do chess.com costuma emendar a linha de lances no nome
    ("Pirc-Defense-Classical-Variation-4...Bg7-5.Bc4"); corta ali.
    """
    eco_url = headers.get("ECOUrl", "")
    if eco_url:
        slug = eco_url.rstrip("/").rsplit("/", 1)[-1]
        name = slug.replace("-", " ")
        cut = re.search(r"\s\d+\s*\.", name)
        if cut:
            name = name[: cut.start()]
        return name.strip()
    return headers.get("Opening", "") or headers.get("ECO", "")


def parse_pgn(pgn: str) -> chess.pgn.Game:
    game = chess.pgn.read_game(io.StringIO(pgn))
    if game is None:
        raise ChessComError("Nao consegui ler o PGN dessa partida.")
    return game


def clock_seconds(comment: str) -> float | None:
    """Le o relogio restante do comentario `[%clk 0:03:12.5]` do chess.com."""
    m = re.search(r"\[%clk\s+(\d+):(\d+):([\d.]+)\]", comment or "")
    if not m:
        return None
    h, mi, s = m.groups()
    return int(h) * 3600 + int(mi) * 60 + float(s)
