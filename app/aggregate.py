"""Agregacao de varias partidas: acha o padrao de erro mais comum do jogador.

A ideia (e o recorte por fase / apuros de tempo / desempenho por abertura) vem do
`analyze_games.py` da skill hhkarimi/claude-chess-skills. O que e novo aqui e a
classificacao do *tipo* de erro, feita a partir de como o engine pune o lance:
`punish_line`, `material_swing` e `punish_is_check`, calculados em review.py sem
nenhuma chamada extra ao Stockfish.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict

# Lances com esta classificacao contam como erro para o agregado.
ERROR_CLASSES = ("mistake", "miss", "blunder")

PATTERNS = {
    "allowed_mate": {
        "label": "Permitiu mate forçado",
        "hint": "Você entrou numa sequência de mate. Antes de mexer, olhe os xeques "
                "que o adversário tem contra o seu rei.",
    },
    "missed_mate": {
        "label": "Deixou escapar mate forçado",
        "hint": "Você tinha mate na posição e jogou outra coisa. Quando o rei "
                "inimigo estiver preso, procure xeques antes de qualquer outro lance.",
    },
    "tactic_shot": {
        "label": "Levou tática (xeque ou ataque duplo)",
        "hint": "O adversário puniu com xeque e ganhou material na sequência. "
                "Cheque garfos, cravadas e xeques intermediários antes de mexer.",
    },
    "hung_material": {
        "label": "Deixou material pendurado",
        "hint": "Você deixou uma peça sendo atacada sem defesa suficiente. "
                "Depois de escolher o lance, confira o que fica sem proteção.",
    },
    "bad_capture": {
        "label": "Capturou ou trocou mal",
        "hint": "A captura saiu cara — a recaptura do adversário deixou você "
                "com menos material ou pior posição. Conte a sequência inteira antes.",
    },
    # O erro sem perda de material e separado por fase: "erro posicional" solto
    # vira um balde generico que nao diz ao jogador o que estudar.
    "positional_opening": {
        "label": "Erro posicional na abertura",
        "hint": "Sem perder peça, mas saindo pior da abertura — peça mal "
                "desenvolvida, rei sem rocar ou peão solto. Fixe uma resposta "
                "para as aberturas que você mais enfrenta e siga os princípios: "
                "centro, desenvolvimento, roque.",
    },
    "positional_middlegame": {
        "label": "Erro posicional no meio-jogo",
        "hint": "Sem perda de material, mas a posição desandou: peça sem função, "
                "coluna ou casa forte entregue, estrutura de peões piorada. "
                "Antes de mexer, pergunte qual é a sua pior peça.",
    },
    "positional_endgame": {
        "label": "Erro posicional no final",
        "hint": "Final tratado sem plano: rei passivo, peão passado mal "
                "conduzido ou oposição perdida. Finais de rei e peões e de torre "
                "são os que mais aparecem.",
    },
}

PHASES_PT = {"opening": "abertura", "middlegame": "meio-jogo", "endgame": "final"}


def pattern_of(move: dict) -> str:
    """Classifica o tipo de erro a partir de como o engine pune o lance."""
    mate_after = move.get("mate_after")
    if mate_after is not None and mate_after < 0:
        return "allowed_mate"
    if move.get("class") == "miss":
        return "missed_mate"

    swing = move.get("material_swing", 0)
    # Um peao de diferenca so conta como perda de material se o adversario
    # realmente captura na sequencia - senao pega ruido de avaliacao.
    lost_material = swing <= -2 or (swing <= -1 and move.get("punish_is_capture"))
    if lost_material:
        if move.get("punish_is_check"):
            return "tactic_shot"
        if move.get("is_capture"):
            return "bad_capture"
        return "hung_material"
    if move.get("is_capture") and swing <= -1:
        return "bad_capture"
    return "positional_" + move.get("phase", "middlegame")


def is_daily(time_control) -> bool:
    """Partidas por dias vem como "1/259200" (um lance a cada 3 dias)."""
    return bool(re.fullmatch(r"\d+/\d+", str(time_control or "")))


def base_seconds(time_control: str | None) -> int | None:
    """Tempo inicial em segundos a partir do time control do chess.com."""
    if not time_control:
        return None
    tc = str(time_control)
    # "1/259200": o tempo esta DEPOIS da barra. Ler o "1" da frente dava 1 segundo.
    daily = re.fullmatch(r"\d+/(\d+)", tc)
    if daily:
        return int(daily.group(1))
    # "600" ou "600+5" - o incremento nao conta como tempo base.
    m = re.match(r"^(\d+)", tc)
    return int(m.group(1)) if m else None


def in_time_trouble(move: dict, base: int | None, daily: bool = False) -> bool:
    # Em partida por dias nao existe apuro de tempo: sao dias por lance.
    if daily:
        return False
    clock = move.get("clock")
    if clock is None:
        return False
    limit = max(30.0, 0.1 * base) if base else 30.0
    return clock < limit


def build(entries: list[dict], username: str, depth: int) -> dict:
    """Monta o agregado.

    entries: [{"game": <metadados da lista>, "review": <json da revisao>}]
    """
    my_moves: list[dict] = []
    errors: list[dict] = []
    record = Counter()
    accuracies: list[float] = []

    cpl_by_phase = defaultdict(list)
    moves_by_phase = Counter()
    errors_by_phase = Counter()
    class_counts = Counter()
    pattern_counts = Counter()
    pattern_cost = defaultdict(list)
    pattern_examples = defaultdict(list)
    tt_errors = 0
    tt_moves = 0
    openings = defaultdict(lambda: {"games": 0, "win": 0, "loss": 0, "draw": 0, "cpl": [], "errors": 0})

    for entry in entries:
        game = entry["game"]
        review = entry["review"]
        color = game.get("color") or review.get("my_color") or "white"
        base = base_seconds(game.get("time_control"))
        daily = is_daily(game.get("time_control"))

        record[game.get("result", "unknown")] += 1
        acc = (review.get("summary", {}).get(color) or {}).get("accuracy")
        if acc is not None:
            accuracies.append(acc)

        opening = (game.get("opening") or review.get("opening") or "desconhecida").strip()
        bucket = openings[opening]
        bucket["games"] += 1
        if game.get("result") in ("win", "loss", "draw"):
            bucket[game["result"]] += 1

        for m in review.get("moves", []):
            if m.get("side") != color:
                continue
            my_moves.append(m)
            class_counts[m.get("class", "good")] += 1
            cpl_by_phase[m["phase"]].append(m.get("cpl", 0))
            moves_by_phase[m["phase"]] += 1
            bucket["cpl"].append(m.get("cpl", 0))

            tt = in_time_trouble(m, base, daily)
            if not daily and m.get("clock") is not None:
                tt_moves += 1

            if m.get("class") not in ERROR_CLASSES:
                continue

            cost = round(m.get("win_before", 0) - m.get("win_after", 0), 1)
            key = pattern_of(m)
            pattern_counts[key] += 1
            pattern_cost[key].append(cost)
            errors_by_phase[m["phase"]] += 1
            bucket["errors"] += 1
            if tt:
                tt_errors += 1

            record_error = {
                "game_id": game.get("id"),
                "url": game.get("url"),
                "opponent": game.get("opponent"),
                "color": color,
                "ply": m["ply"],
                "move_no": m["move_no"],
                "san": m["san"],
                "class": m["class"],
                "label": m["label"],
                "pattern": key,
                "cost": cost,
                "material_swing": m.get("material_swing", 0),
                "best_move": m.get("best_move"),
                "punish_line": m.get("punish_line", []),
                "phase": m["phase"],
                "time_trouble": tt,
            }
            errors.append(record_error)
            if len(pattern_examples[key]) < 3:
                pattern_examples[key].append(record_error)

    if not my_moves:
        return {"error": "Nenhum lance analisado."}

    patterns = []
    total_errors = sum(pattern_counts.values())
    for key, count in pattern_counts.most_common():
        costs = pattern_cost[key]
        patterns.append(
            {
                "key": key,
                "label": PATTERNS[key]["label"],
                "hint": PATTERNS[key]["hint"],
                "count": count,
                "share": round(count / total_errors * 100, 1) if total_errors else 0,
                "avg_cost": round(sum(costs) / len(costs), 1) if costs else 0,
                "examples": pattern_examples[key],
            }
        )

    by_phase = {}
    for phase in ("opening", "middlegame", "endgame"):
        moves_n = moves_by_phase[phase]
        if not moves_n:
            continue
        vals = cpl_by_phase[phase]
        by_phase[phase] = {
            "label": PHASES_PT[phase],
            "moves": moves_n,
            "errors": errors_by_phase[phase],
            "error_rate": round(errors_by_phase[phase] / moves_n * 100, 1),
            "avg_cpl": round(sum(vals) / len(vals)) if vals else 0,
        }

    worst_phase = max(by_phase.items(), key=lambda kv: kv[1]["error_rate"])[0] if by_phase else None

    opening_rows = []
    for name, b in openings.items():
        if b["games"] < 2:
            continue
        opening_rows.append(
            {
                "name": name,
                "games": b["games"],
                "win": b["win"],
                "loss": b["loss"],
                "draw": b["draw"],
                "errors": b["errors"],
                "avg_cpl": round(sum(b["cpl"]) / len(b["cpl"])) if b["cpl"] else 0,
            }
        )
    opening_rows.sort(key=lambda r: (-r["avg_cpl"], -r["games"]))

    errors.sort(key=lambda e: -e["cost"])

    return {
        "username": username,
        "depth": depth,
        "games": len(entries),
        "moves": len(my_moves),
        "record": {k: record[k] for k in ("win", "loss", "draw") if record[k]},
        "avg_accuracy": round(sum(accuracies) / len(accuracies), 1) if accuracies else None,
        "class_counts": dict(class_counts),
        "total_errors": total_errors,
        "errors_per_game": round(total_errors / len(entries), 1) if entries else 0,
        "patterns": patterns,
        "by_phase": by_phase,
        "worst_phase": worst_phase,
        "time_trouble": {
            "errors": tt_errors,
            "moves_with_clock": tt_moves,
            "share": round(tt_errors / total_errors * 100, 1) if total_errors else 0,
        },
        "openings": opening_rows[:8],
        "top_errors": errors[:12],
    }
