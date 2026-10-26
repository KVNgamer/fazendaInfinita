import { ABILITIES } from './abilities';
import { sumMods } from './equipment';
import type { Gear } from './equipment';

export interface BaseStats {
  maxEnergy: number;
  maxHp: number;
  /** Velocidade base: 50. */
  speed: number;
  /** Capacidade da mochila sem bolsa, em kg. */
  carry: number;
}

export const WORKER_BASE = { maxEnergy: 100, speed: 50, carry: 12 };
export const PLAYER_BASE: BaseStats = { maxEnergy: 100, maxHp: 100, speed: 50, carry: 12 };

/** Atributos finais: base + equipamento + habilidades especiais. */
export interface Stats {
  maxEnergy: number;
  maxHp: number;
  speed: number;
  carry: number;
  /** Fração somada ao custo de todas as ações (−0,15 = 15% menos energia). */
  costMod: number;
  hoeCostMod: number;
  restMult: number;
  /** Para de trabalhar abaixo desta fração da energia máxima. */
  restBelowPct: number;
  plantSpeedPct: number;
  harvestDouble: number;
  waterExtra: boolean;
  careful: boolean;
  duoSpeedPct: number;
}

export function computeStats(base: BaseStats, gear: Gear, abilityIds: readonly string[]): Stats {
  const g = sumMods(gear);
  const s: Stats = {
    maxEnergy: base.maxEnergy + g.maxEnergy,
    maxHp: base.maxHp + g.maxHp,
    speed: base.speed + g.speed,
    carry: base.carry + g.carry,
    costMod: g.costMod,
    hoeCostMod: 0,
    restMult: 1,
    restBelowPct: 0.15,
    plantSpeedPct: 0,
    harvestDouble: 0,
    waterExtra: false,
    careful: false,
    duoSpeedPct: 0,
  };
  let speedPct = 0;
  for (const id of abilityIds) {
    const e = ABILITIES[id]?.effects;
    if (!e) continue;
    s.costMod += e.costMod ?? 0;
    s.hoeCostMod += e.hoeCostMod ?? 0;
    speedPct += e.speedPct ?? 0;
    s.carry += e.carry ?? 0;
    s.maxEnergy += e.maxEnergy ?? 0;
    s.restMult += e.restMult ?? 0;
    if (e.restBelowPct !== undefined) s.restBelowPct = Math.min(s.restBelowPct, e.restBelowPct);
    s.plantSpeedPct += e.plantSpeedPct ?? 0;
    s.harvestDouble += e.harvestDouble ?? 0;
    s.waterExtra ||= !!e.waterExtra;
    s.careful ||= !!e.careful;
    s.duoSpeedPct += e.duoSpeedPct ?? 0;
  }
  s.speed *= 1 + speedPct;
  return s;
}

/** Energia gasta numa ação: custo base reduzido pelo nível (0 a 100) e pelos modificadores. */
export function actionCost(base: number, level: number, mod: number): number {
  return base * (1 - level / 200) * (1 + mod);
}
