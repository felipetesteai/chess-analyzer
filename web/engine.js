/* Stockfish 18 rodando no navegador via WebAssembly.
 *
 * Mesma conversa UCI do app local (app/engine.py), so que em vez de um processo
 * o engine e um Web Worker. As analises entram numa fila: o UCI so aceita um
 * `go` por vez.
 */

const MT_BUILD = "vendor/stockfish/stockfish-18-lite.js";
const ST_BUILD = "vendor/stockfish/stockfish-18-lite-single.js";

// O build multi-thread precisa de SharedArrayBuffer, que so existe com os
// cabecalhos COOP/COEP (ver _headers). Sem eles caimos no single-thread.
export const canUseThreads = typeof SharedArrayBuffer !== "undefined";

export class Engine {
  constructor() {
    this.worker = null;
    this.queue = [];
    this.current = null;
    this.lines = [];
    this.name = "Stockfish";
    this.threads = 1;
  }

  /**
   * Sobe o engine. Tenta o build multi-thread e, se ele nao subir, cai no
   * single-thread: o multi-thread depende de SharedArrayBuffer + workers
   * aninhados, que nem todo navegador ou contexto permite.
   */
  async start() {
    if (canUseThreads) {
      const threads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
      try {
        await this._boot(MT_BUILD, threads);
        return this;
      } catch {
        this._teardown();
      }
    }
    await this._boot(ST_BUILD, 1);
    return this;
  }

  async _boot(build, threads) {
    this.worker = new Worker(build);
    this.worker.onmessage = (ev) => this._onLine(String(ev.data ?? ""));
    this.worker.onerror = (ev) => {
      ev.preventDefault?.();
      this._failAll(new Error(`worker falhou: ${ev.message || build}`));
    };

    await this._command("uci", "uciok", (line) => {
      if (line.startsWith("id name")) this.name = line.slice(8).trim();
    });
    this.threads = threads;
    this.send(`setoption name Threads value ${threads}`);
    this.send("setoption name Hash value 32");
    await this._command("isready", "readyok");
  }

  _failAll(err) {
    const pending = this.current ? [this.current, ...this.queue] : [...this.queue];
    this.current = null;
    this.queue = [];
    for (const task of pending) task.reject(err);
  }

  _teardown() {
    if (!this.worker) return;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.worker = null;
    this.current = null;
    this.queue = [];
  }

  send(cmd) {
    this.worker.postMessage(cmd);
  }

  _onLine(line) {
    if (!this.current) return;
    this.current.lines.push(line);
    if (this.current.sniff) this.current.sniff(line);
    if (line.startsWith(this.current.until)) {
      const task = this.current;
      this.current = null;
      task.resolve(task.lines);
      this._drain();
    }
  }

  _command(cmd, until, sniff) {
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, until, sniff, lines: [], resolve, reject });
      this._drain();
    });
  }

  _drain() {
    if (this.current || !this.queue.length) return;
    this.current = this.queue.shift();
    this.send(this.current.cmd);
  }

  /** Analisa uma posicao e devolve as `multipv` melhores linhas. */
  async analyse(fen, { depth = 12, multipv = 2 } = {}) {
    this.send(`setoption name MultiPV value ${multipv}`);
    this.send(`position fen ${fen}`);
    const lines = await this._command(`go depth ${depth}`, "bestmove");
    return parseInfo(lines);
  }

  quit() {
    if (!this.worker) return;
    try {
      this.send("quit");
    } catch {
      /* worker ja pode ter morrido */
    }
    this._teardown();
  }
}

/** Le as linhas `info ... multipv N ... score ... pv ...` do UCI. */
function parseInfo(lines) {
  const byPv = new Map();

  for (const line of lines) {
    if (!line.startsWith("info ")) continue;
    const tok = line.split(/\s+/);

    const depth = num(tok, "depth");
    if (depth === null) continue;

    const pvIndex = num(tok, "multipv") ?? 1;

    let cp = null;
    let mate = null;
    const si = tok.indexOf("score");
    if (si !== -1 && si + 2 < tok.length) {
      const value = parseInt(tok[si + 2], 10);
      if (tok[si + 1] === "cp") cp = value;
      else if (tok[si + 1] === "mate") mate = value;
    }

    const pi = tok.indexOf("pv");
    const pv = pi === -1 ? [] : tok.slice(pi + 1);

    byPv.set(pvIndex, { pvIndex, depth, cp, mate, pv });
  }

  return [...byPv.keys()].sort((a, b) => a - b).map((k) => byPv.get(k));
}

function num(tokens, key) {
  const i = tokens.indexOf(key);
  if (i === -1 || i + 1 >= tokens.length) return null;
  const v = parseInt(tokens[i + 1], 10);
  return Number.isNaN(v) ? null : v;
}
