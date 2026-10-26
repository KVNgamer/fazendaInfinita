/**
 * Sincronização: o servidor manda só o que mudou desde a última atualização (`Snapshotter.diff`),
 * e o navegador aplica numa cópia do jogo (`applyPatch`). A cópia nunca decide nada sozinha.
 */
import type { Gear } from '../core/equipment';
import type { Rental } from '../core/market';
import type { Game, Mode } from '../core/game';
import type { Inventory } from '../core/items';
import { LANDS } from '../core/lands';
import type { LandState } from '../core/lands';
import { DEMO_WORKERS, Worker } from '../core/workers';
import type { ActionName, Prio, Presence, WorkerCfg } from '../core/workers';

/** [estado (0 cru, 1 preparado, 2 plantado), idade, regado, dias secos, cuidadosa] */
export type TileTuple = [number, number, number, number, number];

export interface Meta {
  clock: number;
  day: number;
  mode: Mode;
  speed: number;
  /** O tempo do jogo está parado (uma janela aberta). Quem visita acompanha. */
  paused: boolean;
  /** Quem está visitando. */
  visitors: string[];
}

export interface PlayerSnap {
  x: number;
  z: number;
  hp: number;
  energy: number;
  silver: number;
  gold: number;
  levels: { enxada: number; regador: number; foice: number; plantio: number };
}

export interface RosterEntry {
  name: string;
  /** Só trabalhadores vindos de caixas trazem a ficha; os da demo o navegador já conhece. */
  cfg?: WorkerCfg;
  rental?: Rental;
}

export interface WorkerData {
  inv: Inventory;
  gear: Gear;
  prios: Prio[];
}

/** O que o trabalhador está fazendo agora, para a animação do navegador continuar de onde o servidor parou. */
export interface WorkerRt {
  x: number;
  z: number;
  pres: Presence;
  vis: boolean;
  wp: Array<[number, number]>;
  task: { n: ActionName; ti: number; px: number; pz: number; till: boolean } | null;
  phase: 'walk' | 'work';
  t: number;
  energy: number;
  hp: number;
  resting: boolean;
  eatT: number;
  status: string;
  moving: boolean;
  speed: number;
}

export interface Patch {
  /** Recomeço: o navegador zera a cópia antes de aplicar. */
  reset?: boolean;
  /** Slot da hotbar escolhido. Só vai nas atualizações completas: no resto o navegador manda, não recebe. */
  selected?: number;
  meta?: Meta;
  player?: PlayerSnap;
  inv?: Inventory;
  gear?: Gear;
  gearInv?: string[];
  hotbar?: Array<string | null>;
  store?: Inventory;
  lands?: LandState[];
  roster?: RosterEntry[];
  /** [posição na lista de solos, solo] */
  tiles?: Array<[number, TileTuple]>;
  data?: Record<string, WorkerData>;
  /** Na mesma ordem de `roster`. Sempre vai, porque os trabalhadores se mexem a cada instante. */
  rt: WorkerRt[];
}

const STATE_INDEX = { raw: 0, tilled: 1, planted: 2 } as const;
const STATE_NAMES = ['raw', 'tilled', 'planted'] as const;
const DEMO_NAMES = DEMO_WORKERS.map((c) => c.name);

function tileTuple(t: Game['farm']['tiles'][number]): TileTuple {
  return [STATE_INDEX[t.state], t.age, t.wet ? 1 : 0, t.dry, t.careful ? 1 : 0];
}

function workerRt(w: Worker, game: Game): WorkerRt {
  return {
    x: w.x, z: w.z, pres: w.pres, vis: w.visible,
    wp: w.waypoints.map((p) => [p.x, p.z]),
    task: w.task
      ? {
          n: w.task.name,
          ti: w.task.tile ? game.farm.tiles.indexOf(w.task.tile) : -1,
          px: w.task.pos?.x ?? 0,
          pz: w.task.pos?.z ?? 0,
          till: w.task.till,
        }
      : null,
    phase: w.phase, t: w.t, energy: w.energy, hp: w.hp, resting: w.resting, eatT: w.eatT,
    status: w.status, moving: w.moving, speed: w.speed,
  };
}

/**
 * `pub`: a visão de quem visita. Mostra a fazenda (solos, trabalhadores, onde o dono está), mas não a carteira,
 * a mochila, o armazém nem o que cada trabalhador carrega.
 */
function sections(game: Game, pub: boolean): Record<string, unknown> {
  const p = game.player;
  const out: Record<string, unknown> = {
    meta: { clock: game.clock, day: game.day, mode: game.mode, speed: game.speed, paused: game.paused, visitors: [...game.visitors] } satisfies Meta,
    player: (pub
      ? { x: p.x, z: p.z, hp: 0, energy: 0, silver: 0, gold: 0, levels: { enxada: 0, regador: 0, foice: 0, plantio: 0 } }
      : { x: p.x, z: p.z, hp: p.hp, energy: p.energy, silver: p.silver, gold: p.gold, levels: { ...p.levels } }) satisfies PlayerSnap,
    lands: game.lands.map((l) => ({ ...l, debt: pub ? 0 : l.debt })),
    roster: game.workers.map((w) => ({ name: w.name, cfg: DEMO_NAMES.includes(w.name) ? undefined : { ...w.cfg, name: w.name }, rental: w.rental ?? undefined }) satisfies RosterEntry),
  };
  if (!pub) {
    out.inv = { ...p.inv };
    out.gear = { ...p.gear };
    out.gearInv = [...p.gearInv];
    out.hotbar = [...game.hotbar];
    out.store = { ...game.store };
  }
  return out;
}

function workerData(w: Worker): WorkerData {
  return { inv: { ...w.inv }, gear: { ...w.gear }, prios: w.prios.map((p) => ({ k: p.k, on: p.on })) };
}

/** A cada tantas atualizações (100 = uns 10 segundos) o servidor reenvia o jogo inteiro. */
export const RESYNC_EVERY = 100;

/** Guarda o que já foi enviado e calcula só a diferença. Um por jogador conectado. */
export class Snapshotter {
  private last = new Map<string, string>();
  private lastTiles: string[] = [];
  private lastData = new Map<string, string>();
  private roster: string[] = [];
  private calls = 0;

  /** `publicView`: para visitantes (sem carteira, mochila nem armazém). */
  constructor(private readonly publicView = false) {}

  /** Tudo, do zero. Usado ao entrar e ao recomeçar. */
  full(game: Game, reset = false): Patch {
    this.last.clear();
    this.lastTiles = [];
    this.lastData.clear();
    const patch = this.diff(game, true);
    if (reset) {
      patch.reset = true;
      if (!this.publicView) patch.selected = game.selected;
    }
    return patch;
  }

  diff(game: Game, forceAll = false): Patch {
    const names = game.workers.map((w) => w.name);
    const shrunk = game.farm.tiles.length < this.lastTiles.length || this.roster.some((n) => !names.includes(n));
    if (shrunk && !forceAll) return this.full(game, true);
    // de tempos em tempos manda tudo de novo, para a cópia nunca ficar errada por muito tempo
    if (!forceAll && ++this.calls % RESYNC_EVERY === 0) return this.full(game, false);

    const patch: Patch = { rt: game.workers.map((w) => workerRt(w, game)) };
    for (const [key, value] of Object.entries(sections(game, this.publicView))) {
      const text = JSON.stringify(value);
      if (this.last.get(key) !== text) {
        this.last.set(key, text);
        (patch as unknown as Record<string, unknown>)[key] = value;
      }
    }

    const tiles = game.farm.tiles;
    const changed: Array<[number, TileTuple]> = [];
    for (let i = 0; i < tiles.length; i++) {
      const tuple = tileTuple(tiles[i]);
      const text = tuple.join(',');
      if (this.lastTiles[i] !== text) {
        this.lastTiles[i] = text;
        changed.push([i, tuple]);
      }
    }
    if (changed.length) patch.tiles = changed;

    for (const w of this.publicView ? [] : game.workers) {
      const data = workerData(w);
      const text = JSON.stringify(data);
      if (this.lastData.get(w.name) !== text) {
        this.lastData.set(w.name, text);
        (patch.data ??= {})[w.name] = data;
      }
    }
    this.roster = names;
    return patch;
  }
}

// ---------- no navegador ----------

export interface ApplyOptions {
  /** Posição do jogador: se a cópia errou por mais que isso, volta para a do servidor. */
  snapDistance?: number;
  /** Cópia de uma fazenda visitada: segue a pausa do dono. */
  followPaused?: boolean;
}

function ensureWorkers(game: Game, roster: RosterEntry[]): void {
  const next: Worker[] = [];
  for (const entry of roster) {
    let w = game.workers.find((x) => x.name === entry.name);
    if (!w) {
      const cfg = entry.cfg ?? DEMO_WORKERS.find((c) => c.name === entry.name);
      if (!cfg) continue;
      w = new Worker({ ...cfg, name: entry.name });
    }
    w.rental = entry.rental ?? null;
    next.push(w);
  }
  game.workers = next;
}

/** Aplica uma atualização do servidor à cópia do jogo. */
export function applyPatch(game: Game, patch: Patch, opts: ApplyOptions = {}): void {
  if (patch.reset) game.reset(false);
  if (patch.selected !== undefined) game.selected = patch.selected;

  if (patch.meta) {
    game.clock = patch.meta.clock;
    game.day = patch.meta.day;
    game.mode = patch.meta.mode;
    game.speed = patch.meta.speed;
    game.visitors = [...(patch.meta.visitors ?? [])];
    if (opts.followPaused) game.paused = patch.meta.paused;
  }
  if (patch.lands) {
    game.lands = patch.lands.map((l) => ({ ...l }));
    LANDS.forEach((_, i) => {
      if (game.lands[i]?.owned && !game.farm.hasLand(i)) game.farm.addLand(i);
    });
    game.lands.forEach((l, i) => {
      if (l.owned && i > 0) game.farm.setLocked(i, l.locked);
    });
  }
  if (patch.tiles) {
    for (const [i, t] of patch.tiles) {
      const tile = game.farm.tiles[i];
      if (!tile) continue;
      tile.state = STATE_NAMES[t[0]] ?? 'raw';
      tile.age = t[1];
      tile.wet = t[2] === 1;
      tile.dry = t[3];
      tile.careful = t[4] === 1;
    }
  }
  if (patch.roster) ensureWorkers(game, patch.roster);

  const p = game.player;
  if (patch.player) {
    const s = patch.player;
    const far = Math.hypot(p.x - s.x, p.z - s.z) > (opts.snapDistance ?? 0);
    if (far) {
      p.x = s.x;
      p.z = s.z;
    }
    p.hp = s.hp;
    p.energy = s.energy;
    p.silver = s.silver;
    p.gold = s.gold;
    p.levels = { ...s.levels };
  }
  if (patch.inv) p.inv = { ...patch.inv };
  if (patch.gear) p.gear = { ...patch.gear };
  if (patch.gearInv) p.gearInv = [...patch.gearInv];
  if (patch.hotbar) game.hotbar = patch.hotbar.map((k) => (k as Game['hotbar'][number]) ?? null);
  if (patch.store) game.store = { ...patch.store };
  if (patch.inv || patch.gear) game.refreshStats();

  if (patch.data) {
    for (const [name, d] of Object.entries(patch.data)) {
      const w = game.workers.find((x) => x.name === name);
      if (!w) continue;
      w.inv = { ...d.inv };
      w.gear = { ...d.gear };
      w.prios = d.prios.map((x) => ({ k: x.k, on: x.on }));
      w.refreshStats();
    }
  }

  // o que cada trabalhador está fazendo
  patch.rt.forEach((rt, i) => {
    const w = game.workers[i];
    if (!w) return;
    w.x = rt.x;
    w.z = rt.z;
    w.pres = rt.pres;
    w.visible = rt.vis;
    w.waypoints = rt.wp.map(([x, z]) => ({ x, z }));
    w.task = rt.task
      ? { name: rt.task.n, tile: rt.task.ti >= 0 ? (game.farm.tiles[rt.task.ti] ?? null) : null, pos: rt.task.ti >= 0 ? null : { x: rt.task.px, z: rt.task.pz }, till: rt.task.till }
      : null;
    w.phase = rt.phase;
    w.t = rt.t;
    w.energy = rt.energy;
    w.hp = rt.hp;
    w.resting = rt.resting;
    w.eatT = rt.eatT;
    w.status = rt.status;
    w.moving = rt.moving;
    w.speed = rt.speed;
  });
  for (const t of game.farm.tiles) t.reserved = null;
  for (const w of game.workers) if (w.task?.tile) w.task.tile.reserved = w;
}
