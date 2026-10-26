import { Game } from '../core/game';
import type { MoveInput } from '../core/player';
import type { Rng } from '../core/rng';
import { restore, serialize } from '../core/save';
import type { ClientMsg, ServerMsg } from '../net/protocol';
import { Snapshotter } from '../net/snapshot';
import type { Patch } from '../net/snapshot';
import { MAX_VISITORS } from '../core/social';
import type { Permission } from '../core/social';
import { runCommand } from './commands';
import type { Market, MarketSession } from './market';
import type { Db } from './db';
import type { Social } from './social';
import { Lock } from './lock';

export interface Sink {
  send(msg: ServerMsg): void;
}

export interface SessionOptions {
  rng?: Rng;
  market?: Market;
  social?: Social;
  /** Fila das operações que mexem no banco e no jogo (a mesma para todos os jogadores). */
  lock?: Lock;
  /** Intervalo entre atualizações para o navegador, em segundos. */
  sendEvery?: number;
  /** Intervalo entre salvamentos automáticos, em segundos. */
  saveEvery?: number;
  now?: () => number;
}

/**
 * O jogo de uma pessoa conectada. Existe só enquanto ela está conectada: o relógio da fazenda
 * para quando ela sai, e o estado fica guardado no banco.
 */
/** Uma visita em andamento, do lado do visitante. */
export interface Visit {
  host: GameSession;
  level: Permission;
  water: number;
  harvest: number;
}

/** Ações que mexem em mais de um jogador (ou no banco de vários): esperam a vez na fila de todos. */
const SHARED = new Set<string>([
  'market', 'marketSell', 'marketBuy', 'marketCancel', 'rentRecall', 'reset',
  'social', 'friendRequest', 'friendAnswer', 'friendRemove', 'friendBlock', 'friendUnblock', 'friendPerm', 'visit', 'leaveVisit', 'help',
]);

export class GameSession implements MarketSession {
  readonly game: Game;
  private readonly snap = new Snapshotter();
  private readonly input: MoveInput = { f: 0, b: 0, l: 0, r: 0, tl: 0, tr: 0 };
  private sinceSend = 0;
  private sinceSave = 0;
  /** Primeiro login desta conta (ainda não há save). */
  readonly fresh: boolean;
  private closed = false;
  readonly lock: Lock;
  /** Enquanto o mercado muda o jogo e o banco, o relógio desta pessoa espera (milissegundos). */
  private frozen = 0;
  /** As ações de uma pessoa entram uma depois da outra. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Os salvamentos de uma pessoa chegam ao banco na ordem em que foram tirados. */
  private writeChain: Promise<unknown> = Promise.resolve();
  /** O que já está no banco: se o jogo não mudou desde então, salvar de novo não faz nada. */
  private lastSaved = '';
  /** Fazenda que esta pessoa está visitando. Enquanto visita, o jogo dela fica parado. */
  visiting: Visit | null = null;
  /** Quem está visitando esta fazenda, com a visão pública que cada um recebe. */
  private readonly visitors = new Map<number, { session: GameSession; snap: Snapshotter }>();

  constructor(
    readonly userId: number,
    readonly username: string,
    savedJson: string | null,
    private readonly db: Db,
    private readonly sink: Sink,
    private readonly opts: SessionOptions = {},
  ) {
    this.game = new Game(opts.rng ?? Math.random);
    this.fresh = savedJson === null;
    this.lock = opts.lock ?? new Lock();
    if (savedJson) {
      try {
        restore(this.game, JSON.parse(savedJson));
      } catch {
        // save ilegível: segue com o jogo novo, sem apagar o que está no banco
        this.game.reset(false);
      }
    }
    // o fim do dia salva (em segundo plano) e, se há trabalhador alugado, paga os aluguéis na fila
    this.game.onDayEnd = () => {
      if (this.game.workers.some((w) => w.rental)) {
        void this.lock
          .run(async () => {
            await this.opts.market?.rentalDay(this);
            await this.saveNow();
          })
          .catch((e) => console.error('Falha no fim do dia de', this.username, (e as Error).message));
      } else {
        this.save();
      }
    };
    this.game.onMessage = (text) => this.sink.send({ t: 'msg', text });
  }

  get visitorCount(): number {
    return this.visitors.size;
  }

  get visitorNames(): string[] {
    return [...this.visitors.values()].map((v) => v.session.username);
  }

  get visitorSessions(): GameSession[] {
    return [...this.visitors.values()].map((v) => v.session);
  }

  /** Recebe um visitante. Devolve o jogo inteiro na visão pública, para ele começar a assistir. */
  addVisitor(v: GameSession): Patch {
    if (this.visitors.size >= MAX_VISITORS) throw new Error('fazenda cheia');
    const snap = new Snapshotter(true);
    this.visitors.set(v.userId, { session: v, snap });
    this.game.visitors = this.visitorNames;
    return snap.full(this.game, true);
  }

  removeVisitor(v: GameSession): void {
    this.visitors.delete(v.userId);
    this.game.visitors = this.visitorNames;
  }

  /** Esta pessoa começou a visitar `host`. */
  async startVisit(host: GameSession, level: Permission, patch: Patch): Promise<void> {
    this.visiting = { host, level, water: 0, harvest: 0 };
    await this.saveNow();
    this.sink.send({ t: 'visitStart', host: host.username, canHelp: level >= 2, patch });
  }

  async endVisit(reason: string): Promise<void> {
    this.visiting = null;
    await this.saveNow();
    this.sink.send({ t: 'visitEnd', reason });
  }

  /** Atualização do jogo do dono para o visitante. */
  sendVisitPatch(patch: Patch, canHelp: boolean): void {
    this.sink.send({ t: 'visitPatch', patch, canHelp });
  }

  /** A tela de amigos deve se atualizar. */
  pokeSocial(): void {
    this.sink.send({ t: 'social' });
  }

  /** Um aviso para esta pessoa (vai como mensagem do jogo). */
  notify(text: string): void {
    this.game.say(text);
  }

  /** Primeira mensagem ao navegador: o jogo inteiro. */
  start(): void {
    this.sink.send({ t: 'welcome', user: this.username, fresh: this.fresh, patch: this.snap.full(this.game, true) });
  }

  /** O mercado vai mexer no jogo e no banco: o relógio espera até acabar. Devolve a função que libera. */
  freeze(): () => void {
    this.frozen++;
    let done = false;
    return () => {
      if (!done) {
        done = true;
        this.frozen--;
      }
    };
  }

  /** Uma mensagem do navegador. As ações esperam a vez na fila; devolve quando terminou. */
  onMessage(msg: ClientMsg): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (msg.t === 'input') {
      // visitando, o seu jogo está parado: ninguém anda
      if (this.visiting) return Promise.resolve();
      this.input.f = msg.f;
      this.input.b = msg.b;
      this.input.l = msg.l;
      this.input.r = msg.r;
      const p = this.game.player;
      p.yaw = msg.yaw;
      p.pitch = Math.max(-1.3, Math.min(1.3, msg.pitch));
      return Promise.resolve();
    }
    if (msg.t !== 'cmd') return Promise.resolve();
    // as ações de quem joga entram na ordem; só as que envolvem outras pessoas esperam a fila de todos
    const run = this.chain.then(() => (SHARED.has(msg.c.t) ? this.lock.run(() => this.execute(msg)) : this.execute(msg)));
    this.chain = run.catch(() => {});
    return run;
  }

  private async execute(msg: Extract<ClientMsg, { t: 'cmd' }>): Promise<void> {
    if (this.closed) return;
    const result = await runCommand(this.game, msg.c, {
      save: () => this.saveNow(),
      market: this.opts.market,
      social: this.opts.social,
      session: this,
    });
    this.sink.send({ t: 'result', id: msg.id, result });
    // recomeçar troca o jogo todo: manda tudo de novo
    if (result.ok && msg.c.t === 'reset') {
      await this.saveNow();
      this.sink.send({ t: 'patch', patch: this.snap.full(this.game, true) });
    }
  }

  /** Avança o jogo `dt` segundos e manda as diferenças ao navegador a cada `sendEvery`. */
  tick(dt: number): void {
    if (this.closed || this.frozen > 0) return;
    const step = Math.min(dt, 0.25);
    // visitando, o relógio do seu jogo para (só passa o tempo da fazenda que você olha)
    if (!this.visiting) this.game.step(step, this.input);
    this.sinceSend += step;
    this.sinceSave += step;
    if (this.sinceSend >= (this.opts.sendEvery ?? 0.1)) {
      this.sinceSend = 0;
      if (!this.visiting) this.sink.send({ t: 'patch', patch: this.snap.diff(this.game) });
      for (const v of this.visitors.values()) {
        v.session.sendVisitPatch(v.snap.diff(this.game), (v.session.visiting?.level ?? 0) >= 2);
      }
    }
    if (this.sinceSave >= (this.opts.saveEvery ?? 60)) this.save();
  }

  /** Salva em segundo plano: o jogo não espera o banco. Só grava se algo mudou desde o último salvamento. */
  save(): void {
    this.sinceSave = 0;
    void this.saveNow();
  }

  /**
   * Tira a foto do jogo agora (instantâneo) e a envia ao banco, na ordem. Devolve quando o banco confirmou.
   * Quem chama pode esperar sem travar o relógio: o jogo continua enquanto o banco responde.
   */
  async saveNow(): Promise<boolean> {
    const snapshot = serialize(this.game);
    // a hora do salvamento (savedAt) muda sempre: não conta para saber se o jogo mudou
    const fingerprint = JSON.stringify({ ...snapshot, savedAt: 0 });
    if (fingerprint === this.lastSaved) return true;
    const json = JSON.stringify(snapshot);
    const stamp = (this.opts.now ?? Date.now)();
    const write = this.writeChain.then(() => this.db.writeSave(this.userId, json, stamp));
    this.writeChain = write.catch(() => {});
    try {
      await write;
      this.lastSaved = fingerprint;
      this.sinceSave = 0;
      return true;
    } catch (e) {
      console.error('Falha ao salvar o jogo de', this.username, (e as Error).message);
      return false;
    }
  }

  /** A pessoa saiu: salva e para o relógio da fazenda dela. Só dentro da fila. */
  async close(): Promise<void> {
    if (this.closed) return;
    // quem visitava volta para casa; se esta pessoa visitava alguém, sai da visita
    await this.opts.social?.ejectAll(this);
    await this.opts.social?.leave(this, '');
    await this.chain.catch(() => {});
    await this.saveNow();
    this.closed = true;
  }
}
