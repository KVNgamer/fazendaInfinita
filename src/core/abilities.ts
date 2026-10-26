import type { Rarity } from './equipment';

/** Efeitos de uma habilidade especial. Cada campo tem um significado só; somam quando há mais de uma habilidade. */
export interface AbilityEffects {
  /** Todas as ações: −0,10 = 10% menos energia. */
  costMod?: number;
  /** Só a enxada (preparar solo). */
  hoeCostMod?: number;
  /** Velocidade: 0,15 = 15% mais rápido. */
  speedPct?: number;
  carry?: number;
  maxEnergy?: number;
  /** Multiplica a energia recuperada ao descansar. */
  restMult?: number;
  /** Para de trabalhar abaixo desta fração da energia máxima (padrão 15%). */
  restBelowPct?: number;
  /** Plantar mais rápido: 0,25 = 25%. */
  plantSpeedPct?: number;
  /** Chance de colher 2 em vez de 1. */
  harvestDouble?: number;
  /** O regador molha mais um solo vizinho por ação. */
  waterExtra?: boolean;
  /** Planta regada por ele tem metade do risco de morrer no dia seco seguinte. */
  careful?: boolean;
  /** Velocidade extra quando há outro trabalhador por perto. */
  duoSpeedPct?: number;
}

export interface AbilityDef {
  id: string;
  name: string;
  desc: string;
  rarity: Rarity;
  effects: AbilityEffects;
}

const LIST: AbilityDef[] = [
  { id: 'mao_leve', name: 'Mão Leve', desc: '−10% de energia em todas as ações', rarity: 'incomum', effects: { costMod: -0.1 } },
  { id: 'pe_de_vento', name: 'Pé de Vento', desc: '+15% de velocidade', rarity: 'comum', effects: { speedPct: 0.15 } },
  { id: 'costas_fortes', name: 'Costas Fortes', desc: '+6 kg de capacidade', rarity: 'comum', effects: { carry: 6 } },
  { id: 'polegar_verde', name: 'Polegar Verde', desc: '8% de chance de colher 2 em vez de 1', rarity: 'raro', effects: { harvestDouble: 0.08 } },
  { id: 'chuva_mansa', name: 'Chuva Mansa', desc: 'O regador molha 2 solos por ação', rarity: 'raro', effects: { waterExtra: true } },
  { id: 'mao_cuidadosa', name: 'Mão Cuidadosa', desc: 'Plantas regadas por ele têm metade do risco de morrer num dia seco seguinte', rarity: 'raro', effects: { careful: true } },
  { id: 'semeador_ligeiro', name: 'Semeador Ligeiro', desc: 'Planta 25% mais rápido', rarity: 'incomum', effects: { plantSpeedPct: 0.25 } },
  { id: 'terra_fofa', name: 'Terra Fofa', desc: 'Enxada gasta 15% menos energia', rarity: 'incomum', effects: { hoeCostMod: -0.15 } },
  { id: 'pavio_longo', name: 'Pavio Longo', desc: '+20 de energia máxima', rarity: 'incomum', effects: { maxEnergy: 20 } },
  { id: 'sono_leve', name: 'Sono Leve', desc: 'Recupera energia 25% mais rápido ao descansar', rarity: 'comum', effects: { restMult: 0.25 } },
  { id: 'trabalho_em_dupla', name: 'Trabalho em Dupla', desc: '+10% de velocidade perto de outro trabalhador', rarity: 'epico', effects: { duoSpeedPct: 0.1 } },
  { id: 'incansavel', name: 'Incansável', desc: 'Só para com 5% de energia', rarity: 'epico', effects: { restBelowPct: 0.05 } },
];

export const ABILITIES: Record<string, AbilityDef> = Object.fromEntries(LIST.map((a) => [a.id, a]));
export const ABILITY_IDS: readonly string[] = LIST.map((a) => a.id);
