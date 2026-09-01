"""Revisao de partida: avalia cada lance com Stockfish e classifica no estilo
do "Game Review" do chess.com.

A base de calculo (perda por lance a partir da avaliacao antes/depois, deteccao
de fase, livro de aberturas em EPD) vem da skill hhkarimi/claude-chess-skills;
a camada de win%, precisao e rotulos (Brilhante, Otimo, Melhor, ...) segue as
formulas publicas usadas por lichess/chess.com.
"""

from __future__ import annotations

import math
from pathlib import Path

import chess
import chess.engine
import chess.pgn

from . import chesscom

ASSETS = Path(__file__).resolve().parent / "assets"

# Avaliacao maxima considerada: acima disso a partida ja esta decidida e a
# diferenca nao deve poluir as medias.
EVAL_CAP = 1000
MATE_SCORE = 10000

PIECE_VALUE = {
    chess.PAWN: 1,
    chess.KNIGHT: 3,
    chess.BISHOP: 3,
    chess.ROOK: 5,
    chess.QUEEN: 9,
    chess.KING: 0,
}

# Perda de win% (0-100) que define cada rotulo.
THRESHOLDS = [
    (2.0, "excellent"),
    (5.0, "good"),
    (10.0, "inaccuracy"),
    (20.0, "mistake"),
]

LABELS_PT = {
    "brilliant": "Brilhante",
    "great": "Otimo",
    "best": "Melhor",
    "excellent": "Excelente",
    "good": "Bom",
    "book": "Livro",
    "inaccuracy": "Impreciso",
    "mistake": "Erro",
    "miss": "Chance perdida",
    "blunder": "Erro grave",
}


# ---------------------------------------------------------------------------
# Conversoes de avaliacao
# ---------------------------------------------------------------------------

def cp_white(score: chess.engine.PovScore) -> int:
    """Avaliacao em centipeoes do ponto de vista das brancas, com teto."""
    wcp = score.white().score(mate_score=MATE_SCORE)
    if wcp is None:
        return 0
    return max(-EVAL_CAP, min(EVAL_CAP, wcp))


def win_pct(cp: int) -> float:
    """Chance de vitoria (0-100) das brancas para uma avaliacao em centipeoes."""
    cp = max(-EVAL_CAP, min(EVAL_CAP, cp))
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def win_pct_for(cp_w: int, white_to_move: bool) -> float:
    """Chance de vitoria do lado que esta jogando."""
    w = win_pct(cp_w)
    return w if white_to_move else 100 - w


def move_accuracy(win_before: float, win_after: float) -> float:
    """Precisao (0-100) de um lance, pela curva usada no lichess."""
    delta = max(0.0, win_before - win_after)
    acc = 103.1668 * math.exp(-0.04354 * delta) - 3.1669
    return max(0.0, min(100.0, acc))


def game_accuracy(accuracies: list[float], win_series: list[float]) -> float | None:
    """Media ponderada por volatilidade + media harmonica (metodo do lichess)."""
    if not accuracies:
        return None
    window = max(2, min(8, len(win_series) // 10))
    weights = []
    for i in range(len(accuracies)):
        lo = max(0, i - window)
        hi = min(len(win_series), i + window + 1)
        chunk = win_series[lo:hi] or [50.0]
        mean = sum(chunk) / len(chunk)
        var = sum((x - mean) ** 2 for x in chunk) / len(chunk)
        weights.append(max(0.5, min(12.0, math.sqrt(var))))

    total_w = sum(weights) or 1.0
    weighted = sum(a * w for a, w in zip(accuracies, weights)) / total_w
    harmonic = len(accuracies) / sum(1 / max(a, 1e-6) for a in accuracies)
    return round(max(0.0, min(100.0, (weighted + harmonic) / 2)), 1)


# ---------------------------------------------------------------------------
# Heuristicas de posicao
# ---------------------------------------------------------------------------

def load_book() -> set:
    path = ASSETS / "openings_book.txt"
    if not path.exists():
        return set()
    return {
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    }


def phase_of(board: chess.Board) -> str:
    """Abertura / meio-jogo / final por material sem peoes e sem reis."""
    material = sum(
        PIECE_VALUE[p.piece_type]
        for p in board.piece_map().values()
        if p.piece_type not in (chess.PAWN, chess.KING)
    )
    if board.fullmove_number <= 12 and material >= 26:
        return "opening"
    if material <= 12:
        return "endgame"
    return "middlegame"


def material_balance(board: chess.Board, color: chess.Color) -> int:
    mine = sum(
        PIECE_VALUE[p.piece_type] for p in board.piece_map().values() if p.color == color
    )
    theirs = sum(
        PIECE_VALUE[p.piece_type] for p in board.piece_map().values() if p.color != color
    )
    return mine - theirs


def _is_sacrifice(board_before: chess.Board, move: chess.Move, pv: list) -> bool:
    """Sacrificio: depois do lance e das melhores respostas, quem jogou fica com
    pelo menos um leve a menos de material."""
    mover = board_before.turn
    before = material_balance(board_before, mover)

    probe = board_before.copy(stack=False)
    probe.push(move)
    plies = 0
    for pv_move in pv:
        if plies >= 3 or pv_move not in probe.legal_moves:
            break
        probe.push(pv_move)
        plies += 1
    return material_balance(probe, mover) - before <= -2


# ---------------------------------------------------------------------------
# Classificacao de lances
# ---------------------------------------------------------------------------

def classify(
    *,
    board_before: chess.Board,
    move: chess.Move,
    best_move,
    win_before: float,
    win_after: float,
    second_best_win,
    in_book: bool,
    mate_before,
    mate_after,
    pv_after: list,
) -> str:
    loss = max(0.0, win_before - win_after)
    is_best = best_move is not None and move == best_move

    if in_book:
        return "book"

    if is_best and loss <= 2.0:
        if win_after >= 45 and _is_sacrifice(board_before, move, pv_after):
            return "brilliant"
        # Unico lance que segura a posicao: a segunda opcao e muito pior, e a
        # partida ainda estava em aberto (nao vale em posicao ja decidida).
        if (
            second_best_win is not None
            and (win_after - second_best_win) >= 20
            and 15 <= win_after <= 92
        ):
            return "great"
        return "best"

    # Tinha mate forcado e deixou escapar.
    if mate_before is not None and mate_before > 0 and mate_after is None and loss >= 5:
        return "miss"

    for limit, label in THRESHOLDS:
        if loss < limit:
            return label
    return "blunder"


# ---------------------------------------------------------------------------
# Analise da partida
# ---------------------------------------------------------------------------

def analyze_game(pgn: str, my_color: str, depth: int = 14, engine=None):
    """Gera eventos de progresso e, no fim, a revisao completa.

    Cada yield e um dict: {"type": "progress"|"done"|"error", ...}
    """
    from .engine import open_engine

    game = chesscom.parse_pgn(pgn)
    book = load_book()

    nodes = list(game.mainline())
    total = len(nodes)
    if total == 0:
        yield {"type": "error", "message": "Partida sem lances."}
        return

    own_engine = engine is None
    engine = engine or open_engine()
    limit = chess.engine.Limit(depth=depth)

    try:
        board = game.board()
        evals = []  # avaliacao de cada posicao, incluindo a inicial

        def evaluate(b: chess.Board) -> dict:
            if b.is_game_over(claim_draw=True):
                outcome = b.outcome(claim_draw=True)
                if outcome and outcome.winner is not None:
                    cp = EVAL_CAP if outcome.winner == chess.WHITE else -EVAL_CAP
                else:
                    cp = 0
                return {"cp_white": cp, "best": None, "second_win": None, "pv": [], "mate": None}

            infos = engine.analyse(b, limit, multipv=2)
            first = infos[0]
            cp_w = cp_white(first["score"])
            pv = list(first.get("pv", []))
            best = pv[0] if pv else None
            mate = first["score"].pov(b.turn).mate()

            second_win = None
            if len(infos) > 1:
                second_win = win_pct_for(cp_white(infos[1]["score"]), b.turn)

            return {
                "cp_white": cp_w,
                "best": best,
                "second_win": second_win,
                "pv": pv,
                "mate": mate,
            }

        evals.append(evaluate(board))
        yield {"type": "progress", "done": 0, "total": total}

        moves = []
        for idx, node in enumerate(nodes):
            move = node.move
            board_before = board.copy(stack=False)
            san = board_before.san(move)
            board.push(move)

            after = evaluate(board)
            evals.append(after)

            before = evals[idx]
            mover_is_white = board_before.turn == chess.WHITE
            wb = win_pct_for(before["cp_white"], mover_is_white)
            wa = win_pct_for(after["cp_white"], mover_is_white)

            in_book = idx < 24 and board.epd() in book
            mate_after_mover = -after["mate"] if after["mate"] is not None else None
            label = classify(
                board_before=board_before,
                move=move,
                best_move=before["best"],
                win_before=wb,
                win_after=wa,
                second_best_win=before["second_win"],
                in_book=in_book,
                mate_before=before["mate"],
                mate_after=mate_after_mover,
                pv_after=after["pv"],
            )

            # Como o adversario pune o lance: a linha principal a partir da
            # posicao resultante. Alimenta a deteccao de padroes de erro.
            # 6 meios-lances: com 4 o material perdido em sequencias um pouco
            # mais longas passava batido e caia no balde generico.
            punish_line = []
            probe = board.copy(stack=False)
            for pv_move in after["pv"][:6]:
                if pv_move not in probe.legal_moves:
                    break
                punish_line.append(probe.san(pv_move))
                probe.push(pv_move)
            material_swing = material_balance(probe, board_before.turn) - material_balance(
                board_before, board_before.turn
            )
            punish_is_check = bool(after["pv"]) and board.gives_check(after["pv"][0])
            punish_is_capture = bool(after["pv"]) and board.is_capture(after["pv"][0])

            best_san = None
            best_line = []
            if before["best"] is not None and before["best"] != move:
                best_san = board_before.san(before["best"])
                probe = board_before.copy(stack=False)
                for pv_move in before["pv"][:6]:
                    if pv_move not in probe.legal_moves:
                        break
                    best_line.append(probe.san(pv_move))
                    probe.push(pv_move)

            moves.append(
                {
                    "ply": idx + 1,
                    "move_no": board_before.fullmove_number,
                    "side": "white" if mover_is_white else "black",
                    "san": san,
                    "uci": move.uci(),
                    "from": chess.square_name(move.from_square),
                    "to": chess.square_name(move.to_square),
                    "fen_before": board_before.fen(),
                    "fen_after": board.fen(),
                    "eval_before": before["cp_white"],
                    "eval_after": after["cp_white"],
                    "mate_after": mate_after_mover,
                    "win_before": round(wb, 1),
                    "win_after": round(wa, 1),
                    "cpl": round(max(0.0, wb - wa) * 10),
                    "accuracy": round(move_accuracy(wb, wa), 1),
                    "class": label,
                    "label": LABELS_PT[label],
                    "best_move": best_san,
                    "best_uci": before["best"].uci() if before["best"] else None,
                    "best_line": best_line,
                    "punish_line": punish_line,
                    "punish_is_check": punish_is_check,
                    "punish_is_capture": punish_is_capture,
                    "material_swing": material_swing,
                    "phase": phase_of(board_before),
                    "clock": chesscom.clock_seconds(node.comment),
                    "is_capture": board_before.is_capture(move),
                    "is_check": board.is_check(),
                }
            )

            yield {"type": "progress", "done": idx + 1, "total": total}

        yield {"type": "done", "review": summarize(game, moves, my_color, depth)}
    finally:
        if own_engine:
            engine.quit()


def summarize(game: chess.pgn.Game, moves: list, my_color: str, depth: int) -> dict:
    """Monta os agregados que a tela de revisao consome."""
    per_side = {}
    for side in ("white", "black"):
        side_moves = [m for m in moves if m["side"] == side]
        counts = {k: 0 for k in LABELS_PT}
        for m in side_moves:
            counts[m["class"]] += 1

        wins = [
            m["win_before"] if m["side"] == side else 100 - m["win_before"] for m in moves
        ]
        per_side[side] = {
            "counts": counts,
            "accuracy": game_accuracy([m["accuracy"] for m in side_moves], wins),
            "avg_cpl": (
                round(sum(m["cpl"] for m in side_moves) / len(side_moves))
                if side_moves
                else None
            ),
            "avg_cpl_by_phase": _avg_by_phase(side_moves),
        }

    key_moments = sorted(
        (m for m in moves if m["class"] in ("blunder", "mistake", "miss")),
        key=lambda m: m["win_before"] - m["win_after"],
        reverse=True,
    )[:6]

    headers = game.headers
    return {
        "white": headers.get("White", "Brancas"),
        "black": headers.get("Black", "Pretas"),
        "white_elo": headers.get("WhiteElo"),
        "black_elo": headers.get("BlackElo"),
        "result": headers.get("Result", "*"),
        "opening": chesscom.opening_name(dict(headers)),
        "date": headers.get("UTCDate") or headers.get("Date", ""),
        "my_color": my_color,
        "depth": depth,
        "moves": moves,
        "summary": per_side,
        "key_moments": key_moments,
        "eval_series": [
            {"ply": 0, "eval": moves[0]["eval_before"] if moves else 0},
            *[{"ply": m["ply"], "eval": m["eval_after"]} for m in moves],
        ],
    }


def _avg_by_phase(side_moves: list) -> dict:
    out = {}
    for phase in ("opening", "middlegame", "endgame"):
        vals = [m["cpl"] for m in side_moves if m["phase"] == phase]
        if vals:
            out[phase] = round(sum(vals) / len(vals))
    return out
