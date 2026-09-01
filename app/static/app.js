/* Chess Analyzer - interface de revisao no estilo do chess.com. */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

const CLASS_ORDER = [
  "brilliant", "great", "best", "excellent", "good", "book",
  "inaccuracy", "mistake", "miss", "blunder",
];

const CLASS_INFO = {
  brilliant:  { pt: "Brilhante",     sym: "!!" },
  great:      { pt: "Otimo",          sym: "!"  },
  best:       { pt: "Melhor lance",   sym: "★" },
  excellent:  { pt: "Excelente",      sym: "✓" },
  good:       { pt: "Bom",            sym: "✓" },
  book:       { pt: "Livro",          sym: "♟" },
  inaccuracy: { pt: "Impreciso",      sym: "?!" },
  mistake:    { pt: "Erro",           sym: "?"  },
  miss:       { pt: "Chance perdida", sym: "✕" },
  blunder:    { pt: "Erro grave",     sym: "??" },
};

const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };

const state = {
  username: "",
  games: [],
  review: null,
  ply: 0,        // 0 = posicao inicial
  flipped: false,
  depth: 14,
};

/* ------------------------------------------------------------------ util */

function fmtEval(cp, mate) {
  if (mate != null) return (mate > 0 ? "M" : "-M") + Math.abs(mate);
  const v = cp / 100;
  return (v > 0 ? "+" : "") + v.toFixed(1);
}

function fmtClock(sec) {
  if (sec == null) return "";
  // Partidas por dias passam de uma hora: sem isto, 5h05 virava "305:26".
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso.includes("T") ? iso : iso.replace(/\./g, "-"));
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
}

function titleCase(s) {
  return (s || "").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* --------------------------------------------------------------- health */

async function checkEngine() {
  const badge = $("#engine-badge");
  try {
    const r = await fetch("/api/health").then((x) => x.json());
    if (r.ok) {
      badge.textContent = r.engine;
      badge.className = "engine-badge ok";
    } else {
      badge.textContent = "Stockfish nao encontrado";
      badge.className = "engine-badge bad";
    }
  } catch {
    badge.textContent = "servidor fora do ar";
    badge.className = "engine-badge bad";
  }
}

/* ----------------------------------------------------------- tela lista */

$("#form-user").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const username = $("#username").value.trim();
  if (!username) return;
  const count = $("#count").value;
  const err = $("#games-error");
  err.classList.add("hidden");
  $("#games-title").textContent = "Buscando partidas...";
  $("#games-list").classList.remove("hidden");
  $("#games-rows").innerHTML = "";

  try {
    const r = await fetch(`/api/games?username=${encodeURIComponent(username)}&count=${count}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "falha na busca");
    state.username = data.username;
    state.games = data.games;
    localStorage.setItem("chess-analyzer:user", username);
    renderGames();
  } catch (e) {
    $("#games-list").classList.add("hidden");
    err.textContent = e.message;
    err.classList.remove("hidden");
  }
});

function renderGames() {
  $("#games-title").textContent = `${state.games.length} partidas de ${state.username}`;
  const box = $("#games-rows");
  box.innerHTML = "";

  for (const g of state.games) {
    const row = el("div", "game-row");
    row.tabIndex = 0;

    const dot = el("div", `result-dot result-${g.result}`,
      g.result === "win" ? "V" : g.result === "loss" ? "D" : "E");

    const main = el("div", "game-main");
    const opp = el("div", "game-opponent");
    opp.append(el("span", `side-pill side-${g.color}`), " ", `vs ${g.opponent}`,
      g.opponent_rating ? ` (${g.opponent_rating})` : "");
    const sub = el("div", "game-sub", titleCase(g.opening) || "abertura nao identificada");
    main.append(opp, sub);

    const chip = el("span", "chip", g.time_class || "");
    const acc = el("div", "game-meta",
      g.chesscom_accuracy != null ? `${g.chesscom_accuracy}% (chess.com)` : "");
    const when = el("div", "game-meta", fmtDate(g.played_at));

    row.append(dot, main, chip, acc, when);
    row.addEventListener("click", () => startAnalysis(g));
    row.addEventListener("keydown", (e) => { if (e.key === "Enter") startAnalysis(g); });
    box.append(row);
  }
}

$("#btn-pgn").addEventListener("click", async () => {
  const pgn = $("#pgn-input").value.trim();
  if (!pgn) return;
  const r = await fetch("/api/pgn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pgn }),
  });
  const data = await r.json();
  if (!r.ok) {
    $("#games-error").textContent = data.error;
    $("#games-error").classList.remove("hidden");
    return;
  }
  startAnalysis(data.game);
});

$("#btn-home").addEventListener("click", showGames);

function showGames() {
  $("#view-review").classList.add("hidden");
  $("#view-batch").classList.add("hidden");
  $("#view-games").classList.remove("hidden");
  $("#btn-home").classList.add("hidden");
}

/* -------------------------------------------------------------- analise */

async function startAnalysis(game, jumpToPly) {
  state.depth = parseInt($("#depth").value, 10) || 14;
  state.flipped = game.color === "black";
  state.jumpToPly = jumpToPly ?? null;

  $("#view-games").classList.add("hidden");
  $("#view-batch").classList.add("hidden");
  $("#view-review").classList.remove("hidden");
  $("#btn-home").classList.remove("hidden");
  $("#review-body").classList.add("hidden");
  $("#progress-card").classList.remove("hidden");
  $("#progress-fill").style.width = "0%";
  $("#progress-text").textContent = "abrindo o Stockfish...";

  buildBoard();
  renderPosition(START_FEN, null);

  const r = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ game_id: game.id, color: game.color, depth: state.depth }),
  });
  const data = await r.json();
  if (!r.ok) {
    $("#progress-text").textContent = data.error || "falha ao iniciar a analise";
    return;
  }
  if (data.cached) {
    showReview(data.review);
    return;
  }

  const src = new EventSource(`/api/analyze/${data.job_id}/stream`);
  src.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "progress") {
      const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
      $("#progress-fill").style.width = pct + "%";
      $("#progress-text").textContent =
        `lance ${msg.done} de ${msg.total} (profundidade ${state.depth})`;
    } else if (msg.type === "done") {
      src.close();
      showReview(msg.review);
    } else if (msg.type === "error") {
      src.close();
      $("#progress-text").textContent = msg.message;
    }
  };
  src.onerror = () => src.close();
}

function showReview(review) {
  state.review = review;
  state.ply = 0;
  $("#progress-card").classList.add("hidden");
  $("#review-body").classList.remove("hidden");
  renderAccuracy();
  renderCounts();
  renderMoves();
  renderGraph();
  goTo(state.jumpToPly ?? 0);
  state.jumpToPly = null;
}

/* ------------------------------------------------------------ tabuleiro */

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FILES = "abcdefgh";

function buildBoard() {
  const board = $("#board");
  const overlay = $("#overlay");
  board.querySelectorAll(".sq").forEach((n) => n.remove());

  for (let i = 0; i < 64; i++) {
    const sq = el("div", "sq");
    board.insertBefore(sq, overlay);
  }
}

function squareName(index) {
  // index 0..63 na ordem visual, de cima para baixo
  const row = Math.floor(index / 8);
  const col = index % 8;
  const file = state.flipped ? 7 - col : col;
  const rank = state.flipped ? row : 7 - row;
  return FILES[file] + (rank + 1);
}

function parseFen(fen) {
  const map = {};
  const rows = fen.split(" ")[0].split("/");
  rows.forEach((row, r) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { file += parseInt(ch, 10); continue; }
      map[FILES[file] + (8 - r)] = ch;
      file++;
    }
  });
  return map;
}

function renderPosition(fen, move) {
  const board = $("#board");
  const squares = board.querySelectorAll(".sq");
  const pieces = parseFen(fen);

  squares.forEach((sq, i) => {
    const name = squareName(i);
    const file = FILES.indexOf(name[0]);
    const rank = parseInt(name[1], 10) - 1;
    sq.className = "sq " + ((file + rank) % 2 === 0 ? "dark" : "light");
    sq.innerHTML = "";

    if (i % 8 === 0) sq.append(Object.assign(el("span", "coord rank", name[1]), {}));
    if (i >= 56) sq.append(el("span", "coord file", name[0]));

    const p = pieces[name];
    if (p) {
      const span = el("span", "piece " + (p === p.toUpperCase() ? "w" : "b"), GLYPH[p.toLowerCase()]);
      sq.append(span);
    }

    if (move && (name === move.from || name === move.to)) sq.classList.add("hl");

    if (move && name === move.to) {
      const badge = el("div", `move-badge class-${move.class}`, CLASS_INFO[move.class].sym);
      sq.append(badge);
    }
  });

  drawArrow(move);
}

function squareToXY(name) {
  const file = FILES.indexOf(name[0]);
  const rank = parseInt(name[1], 10) - 1;
  const col = state.flipped ? 7 - file : file;
  const row = state.flipped ? rank : 7 - rank;
  return [col * 100 + 50, row * 100 + 50];
}

function drawArrow(move) {
  const svg = $("#overlay");
  svg.innerHTML = "";
  if (!move || !$("#chk-arrow").checked) return;
  if (!move.best_uci || move.best_uci.slice(0, 4) === move.uci.slice(0, 4)) return;
  if (["best", "brilliant", "great", "book", "excellent"].includes(move.class)) return;

  const from = move.best_uci.slice(0, 2);
  const to = move.best_uci.slice(2, 4);
  const [x1, y1] = squareToXY(from);
  const [x2, y2] = squareToXY(to);

  const ns = "http://www.w3.org/2000/svg";
  const defs = document.createElementNS(ns, "defs");
  defs.innerHTML =
    `<marker id="ah" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
       <path d="M0,0 L10,5 L0,10 z" fill="#81b64c"/>
     </marker>`;
  svg.append(defs);

  const line = document.createElementNS(ns, "line");
  // encurta a ponta para o marcador nao cobrir a casa de destino
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  line.setAttribute("x1", x1);
  line.setAttribute("y1", y1);
  line.setAttribute("x2", x2 - (dx / len) * 26);
  line.setAttribute("y2", y2 - (dy / len) * 26);
  line.setAttribute("stroke", "#81b64c");
  line.setAttribute("stroke-width", "14");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("opacity", ".85");
  line.setAttribute("marker-end", "url(#ah)");
  svg.append(line);
}

/* -------------------------------------------------------------- painéis */

function renderAccuracy() {
  const r = state.review;
  for (const side of ["white", "black"]) {
    const box = $(`#acc-${side}`);
    box.innerHTML = "";
    const acc = r.summary[side].accuracy;
    box.append(
      el("div", `acc-value ${side === "white" ? "w" : "b"}`, acc == null ? "--" : acc.toFixed(1)),
      el("div", "acc-name", r[side])
    );
  }
  $("#opening-name").textContent = titleCase(r.opening) || "";
}

function renderCounts() {
  const r = state.review;
  const table = $("#counts-table");
  table.innerHTML = "";
  for (const cls of CLASS_ORDER) {
    const w = r.summary.white.counts[cls] || 0;
    const b = r.summary.black.counts[cls] || 0;
    if (!w && !b) continue;
    const tr = el("tr");
    const swatch = el("span", `swatch class-${cls}`, CLASS_INFO[cls].sym);
    const label = el("td", "label");
    label.append(swatch, CLASS_INFO[cls].pt);
    tr.append(el("td", "n", String(w)), label, el("td", "n", String(b)));
    table.append(tr);
  }
}

function renderMoves() {
  const box = $("#moves-list");
  box.innerHTML = "";
  const moves = state.review.moves;

  for (let i = 0; i < moves.length; i += 2) {
    const white = moves[i];
    const black = moves[i + 1];
    box.append(el("div", "num", white.move_no + "."));
    box.append(moveCell(white));
    box.append(black ? moveCell(black) : el("div"));
  }
}

function moveCell(m) {
  const cell = el("div", `mv txt-${m.class}`);
  cell.dataset.ply = m.ply;
  cell.append(el("span", `dot class-${m.class}`, CLASS_INFO[m.class].sym), el("span", "", m.san));
  cell.addEventListener("click", () => goTo(m.ply));
  return cell;
}

function renderGraph() {
  const svg = $("#evalgraph");
  const series = state.review.eval_series;
  const W = 600, H = 140, mid = H / 2;
  const n = Math.max(1, series.length - 1);
  const y = (cp) => mid - Math.max(-1, Math.min(1, cp / 600)) * (mid - 6);

  let path = `M 0 ${mid}`;
  series.forEach((p, i) => { path += ` L ${(i / n) * W} ${y(p.eval)}`; });
  const area = `${path} L ${W} ${mid} Z`;

  const marks = state.review.moves
    .filter((m) => ["blunder", "mistake", "miss", "brilliant", "great"].includes(m.class))
    .map((m) => {
      const cx = (m.ply / n) * W;
      const color = getComputedStyle(document.documentElement)
        .getPropertyValue("--c-" + m.class).trim();
      return `<circle cx="${cx}" cy="${y(m.eval_after)}" r="4.5" fill="${color}" stroke="#262421" stroke-width="1.5"/>`;
    })
    .join("");

  svg.innerHTML = `
    <rect x="0" y="0" width="${W}" height="${H}" fill="#3f3d3a"/>
    <path d="${area}" fill="#f0efed"/>
    <line x1="0" y1="${mid}" x2="${W}" y2="${mid}" stroke="#8b8987" stroke-width="1" stroke-dasharray="4 4"/>
    <path d="${path}" fill="none" stroke="#c9c7c4" stroke-width="1.5"/>
    ${marks}
    <line id="graph-cursor" x1="0" y1="0" x2="0" y2="${H}" stroke="#81b64c" stroke-width="2"/>
  `;

  svg.onclick = (ev) => {
    const rect = svg.getBoundingClientRect();
    const ratio = (ev.clientX - rect.left) / rect.width;
    goTo(Math.round(ratio * n));
  };
}

function renderComment() {
  const card = $("#comment-card");
  card.innerHTML = "";
  if (state.ply === 0) {
    card.append(el("div", "comment-body", "Posicao inicial. Use as setas do teclado para navegar."));
    return;
  }
  const m = state.review.moves[state.ply - 1];
  const info = CLASS_INFO[m.class];

  const icon = el("div", `comment-icon class-${m.class}`, info.sym);
  const body = el("div", "comment-body");
  const who = m.side === "white" ? state.review.white : state.review.black;
  body.append(el("div", `comment-title txt-${m.class}`,
    `${m.move_no}${m.side === "white" ? "." : "..."} ${m.san} - ${info.pt}`));

  const text = el("div", "comment-text");
  text.innerHTML = commentText(m, who);
  body.append(text);
  card.append(icon, body);
}

function commentText(m, who) {
  const lost = Math.max(0, m.win_before - m.win_after).toFixed(1);
  const evalTxt = fmtEval(m.eval_after, m.mate_after);
  const parts = [];

  switch (m.class) {
    case "book":
      parts.push("Lance de livro, dentro da teoria da abertura."); break;
    case "brilliant":
      parts.push("Sacrificio correto: entrega material e mesmo assim mantem a posicao."); break;
    case "great":
      parts.push("Praticamente o unico lance que segura a posicao."); break;
    case "best":
      parts.push("O melhor lance da posicao, segundo o Stockfish."); break;
    case "excellent":
      parts.push("Quase o melhor lance - nao muda nada na pratica."); break;
    case "good":
      parts.push("Lance razoavel, mas havia algo melhor."); break;
    case "inaccuracy":
      parts.push(`Imprecisao: perdeu <b>${lost}%</b> de chance de vitoria.`); break;
    case "mistake":
      parts.push(`Erro: perdeu <b>${lost}%</b> de chance de vitoria.`); break;
    case "miss":
      parts.push("Havia mate forcado aqui e o lance deixou escapar."); break;
    case "blunder":
      parts.push(`Erro grave: perdeu <b>${lost}%</b> de chance de vitoria.`); break;
  }

  if (m.best_move && m.class !== "book") parts.push(`Melhor: <b>${m.best_move}</b>` +
    (m.best_line && m.best_line.length > 1 ? ` (${m.best_line.slice(0, 4).join(" ")})` : ""));
  parts.push(`Avaliacao: <b>${evalTxt}</b>`);
  return parts.join("<br>");
}

function renderStrips() {
  const r = state.review;
  const m = state.ply > 0 ? r.moves[state.ply - 1] : null;
  const topSide = state.flipped ? "white" : "black";
  const botSide = state.flipped ? "black" : "white";

  const lastClock = (side) => {
    for (let i = state.ply - 1; i >= 0; i--) {
      if (r.moves[i].side === side && r.moves[i].clock != null) return r.moves[i].clock;
    }
    return null;
  };

  for (const [id, side] of [["#strip-top", topSide], ["#strip-bottom", botSide]]) {
    const strip = $(id);
    strip.innerHTML = "";
    strip.append(el("span", `side-pill side-${side}`));
    strip.append(el("span", "name", r[side]));
    const elo = side === "white" ? r.white_elo : r.black_elo;
    if (elo) strip.append(el("span", "elo", `(${elo})`));
    const clk = fmtClock(lastClock(side));
    if (clk) strip.append(el("span", "clock", clk));
  }
}

/* ------------------------------------------------------------ navegacao */

function goTo(ply) {
  const moves = state.review.moves;
  state.ply = Math.max(0, Math.min(moves.length, ply));

  const m = state.ply > 0 ? moves[state.ply - 1] : null;
  renderPosition(m ? m.fen_after : START_FEN, m);
  renderStrips();
  renderComment();

  // barra de avaliacao
  const cp = m ? m.eval_after : 0;
  const mate = m ? m.mate_after : null;
  const pct = 50 + Math.max(-1, Math.min(1, cp / 700)) * 48;
  $("#evalbar-white").style.height = pct + "%";
  const bar = $("#evalbar");
  bar.classList.toggle("negative", cp < 0);
  let txt = (cp / 100).toFixed(1);
  if (mate != null) {
    const whiteMate = m.side === "white" ? mate > 0 : mate < 0;
    txt = "M" + Math.abs(mate);
    bar.classList.toggle("negative", !whiteMate);
    $("#evalbar-white").style.height = (whiteMate ? 100 : 0) + "%";
  }
  $("#evalbar-text").textContent = txt;

  // lance ativo na lista
  document.querySelectorAll(".mv").forEach((n) => {
    n.classList.toggle("active", Number(n.dataset.ply) === state.ply);
  });
  // Rola so a lista de lances - scrollIntoView tambem rolaria a pagina e
  // tiraria o tabuleiro do centro da tela.
  const active = document.querySelector(".mv.active");
  if (active) {
    const box = $("#moves-list");
    const top = active.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top + active.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = top - box.clientHeight / 2 + active.offsetHeight / 2;
    }
  }

  const cursor = document.getElementById("graph-cursor");
  if (cursor) {
    const x = (state.ply / Math.max(1, moves.length)) * 600;
    cursor.setAttribute("x1", x);
    cursor.setAttribute("x2", x);
  }
}

$("#btn-next").onclick = () => goTo(state.ply + 1);
$("#btn-prev").onclick = () => goTo(state.ply - 1);
$("#btn-first").onclick = () => goTo(0);
$("#btn-last").onclick = () => goTo(state.review.moves.length);
$("#btn-flip").onclick = () => { state.flipped = !state.flipped; goTo(state.ply); };
$("#chk-arrow").onchange = () => goTo(state.ply);

document.addEventListener("keydown", (ev) => {
  if (!state.review || $("#view-review").classList.contains("hidden")) return;
  if (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA") return;
  const keys = {
    ArrowRight: () => goTo(state.ply + 1),
    ArrowLeft: () => goTo(state.ply - 1),
    Home: () => goTo(0),
    End: () => goTo(state.review.moves.length),
    f: () => { state.flipped = !state.flipped; goTo(state.ply); },
  };
  const fn = keys[ev.key];
  if (fn) { ev.preventDefault(); fn(); }
});

/* ------------------------------------------------------- analise em lote */

const PATTERN_SHORT = {
  allowed_mate: "permitiu mate",
  missed_mate: "deixou escapar mate",
  tactic_shot: "levou tatica",
  hung_material: "material pendurado",
  bad_capture: "captura/troca ruim",
  positional_opening: "erro posicional na abertura",
  positional_middlegame: "erro posicional no meio-jogo",
  positional_endgame: "erro posicional no final",
};

const batch = { jobId: null, source: null, startedAt: 0, analyzed: 0 };

$("#btn-batch").addEventListener("click", startBatch);
$("#btn-batch-cancel").addEventListener("click", cancelBatch);

async function startBatch() {
  if (!state.games.length) return;
  const n = parseInt($("#batch-count").value, 10);
  const games = n > 0 ? state.games.slice(0, n) : state.games;
  const depth = parseInt($("#depth").value, 10) || 14;

  $("#view-games").classList.add("hidden");
  $("#view-batch").classList.remove("hidden");
  $("#btn-home").classList.remove("hidden");
  $("#batch-body").classList.add("hidden");
  $("#batch-progress").classList.remove("hidden");
  $("#batch-fill").style.width = "0%";
  $("#batch-title").textContent = `Analisando ${games.length} partidas...`;
  $("#batch-text").textContent = "abrindo o Stockfish";
  $("#batch-eta").textContent = "";

  const r = await fetch("/api/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ games, depth, username: state.username }),
  });
  const data = await r.json();
  if (!r.ok) {
    $("#batch-text").textContent = data.error || "falha ao iniciar o lote";
    return;
  }

  batch.jobId = data.job_id;
  batch.startedAt = Date.now();
  batch.analyzed = 0;

  const src = new EventSource(`/api/analyze/${data.job_id}/stream`);
  batch.source = src;
  src.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "progress") onBatchProgress(msg, games.length);
    else if (msg.type === "done") {
      src.close();
      showAggregate(msg.aggregate, msg.canceled);
    } else if (msg.type === "error") {
      src.close();
      $("#batch-text").textContent = msg.message;
    }
  };
  src.onerror = () => src.close();
}

function onBatchProgress(msg, totalGames) {
  // Combina partidas concluidas + lances da partida atual, senao a barra fica
  // parada durante os minutos de uma unica partida.
  const frac = msg.total ? msg.done / msg.total : 0;
  const pct = Math.round(((msg.game - 1 + frac) / totalGames) * 100);
  $("#batch-fill").style.width = pct + "%";
  $("#batch-text").textContent = msg.cached
    ? `partida ${msg.game} de ${totalGames} (vs ${msg.opponent}) — já estava no cache`
    : `partida ${msg.game} de ${totalGames} (vs ${msg.opponent}) — lance ${msg.done} de ${msg.total}`;

  if (!msg.cached) batch.analyzed++;
  const elapsed = (Date.now() - batch.startedAt) / 1000;
  if (batch.analyzed > 20 && pct > 2) {
    const restante = Math.round((elapsed / pct) * (100 - pct));
    $("#batch-eta").textContent = `~${Math.ceil(restante / 60)} min restantes`;
  }
}

async function cancelBatch() {
  if (!batch.jobId) return;
  $("#batch-text").textContent = "cancelando — vou montar o resumo com o que já foi analisado";
  await fetch(`/api/job/${batch.jobId}/cancel`, { method: "POST" });
}

function showAggregate(agg, canceled) {
  if (agg.error) {
    $("#batch-text").textContent = agg.error;
    return;
  }
  state.aggregate = agg;
  $("#batch-progress").classList.add("hidden");
  $("#batch-body").classList.remove("hidden");

  const top = agg.patterns[0];
  if (top) {
    $("#hero-label").textContent = top.label;
    $("#hero-hint").textContent = top.hint;
    $("#hero-share").textContent = top.share + "%";
    $("#hero-count").textContent =
      `${top.count} de ${agg.total_errors} erros · custo médio ${top.avg_cost}% de chance de vitória`;
  } else {
    $("#hero-label").textContent = "Nenhum erro grave no período";
    $("#hero-hint").textContent = "Nenhum lance foi classificado como Erro ou pior nessas partidas.";
    $("#hero-share").textContent = "0%";
    $("#hero-count").textContent = "";
  }

  renderTiles(agg, canceled);
  renderPatternBars(agg);
  renderPhaseBars(agg);
  renderOpenings(agg);
  renderTopErrors(agg);
}

function tile(value, label) {
  const box = el("div", "tile");
  box.append(el("div", "tile-value", value), el("div", "tile-label", label));
  return box;
}

function renderTiles(agg, canceled) {
  const box = $("#batch-tiles");
  box.innerHTML = "";
  const rec = agg.record || {};
  const worst = agg.by_phase[agg.worst_phase];

  box.append(
    tile(String(agg.games), canceled ? "partidas (lote cancelado)" : "partidas analisadas"),
    tile(agg.avg_accuracy == null ? "--" : agg.avg_accuracy.toFixed(1), "precisão média"),
    tile(String(agg.errors_per_game), "erros por partida"),
    tile(worst ? titleCase(worst.label) : "--", "fase onde mais erra"),
    tile(`${agg.time_trouble.share}%`, "dos erros em apuros de tempo"),
    tile(`${rec.win || 0}/${rec.draw || 0}/${rec.loss || 0}`, "vitórias/empates/derrotas")
  );
}

function renderPatternBars(agg) {
  const box = $("#pattern-bars");
  box.innerHTML = "";
  const max = agg.patterns.length ? agg.patterns[0].count : 1;

  for (const p of agg.patterns) {
    const row = el("div", "pbar-row");
    const head = el("div", "pbar-head");
    head.append(el("span", "pbar-label", p.label), el("span", "pbar-n", `${p.count} (${p.share}%)`));
    const track = el("div", "pbar-track");
    const fill = el("div", "pbar-fill");
    fill.style.width = (p.count / max) * 100 + "%";
    track.append(fill);

    const examples = el("div", "pbar-examples");
    for (const ex of p.examples) {
      const chip = el("button", "example-chip",
        `${ex.move_no}${ex.color === "white" ? "." : "..."} ${ex.san} vs ${ex.opponent}`);
      chip.onclick = () => openErrorPosition(ex);
      examples.append(chip);
    }

    row.append(head, track, examples);
    box.append(row);
  }
}

function renderPhaseBars(agg) {
  const box = $("#phase-bars");
  box.innerHTML = "";
  const rows = Object.values(agg.by_phase);
  const max = Math.max(1, ...rows.map((r) => r.error_rate));

  for (const r of rows) {
    const row = el("div", "pbar-row");
    const head = el("div", "pbar-head");
    head.append(
      el("span", "pbar-label", titleCase(r.label)),
      el("span", "pbar-n", `${r.errors} erros em ${r.moves} lances · ${r.error_rate}%`)
    );
    const track = el("div", "pbar-track");
    const fill = el("div", "pbar-fill");
    fill.style.width = (r.error_rate / max) * 100 + "%";
    track.append(fill);
    row.append(head, track);
    box.append(row);
  }
}

function renderOpenings(agg) {
  const table = $("#openings-table");
  table.innerHTML = "";
  if (!agg.openings.length) {
    const tr = el("tr");
    tr.append(el("td", "muted", "Poucas repetições para comparar aberturas."));
    table.append(tr);
    return;
  }
  const head = el("tr");
  ["Abertura", "Partidas", "V/E/D", "Erros"].forEach((h) => head.append(el("th", "", h)));
  table.append(head);

  for (const o of agg.openings) {
    const tr = el("tr");
    tr.append(
      el("td", "", titleCase(o.name)),
      el("td", "n", String(o.games)),
      el("td", "n", `${o.win}/${o.draw}/${o.loss}`),
      el("td", "n", String(o.errors))
    );
    table.append(tr);
  }
}

function renderTopErrors(agg) {
  const box = $("#top-errors");
  box.innerHTML = "";
  for (const e of agg.top_errors) {
    const row = el("button", "error-row");
    row.append(el("span", `dot class-${e.class}`, CLASS_INFO[e.class].sym));
    const main = el("div", "error-main");
    main.append(
      el("div", "error-move",
        `${e.move_no}${e.color === "white" ? "." : "..."} ${e.san} — ${e.label}`),
      el("div", "error-sub",
        `${PATTERN_SHORT[e.pattern] || e.pattern} · vs ${e.opponent}` +
        (e.best_move ? ` · melhor era ${e.best_move}` : "") +
        (e.punish_line.length ? ` · punição: ${e.punish_line.join(" ")}` : ""))
    );
    row.append(main, el("span", "error-cost", `-${e.cost}%`));
    row.onclick = () => openErrorPosition(e);
    box.append(row);
  }
}

function openErrorPosition(err) {
  const game = state.games.find((g) => g.id === err.game_id);
  if (!game) return;
  startAnalysis(game, err.ply);
}

/* ----------------------------------------------------------------- init */

checkEngine();
const saved = localStorage.getItem("chess-analyzer:user");
if (saved) $("#username").value = saved;
