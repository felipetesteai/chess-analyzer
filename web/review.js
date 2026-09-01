/* Revisao de partida no navegador. Porte de app/review.py.
 *
 * Mesmas formulas: avaliacao -> chance de vitoria (curva do lichess), precisao
 * por lance, e os rotulos no estilo do Game Review do chess.com.
 */

import { Chess } from "./vendor/chess.js";
import { clockSeconds, openingName } from "./chesscom.js";

const EVAL_CAP = 1000;

const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

// Perda de win% (0-100) que define cada rotulo.
const THRESHOLDS = [
  [2.0, "excellent"],
  [5.0, "good"],
  [10.0, "inaccuracy"],
  [20.0, "mistake"],
];

export const LABELS_PT = {
  brilliant: "Brilhante",
  great: "Otimo",
  best: "Melhor",
  excellent: "Excelente",
  good: "Bom",
  book: "Livro",
  inaccuracy: "Impreciso",
  mistake: "Erro",
  miss: "Chance perdida",
  blunder: "Erro grave",
};

/* ------------------------------------------------------------ avaliacao */

/** Converte o score do UCI (POV de quem joga) para centipeoes POV das brancas. */
export function toWhiteCp({ cp, mate }, whiteToMove) {
  let value;
  if (mate !== null && mate !== undefined) value = mate > 0 ? EVAL_CAP : -EVAL_CAP;
  else if (cp === null || cp === undefined) value = 0;
  else value = cp;
  const white = whiteToMove ? value : -value;
  return Math.max(-EVAL_CAP, Math.min(EVAL_CAP, white));
}

export function winPct(cp) {
  const c = Math.max(-EVAL_CAP, Math.min(EVAL_CAP, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

export function winPctFor(cpWhite, whiteToMove) {
  const w = winPct(cpWhite);
  return whiteToMove ? w : 100 - w;
}

export function moveAccuracy(winBefore, winAfter) {
  const delta = Math.max(0, winBefore - winAfter);
  const acc = 103.1668 * Math.exp(-0.04354 * delta) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

export function gameAccuracy(accuracies, winSeries) {
  if (!accuracies.length) return null;
  const window = Math.max(2, Math.min(8, Math.floor(winSeries.length / 10)));

  const weights = accuracies.map((_, i) => {
    const chunk = winSeries.slice(Math.max(0, i - window), i + window + 1);
    if (!chunk.length) return 0.5;
    const mean = chunk.reduce((a, b) => a + b, 0) / chunk.length;
    const varr = chunk.reduce((a, b) => a + (b - mean) ** 2, 0) / chunk.length;
    return Math.max(0.5, Math.min(12, Math.sqrt(varr)));
  });

  const totalW = weights.reduce((a, b) => a + b, 0) || 1;
  const weighted = accuracies.reduce((a, acc, i) => a + acc * weights[i], 0) / totalW;
  const harmonic = accuracies.length / accuracies.reduce((a, x) => a + 1 / Math.max(x, 1e-6), 0);
  return Math.round(Math.max(0, Math.min(100, (weighted + harmonic) / 2)) * 10) / 10;
}

/* --------------------------------------------------------- heuristicas */

let bookCache = null;

export async function loadBook() {
  if (bookCache) return bookCache;
  try {
    const text = await fetch("openings_book.txt").then((r) => r.text());
    bookCache = new Set(
      text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    );
  } catch {
    bookCache = new Set();
  }
  return bookCache;
}

/** EPD = os 4 primeiros campos do FEN (sem os contadores de lance). */
function epd(fen) {
  return fen.split(" ").slice(0, 4).join(" ");
}

function boardCounts(fen) {
  const rows = fen.split(" ")[0];
  const out = [];
  for (const ch of rows) {
    if (/[a-zA-Z]/.test(ch)) out.push(ch);
  }
  return out;
}

export function phaseOf(fen) {
  const fullmove = parseInt(fen.split(" ")[5], 10) || 1;
  const material = boardCounts(fen)
    .filter((c) => !"pPkK".includes(c))
    .reduce((a, c) => a + PIECE_VALUE[c.toLowerCase()], 0);

  if (fullmove <= 12 && material >= 26) return "opening";
  if (material <= 12) return "endgame";
  return "middlegame";
}

/** Saldo de material do ponto de vista de `color` ('w' | 'b'). */
function materialBalance(fen, color) {
  let mine = 0;
  let theirs = 0;
  for (const c of boardCounts(fen)) {
    const value = PIECE_VALUE[c.toLowerCase()];
    const isWhite = c === c.toUpperCase();
    if ((color === "w") === isWhite) mine += value;
    else theirs += value;
  }
  return mine - theirs;
}

function pushUci(chess, uci) {
  try {
    return chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
  } catch {
    return null;
  }
}

/** Aplica ate `max` lances da linha e devolve os SAN e o FEN final. */
function walkLine(fromFen, uciMoves, max) {
  const chess = new Chess(fromFen);
  const san = [];
  for (const uci of uciMoves.slice(0, max)) {
    const mv = pushUci(chess, uci);
    if (!mv) break;
    san.push(mv.san);
  }
  return { san, fen: chess.fen() };
}

function isSacrifice(fenBefore, moveUci, pvAfter) {
  const chess = new Chess(fenBefore);
  const mover = chess.turn();
  const before = materialBalance(fenBefore, mover);
  if (!pushUci(chess, moveUci)) return false;

  const { fen } = walkLine(chess.fen(), pvAfter, 3);
  return materialBalance(fen, mover) - before <= -2;
}

/* -------------------------------------------------------- classificacao */

function classify(o) {
  const loss = Math.max(0, o.winBefore - o.winAfter);
  const isBest = o.bestUci && o.moveUci === o.bestUci;

  if (o.inBook) return "book";

  if (isBest && loss <= 2.0) {
    if (o.winAfter >= 45 && isSacrifice(o.fenBefore, o.moveUci, o.pvAfter)) return "brilliant";
    if (o.secondBestWin !== null && o.winAfter - o.secondBestWin >= 20 &&
        o.winAfter >= 15 && o.winAfter <= 92) {
      return "great";
    }
    return "best";
  }

  if (o.mateBefore !== null && o.mateBefore > 0 && o.mateAfter === null && loss >= 5) {
    return "miss";
  }

  for (const [limit, label] of THRESHOLDS) {
    if (loss < limit) return label;
  }
  return "blunder";
}

/* -------------------------------------------------------------- analise */

/**
 * Analisa a partida inteira.
 * @param onProgress ({done, total}) chamado a cada lance.
 */
export async function analyzeGame(engine, pgn, myColor, { depth = 12, onProgress, signal } = {}) {
  const book = await loadBook();

  const game = new Chess();
  game.loadPgn(pgn);
  const history = game.history({ verbose: true });
  if (!history.length) throw new Error("Partida sem lances.");

  // getComments() indexa pelo FEN resultante do lance - e ali que vem o relogio.
  const clocks = new Map();
  for (const { fen, comment } of game.getComments()) clocks.set(fen, clockSeconds(comment));

  const evaluate = async (fen) => {
    const probe = new Chess(fen);
    if (probe.isGameOver()) {
      let cp = 0;
      if (probe.isCheckmate()) cp = probe.turn() === "w" ? -EVAL_CAP : EVAL_CAP;
      return { cpWhite: cp, bestUci: null, secondWin: null, pv: [], mate: null };
    }

    const infos = await engine.analyse(fen, { depth, multipv: 2 });
    const whiteToMove = probe.turn() === "w";
    const first = infos[0] || { cp: 0, mate: null, pv: [] };

    return {
      cpWhite: toWhiteCp(first, whiteToMove),
      bestUci: first.pv[0] || null,
      secondWin: infos[1]
        ? winPctFor(toWhiteCp(infos[1], whiteToMove), whiteToMove)
        : null,
      pv: first.pv,
      mate: first.mate ?? null,
    };
  };

  const evals = [await evaluate(history[0].before)];
  onProgress?.({ done: 0, total: history.length });

  const moves = [];
  for (let idx = 0; idx < history.length; idx++) {
    if (signal?.aborted) throw new DOMException("cancelado", "AbortError");

    const h = history[idx];
    const after = await evaluate(h.after);
    evals.push(after);

    const before = evals[idx];
    const moverIsWhite = h.color === "w";
    const wb = winPctFor(before.cpWhite, moverIsWhite);
    const wa = winPctFor(after.cpWhite, moverIsWhite);

    const inBook = idx < 24 && book.has(epd(h.after));
    const mateAfterMover = after.mate === null ? null : -after.mate;

    const label = classify({
      fenBefore: h.before,
      moveUci: h.lan,
      bestUci: before.bestUci,
      winBefore: wb,
      winAfter: wa,
      secondBestWin: before.secondWin,
      inBook,
      mateBefore: before.mate,
      mateAfter: mateAfterMover,
      pvAfter: after.pv,
    });

    // Como o adversario pune: 6 meios-lances a partir da posicao resultante.
    const punish = walkLine(h.after, after.pv, 6);
    const materialSwing =
      materialBalance(punish.fen, h.color) - materialBalance(h.before, h.color);

    let punishIsCheck = false;
    let punishIsCapture = false;
    if (after.pv.length) {
      const probe = new Chess(h.after);
      const mv = pushUci(probe, after.pv[0]);
      if (mv) {
        punishIsCheck = probe.isCheck();
        punishIsCapture = mv.flags.includes("c") || mv.flags.includes("e");
      }
    }

    let bestSan = null;
    let bestLine = [];
    if (before.bestUci && before.bestUci !== h.lan) {
      const line = walkLine(h.before, before.pv, 6);
      bestSan = line.san[0] || null;
      bestLine = line.san;
    }

    moves.push({
      ply: idx + 1,
      move_no: Number(h.before.split(" ")[5]) || 1,
      side: moverIsWhite ? "white" : "black",
      san: h.san,
      uci: h.lan,
      from: h.from,
      to: h.to,
      fen_before: h.before,
      fen_after: h.after,
      eval_before: before.cpWhite,
      eval_after: after.cpWhite,
      mate_after: mateAfterMover,
      win_before: Math.round(wb * 10) / 10,
      win_after: Math.round(wa * 10) / 10,
      cpl: Math.round(Math.max(0, wb - wa) * 10),
      accuracy: Math.round(moveAccuracy(wb, wa) * 10) / 10,
      class: label,
      label: LABELS_PT[label],
      best_move: bestSan,
      best_uci: before.bestUci,
      best_line: bestLine,
      punish_line: punish.san,
      punish_is_check: punishIsCheck,
      punish_is_capture: punishIsCapture,
      material_swing: materialSwing,
      phase: phaseOf(h.before),
      clock: clocks.get(h.after) ?? null,
      is_capture: h.flags.includes("c") || h.flags.includes("e"),
      is_check: new Chess(h.after).isCheck(),
    });

    onProgress?.({ done: idx + 1, total: history.length });
  }

  return summarize(game, moves, myColor, depth);
}

function summarize(game, moves, myColor, depth) {
  const summary = {};
  for (const side of ["white", "black"]) {
    const sideMoves = moves.filter((m) => m.side === side);
    const counts = Object.fromEntries(Object.keys(LABELS_PT).map((k) => [k, 0]));
    for (const m of sideMoves) counts[m.class]++;

    const wins = moves.map((m) =>
      m.side === side ? m.win_before : 100 - m.win_before
    );

    summary[side] = {
      counts,
      accuracy: gameAccuracy(sideMoves.map((m) => m.accuracy), wins),
      avg_cpl: sideMoves.length
        ? Math.round(sideMoves.reduce((a, m) => a + m.cpl, 0) / sideMoves.length)
        : null,
      avg_cpl_by_phase: avgByPhase(sideMoves),
    };
  }

  const keyMoments = moves
    .filter((m) => ["blunder", "mistake", "miss"].includes(m.class))
    .sort((a, b) => b.win_before - b.win_after - (a.win_before - a.win_after))
    .slice(0, 6);

  const h = game.getHeaders();
  return {
    white: h.White || "Brancas",
    black: h.Black || "Pretas",
    white_elo: h.WhiteElo,
    black_elo: h.BlackElo,
    result: h.Result || "*",
    opening: openingName(h),
    date: h.UTCDate || h.Date || "",
    my_color: myColor,
    depth,
    moves,
    summary,
    key_moments: keyMoments,
    eval_series: [
      { ply: 0, eval: moves.length ? moves[0].eval_before : 0 },
      ...moves.map((m) => ({ ply: m.ply, eval: m.eval_after })),
    ],
  };
}

function avgByPhase(sideMoves) {
  const out = {};
  for (const phase of ["opening", "middlegame", "endgame"]) {
    const vals = sideMoves.filter((m) => m.phase === phase).map((m) => m.cpl);
    if (vals.length) out[phase] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  return out;
}
