"""Teste rapido do pipeline de analise, sem interface."""

import json
import time

from app import review

PGN = """[Event "Live Chess"]
[Site "Chess.com"]
[Date "2024.03.11"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]
[WhiteElo "1450"]
[BlackElo "1462"]
[ECOUrl "https://www.chess.com/openings/Italian-Game-Two-Knights-Defense"]
[TimeControl "600"]

1. e4 {[%clk 0:09:58]} e5 {[%clk 0:09:57]} 2. Nf3 {[%clk 0:09:55]} Nc6 {[%clk 0:09:54]}
3. Bc4 {[%clk 0:09:51]} Nf6 {[%clk 0:09:49]} 4. Ng5 {[%clk 0:09:44]} d5 {[%clk 0:09:40]}
5. exd5 {[%clk 0:09:38]} Nxd5 {[%clk 0:09:31]} 6. Nxf7 {[%clk 0:09:20]} Kxf7 {[%clk 0:09:12]}
7. Qf3+ {[%clk 0:09:05]} Ke6 {[%clk 0:08:44]} 8. Nc3 {[%clk 0:08:50]} Nce7 {[%clk 0:08:10]}
9. O-O {[%clk 0:08:20]} c6 {[%clk 0:07:50]} 10. d4 {[%clk 0:08:00]} Kd7 {[%clk 0:07:10]}
11. dxe5 {[%clk 0:07:40]} Qb6 {[%clk 0:06:40]} 12. Nxd5 {[%clk 0:07:00]} cxd5 {[%clk 0:06:20]}
13. Bxd5 {[%clk 0:06:40]} Qxb2 {[%clk 0:05:50]} 14. Bxb7 {[%clk 0:06:10]} Qxa1 {[%clk 0:05:20]}
15. Bxa8 {[%clk 0:05:50]} 1-0
"""

if __name__ == "__main__":
    start = time.time()
    result = None
    for event in review.analyze_game(PGN, "white", depth=12):
        if event["type"] == "progress":
            print(f"\r  {event['done']}/{event['total']}", end="", flush=True)
        elif event["type"] == "done":
            result = event["review"]
        else:
            print("ERRO:", event)
    print(f"\nconcluido em {time.time() - start:.1f}s")

    if result:
        print("abertura :", result["opening"])
        print("precisao :", {s: result["summary"][s]["accuracy"] for s in ("white", "black")})
        for side in ("white", "black"):
            counts = {k: v for k, v in result["summary"][side]["counts"].items() if v}
            print(f"{side:6}:", counts, "cpl medio", result["summary"][side]["avg_cpl"])
        print("\nlances:")
        for m in result["moves"]:
            best = f"  (melhor {m['best_move']})" if m["best_move"] else ""
            print(
                f"  {m['move_no']:>2}{'.' if m['side']=='white' else '...'} {m['san']:<7}"
                f" {m['eval_after']/100:+.2f} {m['label']:<15}{best}"
            )
        print("\nmomentos-chave:", [m["san"] for m in result["key_moments"]])
        print("bytes json:", len(json.dumps(result)))
