/* Cliente da Published-Data API publica do chess.com, chamada direto do
 * navegador. Porte de app/chesscom.py.
 *
 * Da para chamar sem proxy porque a API responde `Access-Control-Allow-Origin: *`.
 * Cada visitante chama do proprio IP, entao o limite de taxa nao se concentra
 * num servidor so.
 */

const API = "https://api.chess.com/pub";

export class ChessComError extends Error {}

async function get(url) {
  let resp;
  try {
    resp = await fetch(url);
  } catch {
    throw new ChessComError("Não consegui falar com o chess.com. Verifique sua conexão.");
  }
  if (resp.status === 404) {
    throw new ChessComError("Perfil não encontrado no chess.com. Confira o nome de usuário exato.");
  }
  if (resp.status === 403 || resp.status === 429) {
    throw new ChessComError("O chess.com limitou as requisições. Tente de novo em alguns minutos.");
  }
  if (!resp.ok) throw new ChessComError(`chess.com respondeu ${resp.status}.`);
  return resp.json();
}

export function profile(username) {
  return get(`${API}/player/${username.toLowerCase()}`);
}

export function headersOf(pgn) {
  const out = {};
  for (const m of (pgn || "").matchAll(/\[(\w+)\s+"([^"]*)"\]/g)) out[m[1]] = m[2];
  return out;
}

const DRAW_RESULTS = new Set([
  "agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient",
]);

function resultFor(game, color) {
  const res = (game[color] || {}).result || "";
  if (res === "win") return "win";
  return DRAW_RESULTS.has(res) ? "draw" : "loss";
}

export function openingName(headers) {
  const ecoUrl = headers.ECOUrl || "";
  if (ecoUrl) {
    const slug = ecoUrl.replace(/\/$/, "").split("/").pop();
    let name = slug.replace(/-/g, " ");
    // O slug do chess.com emenda a linha de lances no nome; corta ali.
    const cut = name.match(/\s\d+\s*\./);
    if (cut) name = name.slice(0, cut.index);
    return name.trim();
  }
  return headers.Opening || headers.ECO || "";
}

/** Relogio restante do comentario `[%clk 0:03:12.5]`. */
export function clockSeconds(comment) {
  const m = /\[%clk\s+(\d+):(\d+):([\d.]+)\]/.exec(comment || "");
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** As `count` partidas mais recentes, da mais nova para a mais antiga. */
export async function listGames(username, count = 30, onProgress) {
  const user = username.toLowerCase();
  const { archives = [] } = await get(`${API}/player/${user}/games/archives`);
  if (!archives.length) throw new ChessComError("Esse perfil não tem partidas públicas.");

  const out = [];
  for (const url of [...archives].reverse()) {
    if (onProgress) onProgress(out.length, count);
    const payload = await get(url);
    for (const game of (payload.games || []).reverse()) {
      const pgn = game.pgn;
      if (!pgn) continue;

      const white = (game.white?.username || "").toLowerCase();
      const black = (game.black?.username || "").toLowerCase();
      let color;
      if (user === white) color = "white";
      else if (user === black) color = "black";
      else continue;

      const hdr = headersOf(pgn);
      const them = color === "white" ? game.black : game.white;
      const me = color === "white" ? game.white : game.black;

      out.push({
        id: String(game.uuid || game.url || ""),
        url: game.url,
        pgn,
        color,
        opponent: color === "white" ? black : white,
        opponent_rating: them?.rating,
        my_rating: me?.rating,
        result: resultFor(game, color),
        termination: hdr.Termination || "",
        time_class: game.time_class,
        time_control: game.time_control,
        rated: game.rated ?? true,
        opening: openingName(hdr),
        chesscom_accuracy: game.accuracies?.[color] ?? null,
        played_at: game.end_time
          ? new Date(game.end_time * 1000).toISOString()
          : hdr.UTCDate || "",
      });

      if (out.length >= count) return out;
    }
  }
  return out;
}
