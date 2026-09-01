/* Agregacao de varias partidas: acha o padrao de erro mais comum.
 * Porte de app/aggregate.py.
 */

const ERROR_CLASSES = new Set(["mistake", "miss", "blunder"]);

export const PATTERNS = {
  allowed_mate: {
    label: "Permitiu mate forçado",
    hint: "Você entrou numa sequência de mate. Antes de mexer, olhe os xeques que o adversário tem contra o seu rei.",
  },
  missed_mate: {
    label: "Deixou escapar mate forçado",
    hint: "Você tinha mate na posição e jogou outra coisa. Quando o rei inimigo estiver preso, procure xeques antes de qualquer outro lance.",
  },
  tactic_shot: {
    label: "Levou tática (xeque ou ataque duplo)",
    hint: "O adversário puniu com xeque e ganhou material na sequência. Cheque garfos, cravadas e xeques intermediários antes de mexer.",
  },
  hung_material: {
    label: "Deixou material pendurado",
    hint: "Você deixou uma peça sendo atacada sem defesa suficiente. Depois de escolher o lance, confira o que fica sem proteção.",
  },
  bad_capture: {
    label: "Capturou ou trocou mal",
    hint: "A captura saiu cara — a recaptura do adversário deixou você com menos material ou pior posição. Conte a sequência inteira antes.",
  },
  // O erro sem perda de material e separado por fase: junto num balde so, ele
  // vira a maioria dos casos e nao diz nada sobre o que estudar.
  positional_opening: {
    label: "Erro posicional na abertura",
    hint: "Sem perder peça, mas saindo pior da abertura — peça mal desenvolvida, rei sem rocar ou peão solto. Fixe uma resposta para as aberturas que você mais enfrenta e siga os princípios: centro, desenvolvimento, roque.",
  },
  positional_middlegame: {
    label: "Erro posicional no meio-jogo",
    hint: "Sem perda de material, mas a posição desandou: peça sem função, coluna ou casa forte entregue, estrutura de peões piorada. Antes de mexer, pergunte qual é a sua pior peça.",
  },
  positional_endgame: {
    label: "Erro posicional no final",
    hint: "Final tratado sem plano: rei passivo, peão passado mal conduzido ou oposição perdida. Finais de rei e peões e de torre são os que mais aparecem.",
  },
};

const PHASES_PT = { opening: "abertura", middlegame: "meio-jogo", endgame: "final" };

export function patternOf(move) {
  if (move.mate_after !== null && move.mate_after !== undefined && move.mate_after < 0) {
    return "allowed_mate";
  }
  if (move.class === "miss") return "missed_mate";

  const swing = move.material_swing ?? 0;
  // Um peao de diferenca so conta como perda de material se o adversario
  // realmente captura na sequencia - senao pega ruido de avaliacao.
  const lostMaterial = swing <= -2 || (swing <= -1 && move.punish_is_capture);
  if (lostMaterial) {
    if (move.punish_is_check) return "tactic_shot";
    if (move.is_capture) return "bad_capture";
    return "hung_material";
  }
  if (move.is_capture && swing <= -1) return "bad_capture";
  return "positional_" + (move.phase || "middlegame");
}

/** Partidas por dias vem como "1/259200" (um lance a cada 3 dias). */
export function isDaily(timeControl) {
  return /^\d+\/\d+$/.test(String(timeControl || ""));
}

export function baseSeconds(timeControl) {
  if (!timeControl) return null;
  const tc = String(timeControl);
  // "1/259200": o tempo esta DEPOIS da barra. Ler o "1" da frente dava 1 segundo.
  const daily = /^\d+\/(\d+)$/.exec(tc);
  if (daily) return Number(daily[1]);
  // "600" ou "600+5" — o incremento nao conta como tempo base.
  const m = /^(\d+)/.exec(tc);
  return m ? Number(m[1]) : null;
}

function inTimeTrouble(move, base, daily) {
  // Em partida por dias nao existe apuro de tempo: sao dias por lance.
  if (daily) return false;
  if (move.clock === null || move.clock === undefined) return false;
  const limit = base ? Math.max(30, 0.1 * base) : 30;
  return move.clock < limit;
}

const inc = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const push = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};

export function build(entries, username, depth) {
  const myMoves = [];
  const errors = [];
  const record = new Map();
  const accuracies = [];

  const cplByPhase = new Map();
  const movesByPhase = new Map();
  const errorsByPhase = new Map();
  const classCounts = new Map();
  const patternCounts = new Map();
  const patternCost = new Map();
  const patternExamples = new Map();
  const openings = new Map();
  let ttErrors = 0;
  let ttMoves = 0;

  for (const { game, review } of entries) {
    const color = game.color || review.my_color || "white";
    const base = baseSeconds(game.time_control);
    const daily = isDaily(game.time_control);

    inc(record, game.result || "unknown");
    const acc = review.summary?.[color]?.accuracy;
    if (acc !== null && acc !== undefined) accuracies.push(acc);

    const openingKey = (game.opening || review.opening || "desconhecida").trim();
    if (!openings.has(openingKey)) {
      openings.set(openingKey, { games: 0, win: 0, loss: 0, draw: 0, cpl: [], errors: 0 });
    }
    const bucket = openings.get(openingKey);
    bucket.games++;
    if (["win", "loss", "draw"].includes(game.result)) bucket[game.result]++;

    for (const m of review.moves || []) {
      if (m.side !== color) continue;
      myMoves.push(m);
      inc(classCounts, m.class);
      push(cplByPhase, m.phase, m.cpl ?? 0);
      inc(movesByPhase, m.phase);
      bucket.cpl.push(m.cpl ?? 0);

      const tt = inTimeTrouble(m, base, daily);
      if (!daily && m.clock !== null && m.clock !== undefined) ttMoves++;
      if (!ERROR_CLASSES.has(m.class)) continue;

      const cost = Math.round((m.win_before - m.win_after) * 10) / 10;
      const key = patternOf(m);
      inc(patternCounts, key);
      push(patternCost, key, cost);
      inc(errorsByPhase, m.phase);
      bucket.errors++;
      if (tt) ttErrors++;

      const error = {
        game_id: game.id,
        url: game.url,
        opponent: game.opponent,
        color,
        ply: m.ply,
        move_no: m.move_no,
        san: m.san,
        class: m.class,
        label: m.label,
        pattern: key,
        cost,
        material_swing: m.material_swing ?? 0,
        best_move: m.best_move,
        punish_line: m.punish_line || [],
        phase: m.phase,
        time_trouble: tt,
      };
      errors.push(error);
      if (!patternExamples.has(key)) patternExamples.set(key, []);
      const ex = patternExamples.get(key);
      if (ex.length < 3) ex.push(error);
    }
  }

  if (!myMoves.length) return { error: "Nenhum lance analisado." };

  const totalErrors = [...patternCounts.values()].reduce((a, b) => a + b, 0);
  const patterns = [...patternCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => {
      const costs = patternCost.get(key) || [];
      return {
        key,
        label: PATTERNS[key].label,
        hint: PATTERNS[key].hint,
        count,
        share: totalErrors ? Math.round((count / totalErrors) * 1000) / 10 : 0,
        avg_cost: costs.length
          ? Math.round((costs.reduce((a, b) => a + b, 0) / costs.length) * 10) / 10
          : 0,
        examples: patternExamples.get(key) || [],
      };
    });

  const byPhase = {};
  for (const phase of ["opening", "middlegame", "endgame"]) {
    const movesN = movesByPhase.get(phase) || 0;
    if (!movesN) continue;
    const vals = cplByPhase.get(phase) || [];
    const errs = errorsByPhase.get(phase) || 0;
    byPhase[phase] = {
      label: PHASES_PT[phase],
      moves: movesN,
      errors: errs,
      error_rate: Math.round((errs / movesN) * 1000) / 10,
      avg_cpl: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0,
    };
  }

  const phaseEntries = Object.entries(byPhase);
  const worstPhase = phaseEntries.length
    ? phaseEntries.reduce((a, b) => (b[1].error_rate > a[1].error_rate ? b : a))[0]
    : null;

  const openingRows = [...openings.entries()]
    .filter(([, b]) => b.games >= 2)
    .map(([name, b]) => ({
      name,
      games: b.games,
      win: b.win,
      loss: b.loss,
      draw: b.draw,
      errors: b.errors,
      avg_cpl: b.cpl.length ? Math.round(b.cpl.reduce((x, y) => x + y, 0) / b.cpl.length) : 0,
    }))
    .sort((a, b) => b.avg_cpl - a.avg_cpl || b.games - a.games);

  errors.sort((a, b) => b.cost - a.cost);

  return {
    username,
    depth,
    games: entries.length,
    moves: myMoves.length,
    record: Object.fromEntries(
      ["win", "draw", "loss"].filter((k) => record.get(k)).map((k) => [k, record.get(k)])
    ),
    avg_accuracy: accuracies.length
      ? Math.round((accuracies.reduce((a, b) => a + b, 0) / accuracies.length) * 10) / 10
      : null,
    class_counts: Object.fromEntries(classCounts),
    total_errors: totalErrors,
    errors_per_game: entries.length
      ? Math.round((totalErrors / entries.length) * 10) / 10
      : 0,
    patterns,
    by_phase: byPhase,
    worst_phase: worstPhase,
    time_trouble: {
      errors: ttErrors,
      moves_with_clock: ttMoves,
      share: totalErrors ? Math.round((ttErrors / totalErrors) * 1000) / 10 : 0,
    },
    openings: openingRows.slice(0, 8),
    top_errors: errors.slice(0, 12),
  };
}
