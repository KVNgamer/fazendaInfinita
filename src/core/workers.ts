import { WORK_END, WORK_START } from './clock';
import { newGear } from './equipment';
import type { Gear } from './equipment';
import type { Farm, Tile } from './farm';
import { READY_AGE } from './farm';
import { FOOD, ITEMS, READY_FOOD, invWeight, newInv } from './items';
import type { Inventory, ItemKey } from './items';
import { GATE_IN, ROAD_END, ROAD_START, STORE_DOOR } from './layout';
import type { Rental } from './market';
import type { Rng } from './rng';
import { WORKER_BASE, actionCost, computeStats } from './stats';
import type { Stats } from './stats';

export type TaskName = 'Plantar' | 'Regar' | 'Preparar' | 'Colher';
export type ActionName = TaskName | 'Buscar';

export interface Prio {
  k: TaskName;
  on: boolean;
}

export interface WorkerCfg {
  name: string;
  /** Chave da paleta de cores do sprite. */
  look: string;
  /** Vida base, antes do equipamento. */
  hp: number;
  /** Níveis de ferramenta, de 0 a 100. */
  lv: { plantio: number; regador: number; enxada: number; foice: number };
  /** Habilidades especiais (sorteadas, fixas). */
  abilities: readonly string[];
  gear: Partial<Gear>;
  prios: ReadonlyArray<readonly [TaskName, boolean]>;
  inv: Partial<Inventory>;
  rest: { x: number; z: number };
}

export interface Task {
  name: ActionName;
  tile: Tile | null;
  pos: { x: number; z: number } | null;
  /** Plantar em solo cru: ara e planta na mesma tarefa. */
  till: boolean;
  /** O que 'Buscar' pega no armazém (sementes, se faltar). */
  item?: ItemKey;
}

export type Presence = 'away' | 'in' | 'out';

export const TASK_COST: Record<TaskName, number> = { Plantar: 2, Regar: 3, Preparar: 8, Colher: 5 };
export const TASK_NEEDS: Record<TaskName, ItemKey> = { Plantar: 'semente', Regar: 'regador', Preparar: 'enxada', Colher: 'foice' };
export const VERB: Record<ActionName, string> = {
  Plantar: 'plantando',
  Regar: 'regando',
  Preparar: 'preparando o solo',
  Colher: 'colhendo',
  Buscar: 'pegando sementes no armazém',
};

/** Descanso: volta ao trabalho com metade da energia máxima; come comida pronta abaixo de 40%. */
export const RESUME_FRACTION = 0.5;
export const EAT_FRACTION = 0.4;
/** Energia recuperada por segundo de jogo enquanto descansa. */
export const REST_RATE = 0.667;
export const WALK_SPEED = 2.4;
/** Distância em que dois trabalhadores contam como "perto" (Trabalho em Dupla). */
export const DUO_RANGE = 3;

export class Worker {
  readonly cfg: WorkerCfg;
  name: string;
  prios: Prio[] = [];
  inv: Inventory = newInv();
  gear: Gear = newGear();
  abilities: string[] = [];
  stats!: Stats;
  /** Velocidade de agora (com Trabalho em Dupla, se houver outro por perto). */
  speed = 50;
  hp = 0;
  energy = 100;
  resting = false;
  eatT = 0;
  task: Task | null = null;
  phase: 'walk' | 'work' = 'walk';
  t = 0;
  status = 'em casa';
  moving = false;
  pres: Presence = 'away';
  visible = false;
  /** Preenchido quando o trabalhador é alugado de outro jogador. */
  rental: Rental | null = null;
  /** Ordem do jogador: buscar itens no armazém. Vale antes das tarefas e some quando cumprida (não vai para o save). */
  order: { key: ItemKey; left: number } | null = null;
  waypoints: Array<{ x: number; z: number }> = [];
  x = ROAD_START.x;
  z = ROAD_START.z;

  constructor(cfg: WorkerCfg) {
    this.cfg = cfg;
    this.name = cfg.name;
    this.reset();
  }

  get lv() { return this.cfg.lv; }
  get rest() { return this.cfg.rest; }
  get cap(): number { return this.stats.carry; }
  get maxEnergy(): number { return this.stats.maxEnergy; }
  get maxHp(): number { return this.stats.maxHp; }
  get restBelow(): number { return this.stats.maxEnergy * this.stats.restBelowPct; }

  reset(): void {
    this.prios = this.cfg.prios.map(([k, on]) => ({ k, on }));
    this.inv = newInv(this.cfg.inv);
    this.gear = newGear(this.cfg.gear);
    this.abilities = [...this.cfg.abilities];
    this.refreshStats();
    this.hp = this.stats.maxHp;
    this.sleep();
  }

  /** Recalcula os atributos depois de mudar equipamento. */
  refreshStats(): void {
    this.stats = computeStats({ ...WORKER_BASE, maxHp: this.cfg.hp }, this.gear, this.abilities);
    this.speed = this.stats.speed;
    this.energy = Math.min(this.energy, this.stats.maxEnergy);
    this.hp = Math.min(this.hp, this.stats.maxHp);
  }

  /** Fim do dia: volta para casa, descansado. */
  sleep(): void {
    this.energy = this.stats.maxEnergy;
    this.resting = false;
    this.eatT = 0;
    this.task = null;
    this.pres = 'away';
    this.visible = false;
    this.waypoints = [];
    this.moving = false;
    this.status = 'em casa';
    this.x = ROAD_START.x;
    this.z = ROAD_START.z;
  }

  isOn(k: TaskName): boolean {
    return this.prios.some((p) => p.k === k && p.on);
  }

  /** Energia gasta por uma tarefa: base reduzida pelo nível da ferramenta, pelo equipamento e pelas habilidades. */
  costOf(task: TaskName): number {
    const lv = { Plantar: this.lv.plantio, Regar: this.lv.regador, Preparar: this.lv.enxada, Colher: this.lv.foice }[task];
    const mod = this.stats.costMod + (task === 'Preparar' ? this.stats.hoeCostMod : 0);
    return actionCost(TASK_COST[task], lv, mod);
  }
}

/** O que os trabalhadores enxergam do mundo. */
export interface WorkerEnv {
  farm: Farm;
  store: Inventory;
  /** Minutos do dia (06:00 = 360). */
  clock: number;
  /** Sementes de todos (jogador, trabalhadores e armazém). */
  seedsTotal: number;
  /** Solos preparados e ainda vazios. */
  emptyTilled: number;
  storeCap: number;
  rng: Rng;
  workers: readonly Worker[];
}

function nearest(w: Worker, env: WorkerEnv, accept: (t: Tile) => boolean): Tile | null {
  let best: Tile | null = null;
  let bd = Infinity;
  for (const t of env.farm.tiles) {
    if (t.locked || (t.reserved && t.reserved !== w)) continue;
    if (!accept(t)) continue;
    const dx = t.i - w.x;
    const dz = t.j - w.z;
    const d = dx * dx + dz * dz;
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  return best;
}

function canHarvest(w: Worker, env: WorkerEnv): boolean {
  return w.isOn('Colher') && w.inv.foice > 0 && invWeight(env.store) + ITEMS.batata.weight <= env.storeCap;
}

function task(name: ActionName, tile: Tile | null, pos: { x: number; z: number } | null = null, till = false, item?: ItemKey): Task {
  return { name, tile, pos, till, item };
}

/** O que dizer enquanto faz a tarefa. */
function verb(tk: Task): string {
  return tk.name === 'Buscar' && tk.item && tk.item !== 'semente' ? 'pegando ' + ITEMS[tk.item].name.toLowerCase() + ' no armazém' : VERB[tk.name];
}

/** Escolhe a primeira tarefa da lista (ligada) que ele consegue fazer agora. */
export function pickTask(w: Worker, env: WorkerEnv): Task | null {
  // a ordem do jogador vem primeiro; some se não há mais o item no armazém ou lugar na mochila dele
  const o = w.order;
  if (o) {
    const room = Math.floor((w.cap - invWeight(w.inv) + 1e-9) / ITEMS[o.key].weight);
    if (o.left <= 0 || env.store[o.key] <= 0 || room < 1) w.order = null;
    else return task('Buscar', null, STORE_DOOR, false, o.key);
  }
  for (const p of w.prios) {
    if (!p.on) continue;
    switch (p.k) {
      case 'Plantar': {
        const canTill = w.inv.enxada > 0 && w.isOn('Preparar');
        if (w.inv.semente > 0) {
          const tilled = nearest(w, env, (t) => t.state === 'tilled');
          if (tilled) return task('Plantar', tilled);
          // sem solo pronto: ara e planta, ara e planta
          if (canTill) {
            const raw = nearest(w, env, (t) => t.state === 'raw');
            if (raw) return task('Plantar', raw, null, true);
          }
        } else if (env.store.semente > 0 && invWeight(w.inv) + 0.5 <= w.cap) {
          const somewhere = nearest(w, env, (t) => t.state === 'tilled') ?? (canTill ? nearest(w, env, (t) => t.state === 'raw') : null);
          if (somewhere) return task('Buscar', null, STORE_DOOR);
        }
        break;
      }
      case 'Regar': {
        if (w.inv.regador <= 0) break;
        // planta pronta é colhida; só é regada se ele não puder colher
        const harvest = canHarvest(w, env);
        const t = nearest(w, env, (t) => t.state === 'planted' && !t.wet && !(t.age >= READY_AGE && harvest));
        if (t) return task('Regar', t);
        break;
      }
      case 'Preparar': {
        if (w.inv.enxada <= 0 || env.seedsTotal <= env.emptyTilled) break;
        const t = nearest(w, env, (t) => t.state === 'raw');
        if (t) return task('Preparar', t);
        break;
      }
      case 'Colher': {
        if (!canHarvest(w, env)) break;
        const t = nearest(w, env, (t) => t.state === 'planted' && t.age >= READY_AGE);
        if (t) return task('Colher', t);
        break;
      }
    }
  }
  return null;
}

/** Texto que explica por que ele está parado. */
export function idleReason(w: Worker, env: WorkerEnv): string {
  const missing: string[] = [];
  let any = false;
  for (const p of w.prios) {
    if (!p.on) continue;
    any = true;
    if (p.k === 'Plantar') {
      if (w.inv.semente <= 0 && env.store.semente <= 0 && !missing.includes('sementes')) missing.push('sementes');
    } else {
      const need = TASK_NEEDS[p.k];
      const label = need === 'enxada' ? 'enxada' : need === 'regador' ? 'regador' : 'foice';
      if (w.inv[need] <= 0 && !missing.includes(label)) missing.push(label);
    }
  }
  if (!any) return 'parado: todas as tarefas desativadas';
  return missing.length ? 'parado: sem ' + missing.join(', ') : 'parado: nada para fazer agora';
}

/** Anda em direção ao ponto. Devolve true ao chegar. */
export function walkTo(w: Worker, tx: number, tz: number, dt: number, stop: number): boolean {
  const dx = tx - w.x;
  const dz = tz - w.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  // folga de 1 mm: sem ela, o arredondamento deixa o trabalhador a 0,0000001 do destino para sempre
  if (d <= stop + 0.001) {
    w.moving = false;
    return true;
  }
  const s = Math.min(WALK_SPEED * (w.speed / 50) * dt, d - stop);
  w.x += (dx / d) * s;
  w.z += (dz / d) * s;
  w.moving = true;
  return false;
}

function release(w: Worker): void {
  if (w.task?.tile) w.task.tile.reserved = null;
  w.task = null;
}

function eat(w: Worker, env: WorkerEnv): boolean {
  let key: ItemKey | null = null;
  for (const k of READY_FOOD) {
    if (env.store[k] > 0) {
      key = k;
      break;
    }
  }
  if (!key) return false;
  env.store[key]--;
  const food = FOOD[key]!;
  w.energy = Math.min(w.maxEnergy, w.energy + food.energy);
  w.hp = Math.min(w.maxHp, w.hp + food.hp);
  w.eatT = 2;
  w.status = 'comendo ' + ITEMS[key].name.toLowerCase() + ' do armazém';
  return true;
}

function waterNeighbor(w: Worker, t: Tile, env: WorkerEnv): void {
  for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const n = env.farm.at(t.i + di, t.j + dj);
    if (n && !n.locked && n.state === 'planted' && !n.wet && (!n.reserved || n.reserved === w)) {
      n.wet = true;
      n.careful = w.stats.careful;
      return;
    }
  }
}

function perform(w: Worker, tk: Task, env: WorkerEnv): void {
  const t = tk.tile;
  if (tk.name === 'Buscar') {
    const key = tk.item ?? 'semente';
    const ordered = w.order && w.order.key === key ? w.order : null;
    const room = Math.floor((w.cap - invWeight(w.inv) + 1e-9) / ITEMS[key].weight);
    const amount = Math.max(0, Math.min(env.store[key], room, ordered ? ordered.left : 30));
    env.store[key] -= amount;
    w.inv[key] += amount;
    if (ordered) {
      ordered.left -= amount;
      if (ordered.left <= 0 || amount === 0) w.order = null;
    }
    return;
  }
  if (!t) return;
  switch (tk.name) {
    case 'Plantar':
      if (t.state === 'raw' && w.inv.enxada > 0) {
        t.state = 'tilled';
        w.energy -= w.costOf('Preparar');
      }
      if (t.state === 'tilled' && w.inv.semente > 0) {
        w.inv.semente--;
        t.state = 'planted';
        t.age = 0;
        t.wet = false;
        t.dry = 0;
        t.careful = false;
        w.energy -= w.costOf('Plantar');
      }
      break;
    case 'Regar':
      if (t.state === 'planted' && !t.wet) {
        t.wet = true;
        t.careful = w.stats.careful;
        if (w.stats.waterExtra) waterNeighbor(w, t, env);
        w.energy -= w.costOf('Regar');
      }
      break;
    case 'Preparar':
      if (t.state === 'raw') {
        t.state = 'tilled';
        w.energy -= w.costOf('Preparar');
      }
      break;
    case 'Colher':
      if (t.state === 'planted' && t.age >= READY_AGE) {
        t.state = 'tilled';
        t.age = 0;
        t.careful = false;
        env.store.batata += env.rng() < w.stats.harvestDouble ? 2 : 1;
        w.energy -= w.costOf('Colher');
      }
      break;
  }
  w.energy = Math.max(0, w.energy);
}

function nearAnother(w: Worker, env: WorkerEnv): boolean {
  return env.workers.some((o) => o !== w && o.visible && o.pres === 'in' && Math.hypot(o.x - w.x, o.z - w.z) < DUO_RANGE);
}

/** Avança um trabalhador `dt` segundos de jogo. */
export function stepWorker(w: Worker, dt: number, env: WorkerEnv): void {
  if (w.pres === 'away') {
    if (env.clock >= WORK_START && env.clock < WORK_END) {
      w.pres = 'in';
      w.x = ROAD_START.x;
      w.z = ROAD_START.z;
      w.visible = true;
      w.waypoints = [{ x: GATE_IN.x, z: GATE_IN.z }];
      w.task = null;
      w.status = 'chegando pela estrada';
    } else {
      w.visible = false;
      return;
    }
  }
  w.speed = w.stats.speed * (1 + (w.stats.duoSpeedPct && nearAnother(w, env) ? w.stats.duoSpeedPct : 0));
  if (w.pres === 'out') {
    w.status = 'indo embora pela estrada';
    if (w.waypoints.length) {
      if (walkTo(w, w.waypoints[0].x, w.waypoints[0].z, dt, 0.1)) w.waypoints.shift();
    } else {
      w.pres = 'away';
      w.visible = false;
      w.moving = false;
      w.status = 'em casa';
    }
    return;
  }
  if (env.clock >= WORK_END) {
    release(w);
    w.pres = 'out';
    w.waypoints = [{ x: GATE_IN.x, z: GATE_IN.z }, { x: ROAD_END.x, z: ROAD_END.z }];
    return;
  }
  if (w.waypoints.length) {
    w.status = 'chegando pela estrada';
    if (walkTo(w, w.waypoints[0].x, w.waypoints[0].z, dt, 0.1)) w.waypoints.shift();
    return;
  }
  if (w.eatT > 0) {
    w.eatT -= dt;
    w.moving = false;
    return;
  }
  const rate = REST_RATE * w.stats.restMult;
  if (!w.resting && w.energy <= w.restBelow) {
    w.resting = true;
    release(w);
  }
  if (w.resting) {
    w.energy = Math.min(w.maxEnergy, w.energy + rate * dt);
    if (w.energy >= w.maxEnergy * RESUME_FRACTION) {
      w.resting = false;
    } else {
      if (w.energy < w.maxEnergy * EAT_FRACTION && eat(w, env)) return;
      walkTo(w, w.rest.x, w.rest.z, dt, 0.05);
      w.status = 'descansando, energia voltando (' + Math.round((w.energy / w.maxEnergy) * 100) + '%)';
      return;
    }
  }
  if (!w.task) {
    w.task = pickTask(w, env);
    if (!w.task) {
      // parado sem tarefa também descansa: a energia sobe enquanto ele espera
      w.energy = Math.min(w.maxEnergy, w.energy + rate * dt);
      walkTo(w, w.rest.x, w.rest.z, dt, 0.05);
      w.status = idleReason(w, env);
      return;
    }
    if (w.task.tile) w.task.tile.reserved = w;
    w.phase = 'walk';
    w.t = 0;
  }
  const tk = w.task;
  const tx = tk.tile ? tk.tile.i : tk.pos!.x;
  const tz = tk.tile ? tk.tile.j : tk.pos!.z;
  if (w.phase === 'walk') {
    w.status = verb(tk) + ' (indo)';
    if (walkTo(w, tx, tz, dt, tk.tile ? 0.7 : 0.2)) {
      w.phase = 'work';
      w.t = 0;
    }
  } else {
    w.moving = false;
    w.status = verb(tk);
    w.t += dt * (w.speed / 50);
    const duration = (tk.till ? 2.4 : 1.3) / (tk.name === 'Plantar' ? 1 + w.stats.plantSpeedPct : 1);
    if (w.t >= duration) {
      perform(w, tk, env);
      if (tk.tile) tk.tile.reserved = null;
      w.task = null;
    }
  }
}

/** Os trabalhadores da demo. */
export const DEMO_WORKERS: WorkerCfg[] = [
  {
    name: 'Tião',
    look: 'tiao',
    hp: 70,
    lv: { plantio: 55, regador: 40, enxada: 62, foice: 21 },
    abilities: ['mao_leve'],
    gear: { chapeu: 'chapeu_palha', camisa: 'camisa_linho', bolsa: 'bolsa_pano', calca: 'calca_reforcada', sapato: 'bota_couro' },
    prios: [['Plantar', true], ['Regar', true], ['Preparar', true], ['Colher', true]],
    inv: { semente: 10, regador: 1, enxada: 1, foice: 1 },
    rest: { x: -1.6, z: 6.6 },
  },
  {
    name: 'Zeca',
    look: 'zeca',
    hp: 90,
    lv: { plantio: 25, regador: 70, enxada: 30, foice: 45 },
    abilities: ['pe_de_vento'],
    gear: { chapeu: 'chapeu_palha' },
    prios: [['Regar', true], ['Colher', true], ['Plantar', false], ['Preparar', false]],
    inv: { regador: 1, foice: 1 },
    rest: { x: -1.6, z: 7.7 },
  },
  {
    name: 'Cida',
    look: 'cida',
    hp: 85,
    lv: { plantio: 40, regador: 55, enxada: 35, foice: 60 },
    abilities: ['chuva_mansa', 'polegar_verde'],
    gear: { bolsa: 'bolsa_pano', sapato: 'bota_couro' },
    prios: [['Colher', true], ['Regar', true], ['Plantar', false], ['Preparar', false]],
    inv: { regador: 1, foice: 1 },
    rest: { x: -1.6, z: 8.8 },
  },
];
