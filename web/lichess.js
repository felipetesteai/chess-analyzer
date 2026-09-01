/* Explorador de aberturas do Lichess.
 *
 * Desde marco de 2026 o explorador nao aceita mais requisicao anonima
 * (https://github.com/lichess-org/lila/issues/19610): continua gratis e sem
 * limite, mas exige um token. Como este site nao tem backend, cada visitante
 * conecta a propria conta pelo fluxo OAuth2 Authorization Code + PKCE, que
 * dispensa client secret. O token fica no navegador de quem visita e nunca
 * passa por nenhum servidor nosso.
 *
 * O `client_id` e um identificador arbitrario - o Lichess nao exige registro
 * previo de aplicativo.
 */

const AUTHORIZE = "https://lichess.org/oauth";
const TOKEN = "https://lichess.org/api/token";
const EXPLORER = "https://explorer.lichess.ovh/lichess";
const MASTERS = "https://explorer.lichess.ovh/masters";

const CLIENT_ID = "chess-analyzer";
const STORE_TOKEN = "lichess:token";
const STORE_VERIFIER = "lichess:code_verifier";
const STORE_STATE = "lichess:state";

function redirectUri() {
  // Sem query nem hash: precisa bater exatamente com o usado na autorizacao.
  return location.origin + location.pathname;
}

/* ------------------------------------------------------------- PKCE ---- */

function randomString(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

function base64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/* ------------------------------------------------------------ sessao --- */

export function getToken() {
  try {
    return localStorage.getItem(STORE_TOKEN);
  } catch {
    return null;
  }
}

export function isConnected() {
  return !!getToken();
}

export function disconnect() {
  try {
    localStorage.removeItem(STORE_TOKEN);
  } catch { /* modo anonimo */ }
}

/** Manda o visitante para o Lichess autorizar. */
export async function connect() {
  const verifier = randomString();
  const state = randomString(16);
  sessionStorage.setItem(STORE_VERIFIER, verifier);
  sessionStorage.setItem(STORE_STATE, state);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    code_challenge_method: "S256",
    code_challenge: await challengeFor(verifier),
    // Sem scope: o explorador so precisa de um token valido, nenhuma permissao
    // sobre a conta. O Lichess aceita token sem escopo nenhum.
    scope: "",
  });
  location.href = `${AUTHORIZE}?${params}`;
}

/**
 * Completa o fluxo quando o Lichess devolve o visitante para ca.
 * Retorna {status: "conectado"|"nada"|"erro", message?}.
 */
export async function finishLogin() {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const limpar = () => history.replaceState({}, "", redirectUri());

  if (error) {
    limpar();
    return {
      status: "erro",
      message: error === "access_denied"
        ? "Você cancelou a conexão com o Lichess."
        : url.searchParams.get("error_description") || error,
    };
  }
  if (!code) return { status: "nada" };

  const verifier = sessionStorage.getItem(STORE_VERIFIER);
  const expectedState = sessionStorage.getItem(STORE_STATE);
  sessionStorage.removeItem(STORE_VERIFIER);
  sessionStorage.removeItem(STORE_STATE);
  limpar();

  // Defesa contra CSRF: o state de volta tem que ser o que geramos.
  if (!verifier || returnedState !== expectedState) {
    return { status: "erro", message: "A resposta do Lichess não confere. Tente conectar de novo." };
  }

  try {
    const resp = await fetch(TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri(),
        client_id: CLIENT_ID,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.access_token) {
      return { status: "erro", message: data.error_description || "Não consegui obter o token do Lichess." };
    }
    localStorage.setItem(STORE_TOKEN, data.access_token);
    return { status: "conectado" };
  } catch (e) {
    return { status: "erro", message: "Falha de rede ao falar com o Lichess." };
  }
}

/* --------------------------------------------------------- explorador -- */

const cache = new Map();

export class NotConnectedError extends Error {}

/**
 * Estatisticas da posicao: quais lances foram jogados, quantas vezes e com
 * que resultado. `db` pode ser "lichess" (partidas de todo mundo) ou
 * "masters" (partidas de mestres).
 */
export async function explore(fen, { db = "lichess", speeds, ratings, signal } = {}) {
  const token = getToken();
  if (!token) throw new NotConnectedError("Conecte a conta do Lichess para ver o explorador.");

  const params = new URLSearchParams({ fen });
  if (db === "lichess") {
    params.set("speeds", (speeds || ["blitz", "rapid", "classical"]).join(","));
    params.set("ratings", (ratings || [1000, 1200, 1400, 1600, 1800, 2000]).join(","));
  }
  const url = `${db === "masters" ? MASTERS : EXPLORER}?${params}`;

  if (cache.has(url)) return cache.get(url);

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });

  if (resp.status === 401) {
    disconnect();
    throw new NotConnectedError("Sua conexão com o Lichess expirou. Conecte de novo.");
  }
  if (resp.status === 429) {
    throw new Error("O Lichess pediu para esperar um pouco. Tente de novo em alguns segundos.");
  }
  if (!resp.ok) throw new Error(`Explorador respondeu ${resp.status}.`);

  const data = await resp.json();
  const total = (data.white || 0) + (data.draws || 0) + (data.black || 0);

  const resultado = {
    opening: data.opening ? `${data.opening.eco} ${data.opening.name}` : null,
    total,
    white: data.white || 0,
    draws: data.draws || 0,
    black: data.black || 0,
    moves: (data.moves || []).map((m) => {
      const t = (m.white || 0) + (m.draws || 0) + (m.black || 0);
      return {
        san: m.san,
        uci: m.uci,
        games: t,
        share: total ? (t / total) * 100 : 0,
        whitePct: t ? (m.white / t) * 100 : 0,
        drawPct: t ? (m.draws / t) * 100 : 0,
        blackPct: t ? (m.black / t) * 100 : 0,
      };
    }),
  };

  cache.set(url, resultado);
  return resultado;
}
