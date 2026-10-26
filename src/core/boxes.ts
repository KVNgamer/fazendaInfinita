import { ABILITIES, ABILITY_IDS } from './abilities';
import { EQUIPMENT, EQUIPMENT_IDS } from './equipment';
import type { Rarity } from './equipment';
import type { Rng } from './rng';
import type { WorkerCfg } from './workers';

/** Caixas: sorteio entre equipamentos e trabalhadores. As chances são sempre mostradas ao jogador. */
export type BoxKind = 'prata' | 'ouro';
export type Currency = 'silver' | 'gold';

export const RARITIES: readonly Rarity[] = ['comum', 'incomum', 'raro', 'epico'];

export interface BoxDef {
  kind: BoxKind;
  name: string;
  currency: Currency;
  price: number;
  /** Chance de o prêmio ser um trabalhador (senão é uma peça de equipamento). */
  workerChance: number;
  odds: Record<Rarity, number>;
}

export const BOXES: Record<BoxKind, BoxDef> = {
  prata: { kind: 'prata', name: 'Caixa de prata', currency: 'silver', price: 300, workerChance: 0.15, odds: { comum: 0.7, incomum: 0.24, raro: 0.055, epico: 0.005 } },
  ouro: { kind: 'ouro', name: 'Caixa de ouro', currency: 'gold', price: 5, workerChance: 0.35, odds: { comum: 0.4, incomum: 0.38, raro: 0.17, epico: 0.05 } },
};

/** Câmbio provisório: quanto custa 1 de ouro, em prata. No mercado entre jogadores o preço será livre. */
export const GOLD_PRICE_IN_SILVER = 250;

export type BoxResult =
  | { type: 'equip'; id: string; rarity: Rarity }
  | { type: 'worker'; rarity: Rarity; cfg: WorkerCfg };

export function rollRarity(rng: Rng, odds: Record<Rarity, number>): Rarity {
  let r = rng();
  for (const k of RARITIES) {
    r -= odds[k];
    if (r < 0) return k;
  }
  return RARITIES[RARITIES.length - 1];
}

function pick<T>(rng: Rng, list: readonly T[]): T {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

function between(rng: Rng, a: number, b: number): number {
  return Math.round(a + rng() * (b - a));
}

const NAMES = ['Nando', 'Zé', 'Bia', 'Lúcia', 'Chico', 'Dora', 'Tonho', 'Rita', 'Beto', 'Nena', 'Juca', 'Mané', 'Tica', 'Gui', 'Cacá', 'Dudu', 'Lia', 'Raul', 'Vera', 'Tato'];
export const LOOKS = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8'];

const HP: Record<Rarity, [number, number]> = { comum: [60, 70], incomum: [65, 80], raro: [75, 90], epico: [85, 100] };
const LEVELS: Record<Rarity, [number, number]> = { comum: [5, 35], incomum: [15, 50], raro: [30, 70], epico: [50, 90] };
const RANK: Record<Rarity, number> = { comum: 0, incomum: 1, raro: 2, epico: 3 };

/** Quantas habilidades: comum 0 a 1, incomum 1, raro 1 a 2, épico 2. */
function abilityCount(rng: Rng, rarity: Rarity): number {
  switch (rarity) {
    case 'comum': return rng() < 0.5 ? 0 : 1;
    case 'incomum': return 1;
    case 'raro': return rng() < 0.5 ? 1 : 2;
    default: return 2;
  }
}

function rollAbilities(rng: Rng, rarity: Rarity): string[] {
  const count = abilityCount(rng, rarity);
  const exact = ABILITY_IDS.filter((id) => ABILITIES[id].rarity === rarity);
  const upTo = ABILITY_IDS.filter((id) => RANK[ABILITIES[id].rarity] <= RANK[rarity]);
  const chosen: string[] = [];
  for (let n = 0; n < count; n++) {
    // a primeira habilidade é da raridade do trabalhador; as outras, de qualquer raridade até ela
    const pool = (n === 0 && exact.length ? exact : upTo).filter((id) => !chosen.includes(id));
    if (!pool.length) break;
    chosen.push(pick(rng, pool));
  }
  return chosen;
}

/** Cria um trabalhador sorteado. `rest` é o lugar de descanso dele, ao lado da estrada. */
export function generateWorker(rng: Rng, rarity: Rarity, taken: readonly string[], rest: { x: number; z: number }): WorkerCfg {
  const free = NAMES.filter((n) => !taken.includes(n));
  let name = free.length ? pick(rng, free) : pick(rng, NAMES);
  for (let n = 2; taken.includes(name); n++) name = name.replace(/ \d+$/, '') + ' ' + n;
  const [l0, l1] = LEVELS[rarity];
  return {
    name,
    look: pick(rng, LOOKS),
    hp: between(rng, ...HP[rarity]),
    lv: { plantio: between(rng, l0, l1), regador: between(rng, l0, l1), enxada: between(rng, l0, l1), foice: between(rng, l0, l1) },
    abilities: rollAbilities(rng, rarity),
    gear: {},
    prios: [['Plantar', true], ['Regar', true], ['Preparar', true], ['Colher', true]],
    inv: {},
    rest,
  };
}

/** Abre uma caixa. `taken` são os nomes já usados; `rest` o lugar de descanso se sair um trabalhador. */
export function rollBox(rng: Rng, kind: BoxKind, taken: readonly string[], rest: { x: number; z: number }, allowWorker = true): BoxResult {
  const box = BOXES[kind];
  const rarity = rollRarity(rng, box.odds);
  if (allowWorker && rng() < box.workerChance) return { type: 'worker', rarity, cfg: generateWorker(rng, rarity, taken, rest) };
  const pool = EQUIPMENT_IDS.filter((id) => EQUIPMENT[id].rarity === rarity);
  return { type: 'equip', id: pick(rng, pool), rarity };
}
