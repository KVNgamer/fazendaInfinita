import { ABILITIES } from './abilities';
import { EQUIPMENT, SLOTS } from './equipment';
import type { Gear } from './equipment';
import type { TileState } from './farm';
import type { Game } from './game';
import { MAX_WORKERS } from './game';
import { ITEM_KEYS, newInv } from './items';
import type { Inventory } from './items';
import { LANDS, landSize } from './lands';
import type { Rental } from './market';
import type { LandState } from './lands';
import { restSpot } from './layout';
import { placeAtDoor } from './player';
import { DEMO_WORKERS, Worker } from './workers';
import type { TaskName, WorkerCfg } from './workers';

/** Aumente quando o formato mudar de um jeito que o código antigo não entende. As versões 1 (sem terrenos extras) e 2 (trabalhadores fixos) ainda são lidas. */
export const SAVE_VERSION = 3;

export interface SaveWorker {
  name: string;
  /** Quem o trabalhador é. A partir da versão 3 vai para todos, porque qualquer um pode ser vendido ou alugado. */
  cfg?: WorkerCfg;
  rental?: Rental;
  inv: Inventory;
  gear: Gear;
  prios: Array<{ k: TaskName; on: boolean }>;
  energy: number;
  hp: number;
}

export interface SaveData {
  version: number;
  savedAt: number;
  day: number;
  clock: number;
  /** Salvo no modo automático: ao carregar, o jogador sai de casa. */
  wasAuto: boolean;
  hotbar: Array<string | null>;
  selected: number;
  player: {
    x: number;
    z: number;
    yaw: number;
    pitch: number;
    hp: number;
    energy: number;
    silver: number;
    gold: number;
    inv: Inventory;
    gear: Gear;
    gearInv: string[];
    levels: { enxada: number; regador: number; foice: number; plantio: number };
  };
  store: Inventory;
  lands: LandState[];
  farm: Array<{ s: TileState; a: number; w: boolean; d: number; c: boolean }>;
  workers: SaveWorker[];
}

export function serialize(g: Game): SaveData {
  const p = g.player;
  return {
    version: SAVE_VERSION,
    savedAt: Date.now(),
    day: g.day,
    clock: g.clock,
    wasAuto: g.mode === 'spec',
    hotbar: [...g.hotbar],
    selected: g.selected,
    player: {
      x: p.x, z: p.z, yaw: p.yaw, pitch: p.pitch, hp: p.hp, energy: p.energy, silver: p.silver, gold: p.gold,
      inv: { ...p.inv }, gear: { ...p.gear }, gearInv: [...p.gearInv], levels: { ...p.levels },
    },
    store: { ...g.store },
    lands: g.lands.map((l) => ({ ...l })),
    farm: g.farm.tiles.map((t) => ({ s: t.state, a: t.age, w: t.wet, d: t.dry, c: t.careful })),
    workers: g.workers.map((w) => ({
      name: w.name,
      cfg: { ...w.cfg, name: w.name },
      rental: w.rental ?? undefined,
      inv: { ...w.inv },
      gear: { ...w.gear },
      prios: w.prios.map((x) => ({ k: x.k, on: x.on })),
      energy: w.energy,
      hp: w.hp,
    })),
  };
}

// ---------- leitura com validação: um save estragado nunca derruba o jogo ----------

type Json = Record<string, unknown>;

function isObj(x: unknown): x is Json {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function num(x: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  return typeof x === 'number' && Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : fallback;
}

function readInv(x: unknown): Inventory {
  const inv = newInv();
  if (!isObj(x)) return inv;
  for (const k of ITEM_KEYS) inv[k] = Math.floor(num(x[k], 0, 0, 1e6));
  return inv;
}

function readGear(x: unknown): Gear {
  const gear: Gear = { chapeu: null, camisa: null, bolsa: null, calca: null, sapato: null };
  if (!isObj(x)) return gear;
  for (const slot of SLOTS) {
    const id = x[slot];
    if (typeof id === 'string' && EQUIPMENT[id]?.slot === slot) gear[slot] = id;
  }
  return gear;
}

function readRental(x: unknown): Rental | null {
  if (!isObj(x) || typeof x.owner !== 'string' || x.owner.length > 20) return null;
  const currency = x.currency === 'gold' ? 'gold' : 'silver';
  const id = num(x.id, -1, 0, 2 ** 31);
  if (id < 0) return null;
  return { id: Math.floor(id), owner: x.owner, daysLeft: Math.floor(num(x.daysLeft, 0, 0, 14)), pricePerDay: Math.floor(num(x.pricePerDay, 0, 0, 1e7)), currency };
}

const TASKS: readonly TaskName[] = ['Plantar', 'Regar', 'Preparar', 'Colher'];
const STATES: readonly TileState[] = ['raw', 'tilled', 'planted'];

/** Trabalhador vindo de uma caixa: confere os campos e refaz o lugar de descanso. */
function readCfg(x: unknown, index: number): WorkerCfg | null {
  if (!isObj(x) || typeof x.name !== 'string' || !x.name || x.name.length > 30) return null;
  const lv = isObj(x.lv) ? x.lv : {};
  return {
    name: x.name,
    look: typeof x.look === 'string' ? x.look.slice(0, 12) : 'v1',
    hp: num(x.hp, 70, 30, 200),
    lv: { plantio: num(lv.plantio, 0, 0, 100), regador: num(lv.regador, 0, 0, 100), enxada: num(lv.enxada, 0, 0, 100), foice: num(lv.foice, 0, 0, 100) },
    abilities: Array.isArray(x.abilities) ? x.abilities.filter((id): id is string => typeof id === 'string' && !!ABILITIES[id]).slice(0, 3) : [],
    gear: {},
    prios: TASKS.map((k) => [k, true] as const),
    inv: {},
    rest: restSpot(index),
  };
}

/** Aplica o save ao jogo. Devolve false (sem mexer em nada) se os dados não servirem. */
export function restore(g: Game, raw: unknown): boolean {
  if (!isObj(raw) || (raw.version !== 1 && raw.version !== 2 && raw.version !== 3)) return false;
  if (!isObj(raw.player) || !Array.isArray(raw.farm)) return false;

  // quantos terrenos estão comprados (sempre os primeiros, pois se compra na ordem)
  let owned = 1;
  if (raw.version !== 1) {
    if (!Array.isArray(raw.lands) || !isObj(raw.lands[0]) || raw.lands[0].owned !== true) return false;
    owned = 0;
    while (owned < LANDS.length && isObj(raw.lands[owned]) && (raw.lands[owned] as Json).owned === true) owned++;
  }
  let expected = 0;
  for (let i = 0; i < owned; i++) expected += landSize(LANDS[i]);
  if (raw.farm.length !== expected) return false;
  const rp = raw.player;
  const farm = raw.farm;

  // tudo validado: a partir daqui só escrevemos
  g.farm.reset();
  for (let i = 1; i < owned; i++) g.farm.addLand(i);
  g.lands = LANDS.map((_, i) => ({ owned: i < owned, locked: false, debt: 0 }));
  if (raw.version !== 1) {
    const saved = raw.lands as unknown[];
    for (let i = 1; i < owned; i++) {
      const s = isObj(saved[i]) ? (saved[i] as Json) : {};
      g.lands[i].locked = s.locked === true;
      g.lands[i].debt = Math.floor(num(s.debt, 0, 0, 1e9));
      if (g.lands[i].locked) g.farm.setLocked(i, true);
    }
  }
  farm.forEach((f, i) => {
    const t = g.farm.tiles[i];
    const o = isObj(f) ? f : {};
    t.state = STATES.includes(o.s as TileState) ? (o.s as TileState) : 'raw';
    t.age = Math.floor(num(o.a, 0, 0, 5));
    t.wet = o.w === true;
    t.dry = Math.floor(num(o.d, 0, 0, 10));
    t.careful = o.c === true;
    t.reserved = null;
  });

  const p = g.player;
  p.x = num(rp.x, p.x, -100, 100);
  p.z = num(rp.z, p.z, -100, 100);
  p.yaw = num(rp.yaw, p.yaw);
  p.pitch = num(rp.pitch, 0, -1.3, 1.3);
  p.silver = Math.floor(num(rp.silver, p.silver, 0, 1e9));
  p.gold = Math.floor(num(rp.gold, 0, 0, 1e9));
  p.inv = readInv(rp.inv);
  p.gear = readGear(rp.gear);
  p.gearInv = Array.isArray(rp.gearInv) ? rp.gearInv.filter((id): id is string => typeof id === 'string' && !!EQUIPMENT[id]) : [];
  const lv = isObj(rp.levels) ? rp.levels : {};
  p.levels = {
    enxada: num(lv.enxada, 0, 0, 100),
    regador: num(lv.regador, 0, 0, 100),
    foice: num(lv.foice, 0, 0, 100),
    plantio: num(lv.plantio, 0, 0, 100),
  };
  g.refreshStats();
  p.hp = num(rp.hp, g.stats.maxHp, 0, g.stats.maxHp);
  p.energy = num(rp.energy, g.stats.maxEnergy, 0, g.stats.maxEnergy);

  g.store = readInv(raw.store);
  g.day = Math.floor(num(raw.day, 1, 1, 1e6));
  g.clock = num(raw.clock, g.clock, 360, 1560);
  g.speed = 1;
  g.mode = 'fp';
  if (raw.wasAuto === true) placeAtDoor(p);

  if (Array.isArray(raw.hotbar)) {
    g.hotbar = g.hotbar.map((_, i) => {
      const k = (raw.hotbar as unknown[])[i];
      return typeof k === 'string' && (ITEM_KEYS as readonly string[]).includes(k) ? (k as (typeof ITEM_KEYS)[number]) : null;
    });
  }
  g.selected = Math.floor(num(raw.selected, 0, 0, g.hotbar.length - 1));

  // trabalhadores: nas versões 1 e 2 os da demo sempre existem; na 3 a lista salva é a verdade (pode ter vendido todos)
  g.workers = raw.version === 3 ? [] : DEMO_WORKERS.map((c) => new Worker(c));
  if (Array.isArray(raw.workers)) {
    for (const rw of raw.workers) {
      if (!isObj(rw)) continue;
      let w = raw.version === 3 ? undefined : g.workers.find((x) => x.name === rw.name);
      if (!w) {
        if (g.workers.length >= MAX_WORKERS) continue;
        const cfg = readCfg(rw.cfg, g.workers.length);
        if (!cfg || g.workers.some((x) => x.name === cfg.name)) continue;
        w = new Worker(cfg);
        w.rental = readRental(rw.rental);
        g.workers.push(w);
      }
      w.inv = readInv(rw.inv);
      w.gear = readGear(rw.gear);
      w.refreshStats();
      if (Array.isArray(rw.prios)) {
        const saved = rw.prios.filter((x): x is Json => isObj(x) && TASKS.includes(x.k as TaskName));
        const order = saved.map((x) => x.k as TaskName);
        // cobre qualquer tarefa que faltar, para a lista ter sempre as quatro
        for (const k of TASKS) if (!order.includes(k)) order.push(k);
        w.prios = order.map((k) => ({ k, on: saved.find((x) => x.k === k)?.on !== false }));
      }
      // volta a chegar pelo portão no horário de trabalho
      w.sleep();
      w.energy = num(rw.energy, w.maxEnergy, 0, w.maxEnergy);
      w.hp = num(rw.hp, w.maxHp, 0, w.maxHp);
    }
  }
  return true;
}
