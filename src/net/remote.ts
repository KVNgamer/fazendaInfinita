import { Game } from '../core/game';
import type { Command, CommandResult, ServerMsg } from './protocol';
import { applyPatch } from './snapshot';
import type { Patch } from './snapshot';

export type Status = 'connecting' | 'online' | 'offline' | 'kicked' | 'auth-failed';

interface Pending {
  resolve: (r: CommandResult) => void;
  reject: (e: Error) => void;
  timer: number;
}

/** Chaves de uma atualização que mudam o que uma janela aberta mostra (o `rt` dos trabalhadores não conta). */
const MODAL_KEYS: ReadonlyArray<keyof Patch> = ['player', 'inv', 'gear', 'gearInv', 'hotbar', 'store', 'lands', 'roster', 'data', 'reset'];

/**
 * A conexão com o servidor e a cópia do jogo que ela mantém. O navegador desenha e anima a cópia,
 * mas toda decisão (plantar, comprar, abrir caixa) é pedida ao servidor e só vale quando ele aceita.
 */
export class Remote {
  /** Cópia do jogo. Quem manda é o servidor. */
  readonly game = new Game();
  status: Status = 'offline';
  user = '';
  onStatus: (status: Status) => void = () => {};
  onWelcome: (fresh: boolean) => void = () => {};
  onSaved: () => void = () => {};
  onChange: () => void = () => {};
  /** Aviso que o servidor mandou por conta própria (fim de dia, amigos, mercado). */
  onNotice: (text: string) => void = (text) => this.game.say(text);
  /** Começou, mudou ou terminou uma visita. */
  onVisit: () => void = () => {};
  /** Algo mudou nos amigos (pedido novo, alguém entrou ou saiu, visita). */
  onSocial: () => void = () => {};
  /** Cópia da fazenda que você está visitando (só assiste), ou null. */
  visit: Game | null = null;
  visitHost = '';
  canHelp = false;

  private ws: WebSocket | null = null;
  private token = '';
  private retry = 0;
  private retryTimer = 0;
  private wanted = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private lastInput = '';
  private lastInputAt = 0;

  private setStatus(s: Status): void {
    this.status = s;
    this.onStatus(s);
  }

  /** Entra com o token da sessão. Se a conexão cair, tenta de novo sozinho. */
  connect(token: string): void {
    this.token = token;
    this.wanted = true;
    this.open();
  }

  disconnect(): void {
    this.wanted = false;
    window.clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
    this.failPending('Desconectado.');
  }

  private open(): void {
    this.setStatus('connecting');
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(scheme + '://' + location.host + '/ws');
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'auth', token: this.token }));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data) as ServerMsg;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failPending('Conexão perdida.');
      if (!this.wanted || this.status === 'kicked' || this.status === 'auth-failed') return;
      this.setStatus('offline');
      this.retry = Math.min(this.retry + 1, 6);
      this.retryTimer = window.setTimeout(() => this.open(), 500 * this.retry);
    };
  }

  private handle(msg: ServerMsg): void {
    const g = this.game;
    switch (msg.t) {
      case 'welcome':
        this.retry = 0;
        this.visit = null;
        this.user = msg.user;
        applyPatch(g, msg.patch);
        this.setStatus('online');
        // se uma janela estava aberta durante a queda, o tempo continua parado no servidor também
        if (g.paused) void this.send({ t: 'paused', value: true }).catch(() => {});
        this.onWelcome(msg.fresh);
        this.onChange();
        break;
      case 'patch': {
        applyPatch(g, msg.patch, { snapDistance: 1 });
        if (MODAL_KEYS.some((k) => msg.patch[k] !== undefined)) this.onChange();
        break;
      }
      case 'visitStart': {
        const v = new Game();
        applyPatch(v, msg.patch, { followPaused: true });
        this.visit = v;
        this.visitHost = msg.host;
        this.canHelp = msg.canHelp;
        this.onVisit();
        break;
      }
      case 'visitPatch':
        if (this.visit) {
          applyPatch(this.visit, msg.patch, { followPaused: true });
          if (msg.canHelp !== this.canHelp) {
            this.canHelp = msg.canHelp;
            this.onVisit();
          }
        }
        break;
      case 'visitEnd':
        this.visit = null;
        this.visitHost = '';
        this.canHelp = false;
        if (msg.reason) g.say(msg.reason);
        this.onVisit();
        break;
      case 'social':
        this.onSocial();
        break;
      case 'result': {
        const p = this.pending.get(msg.id);
        if (p) {
          window.clearTimeout(p.timer);
          this.pending.delete(msg.id);
          p.resolve(msg.result);
        }
        break;
      }
      case 'msg':
        this.onNotice(msg.text);
        break;
      case 'kicked':
        this.wanted = false;
        this.setStatus('kicked');
        g.say(msg.reason);
        break;
      case 'error':
        this.wanted = false;
        this.setStatus('auth-failed');
        break;
    }
  }

  private failPending(reason: string): void {
    for (const p of this.pending.values()) {
      window.clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private raw(m: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  /** Pede uma ação ao servidor. A resposta traz a mensagem para mostrar. */
  send(c: Command): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('O servidor não respondeu.'));
      }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      // o servidor precisa saber para onde você olha ANTES da ação
      this.flushInput(true);
      if (!this.raw({ t: 'cmd', id, c })) {
        window.clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Sem conexão.'));
      }
    });
  }

  private currentInput: { f: number; b: number; l: number; r: number; yaw: number; pitch: number } | null = null;

  /** Guarda o que você está apertando e para onde olha; vai ao servidor a cada 50 ms (ou na hora, antes de uma ação). */
  setInput(move: { f: number; b: number; l: number; r: number }, yaw: number, pitch: number): void {
    this.currentInput = { f: move.f, b: move.b, l: move.l, r: move.r, yaw, pitch };
  }

  flushInput(force = false, now = performance.now()): void {
    const i = this.currentInput;
    if (!i) return;
    const text = JSON.stringify(i);
    if (!force && text === this.lastInput && now - this.lastInputAt < 500) return;
    if (!force && now - this.lastInputAt < 50) return;
    if (this.raw({ t: 'input', ...i })) {
      this.lastInput = text;
      this.lastInputAt = now;
    }
  }
}
