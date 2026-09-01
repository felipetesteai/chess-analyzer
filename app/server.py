"""Servidor local do Chess Analyzer.

Serve a interface e expoe a API que busca partidas no chess.com e roda a
analise do Stockfish, transmitindo o progresso por Server-Sent Events.
"""

from __future__ import annotations

import hashlib
import json
import queue
import re
import threading
import traceback
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

from . import aggregate, chesscom, review
from .engine import engine_name, find_stockfish, open_engine

ROOT = Path(__file__).resolve().parent.parent
STATIC = Path(__file__).resolve().parent / "static"
CACHE = ROOT / "data" / "reviews"
CACHE.mkdir(parents=True, exist_ok=True)

# Sobe junto quando o formato do JSON da revisao muda, para invalidar o cache
# antigo em vez de servir dados sem os campos novos.
SCHEMA = 3

app = Flask(__name__, static_folder=None)

# Jobs de analise em andamento: id -> fila de eventos.
_jobs: dict[str, queue.Queue] = {}
_cancels: dict[str, threading.Event] = {}
_jobs_lock = threading.Lock()

USERNAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


# ---------------------------------------------------------------------------
# Interface estatica
# ---------------------------------------------------------------------------

@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.get("/<path:filename>")
def static_files(filename: str):
    return send_from_directory(STATIC, filename)


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

@app.get("/api/ping")
def ping():
    """Checagem barata usada na inicializacao: nao toca no engine."""
    return jsonify({"ok": True})


_engine_info: dict | None = None


@app.get("/api/health")
def health():
    """Identifica o engine uma unica vez - abrir o Stockfish leva ~1s."""
    global _engine_info
    if _engine_info is None:
        try:
            _engine_info = {"ok": True, "engine": engine_name(), "path": find_stockfish()}
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 500
    return jsonify(_engine_info)


@app.get("/api/games")
def games():
    username = (request.args.get("username") or "").strip()
    if not USERNAME_RE.match(username):
        return jsonify({"error": "Nome de usuario invalido."}), 400
    count = min(100, max(1, int(request.args.get("count", 30))))
    try:
        found = chesscom.list_games(username, count)
    except chesscom.ChessComError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        return jsonify({"error": f"Falha ao falar com o chess.com: {exc}"}), 502

    profile_data = {}
    try:
        prof = chesscom.profile(username)
        profile_data = {"avatar": prof.get("avatar"), "url": prof.get("url")}
    except Exception:
        pass

    # O PGN completo so viaja quando a partida for analisada.
    slim = [{k: v for k, v in g.items() if k != "pgn"} for g in found]
    with _pgn_lock:
        for g in found:
            _pgn_store[g["id"]] = g["pgn"]
    return jsonify({"username": username, "profile": profile_data, "games": slim})


_pgn_store: dict[str, str] = {}
_pgn_lock = threading.Lock()


def _cache_path(game_id: str, depth: int) -> Path:
    key = hashlib.sha1(f"v{SCHEMA}:{game_id}:{depth}".encode()).hexdigest()[:16]
    return CACHE / f"{key}.json"


def _new_job() -> tuple[str, queue.Queue, threading.Event]:
    job_id = hashlib.sha1(f"{id(object())}".encode()).hexdigest()[:12]
    events: queue.Queue = queue.Queue()
    cancel = threading.Event()
    with _jobs_lock:
        _jobs[job_id] = events
        _cancels[job_id] = cancel
    return job_id, events, cancel


@app.post("/api/analyze")
def analyze():
    body = request.get_json(force=True) or {}
    game_id = str(body.get("game_id") or "")
    try:
        depth = min(20, max(8, int(body.get("depth") or 14)))
    except (TypeError, ValueError):
        depth = 14
    color = body.get("color") or "white"
    pgn = body.get("pgn")

    if not pgn:
        with _pgn_lock:
            pgn = _pgn_store.get(game_id)
    if not pgn:
        return jsonify({"error": "PGN da partida nao encontrado. Recarregue a lista."}), 400

    cached = _cache_path(game_id, depth)
    if cached.exists() and not body.get("force"):
        return jsonify({"cached": True, "review": json.loads(cached.read_text("utf-8"))})

    job_id, events, _cancel = _new_job()

    def worker():
        try:
            for event in review.analyze_game(pgn, color, depth=depth):
                if event["type"] == "done":
                    cached.write_text(
                        json.dumps(event["review"], ensure_ascii=False), encoding="utf-8"
                    )
                events.put(event)
        except Exception as exc:
            traceback.print_exc()
            events.put({"type": "error", "message": str(exc)})
        finally:
            events.put(None)

    threading.Thread(target=worker, daemon=True).start()
    return jsonify({"cached": False, "job_id": job_id})


@app.get("/api/analyze/<job_id>/stream")
def analyze_stream(job_id: str):
    with _jobs_lock:
        events = _jobs.get(job_id)
    if events is None:
        return jsonify({"error": "Analise nao encontrada."}), 404

    def stream():
        while True:
            event = events.get()
            if event is None:
                break
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        with _jobs_lock:
            _jobs.pop(job_id, None)
            _cancels.pop(job_id, None)

    return Response(
        stream(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Analise em lote
# ---------------------------------------------------------------------------

@app.post("/api/batch")
def batch():
    """Analisa varias partidas de uma vez e devolve o agregado de erros.

    Recebe a lista de partidas ja carregada na interface (com os metadados de
    cor, resultado, abertura e time control) - o PGN sai do store em memoria.
    """
    body = request.get_json(force=True) or {}
    games = body.get("games") or []
    username = (body.get("username") or "").strip()
    try:
        depth = min(20, max(8, int(body.get("depth") or 12)))
    except (TypeError, ValueError):
        depth = 12

    if not games:
        return jsonify({"error": "Nenhuma partida selecionada."}), 400

    pending = []
    with _pgn_lock:
        for game in games:
            pgn = _pgn_store.get(str(game.get("id")))
            if pgn:
                pending.append((game, pgn))
    if not pending:
        return jsonify({"error": "PGNs nao encontrados. Recarregue a lista de partidas."}), 400

    job_id, events, cancel = _new_job()

    def worker():
        engine = None
        entries = []
        try:
            for index, (game, pgn) in enumerate(pending):
                if cancel.is_set():
                    break

                cached = _cache_path(str(game.get("id")), depth)
                if cached.exists():
                    entries.append(
                        {"game": game, "review": json.loads(cached.read_text("utf-8"))}
                    )
                    events.put(
                        {
                            "type": "progress",
                            "game": index + 1,
                            "games": len(pending),
                            "done": 1,
                            "total": 1,
                            "cached": True,
                            "opponent": game.get("opponent"),
                        }
                    )
                    continue

                # Um unico processo do Stockfish para o lote inteiro: abrir o
                # engine por partida custa ~1s cada.
                if engine is None:
                    engine = open_engine()

                color = game.get("color") or "white"
                for event in review.analyze_game(pgn, color, depth=depth, engine=engine):
                    if cancel.is_set():
                        break
                    if event["type"] == "done":
                        cached.write_text(
                            json.dumps(event["review"], ensure_ascii=False), encoding="utf-8"
                        )
                        entries.append({"game": game, "review": event["review"]})
                    elif event["type"] == "progress":
                        events.put(
                            {
                                "type": "progress",
                                "game": index + 1,
                                "games": len(pending),
                                "done": event["done"],
                                "total": event["total"],
                                "cached": False,
                                "opponent": game.get("opponent"),
                            }
                        )
                    elif event["type"] == "error":
                        events.put(event)

            if not entries:
                events.put({"type": "error", "message": "Nenhuma partida foi analisada."})
            else:
                events.put(
                    {
                        "type": "done",
                        "canceled": cancel.is_set(),
                        "aggregate": aggregate.build(entries, username, depth),
                    }
                )
        except Exception as exc:
            traceback.print_exc()
            events.put({"type": "error", "message": str(exc)})
        finally:
            if engine is not None:
                engine.quit()
            events.put(None)

    threading.Thread(target=worker, daemon=True).start()
    return jsonify({"job_id": job_id, "games": len(pending), "depth": depth})


@app.post("/api/job/<job_id>/cancel")
def cancel_job(job_id: str):
    with _jobs_lock:
        cancel = _cancels.get(job_id)
    if cancel is None:
        return jsonify({"error": "Job nao encontrado."}), 404
    cancel.set()
    return jsonify({"ok": True})


@app.post("/api/pgn")
def analyze_pgn():
    """Permite colar um PGN avulso, sem passar pela lista do chess.com."""
    body = request.get_json(force=True) or {}
    pgn = (body.get("pgn") or "").strip()
    if not pgn:
        return jsonify({"error": "Cole um PGN."}), 400
    try:
        game = chesscom.parse_pgn(pgn)
    except Exception as exc:
        return jsonify({"error": f"PGN invalido: {exc}"}), 400

    game_id = "pgn-" + hashlib.sha1(pgn.encode()).hexdigest()[:16]
    with _pgn_lock:
        _pgn_store[game_id] = pgn
    headers = game.headers
    return jsonify(
        {
            "game": {
                "id": game_id,
                "url": None,
                "color": "white",
                "opponent": headers.get("Black", "?"),
                "result": "unknown",
                "opening": chesscom.opening_name(dict(headers)),
                "time_class": headers.get("TimeControl", ""),
                "played_at": headers.get("UTCDate", ""),
            }
        }
    )


def run(host: str = "127.0.0.1", port: int = 8765, debug: bool = False):
    app.run(host=host, port=port, debug=debug, threaded=True, use_reloader=False)
