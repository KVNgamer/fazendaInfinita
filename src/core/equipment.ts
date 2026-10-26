/** Equipamento: cinco peças que mudam os atributos de quem usa (jogador ou trabalhador). */
export type Slot = 'chapeu' | 'camisa' | 'bolsa' | 'calca' | 'sapato';

export const SLOTS: readonly Slot[] = ['chapeu', 'camisa', 'bolsa', 'calca', 'sapato'];

export const SLOT_NAME: Record<Slot, string> = {
  chapeu: 'Chapéu',
  camisa: 'Camisa',
  bolsa: 'Bolsa',
  calca: 'Calça',
  sapato: 'Sapato',
};

export type Rarity = 'comum' | 'incomum' | 'raro' | 'epico';

export const RARITY_NAME: Record<Rarity, string> = { comum: 'Comum', incomum: 'Incomum', raro: 'Raro', epico: 'Épico' };

/** Bônus somados. speed é em pontos (a base é 50); costMod é fração (−0,05 = 5% menos energia). */
export interface Mods {
  maxEnergy: number;
  maxHp: number;
  carry: number;
  costMod: number;
  speed: number;
}

export const NO_MODS: Mods = { maxEnergy: 0, maxHp: 0, carry: 0, costMod: 0, speed: 0 };

export interface EquipDef {
  id: string;
  name: string;
  slot: Slot;
  rarity: Rarity;
  mods: Partial<Mods>;
  /** Preço em prata no mercado. Sem preço: só sai de caixas (Fase 2). */
  price?: number;
}

const LIST: EquipDef[] = [
  { id: 'chapeu_palha', name: 'Chapéu de palha', slot: 'chapeu', rarity: 'comum', mods: { maxEnergy: 10 }, price: 40 },
  { id: 'chapeu_aba', name: 'Chapéu de aba larga', slot: 'chapeu', rarity: 'incomum', mods: { maxEnergy: 20 } },
  { id: 'camisa_linho', name: 'Camisa de linho', slot: 'camisa', rarity: 'comum', mods: { maxHp: 10 }, price: 50 },
  { id: 'camisa_reforcada', name: 'Camisa reforçada', slot: 'camisa', rarity: 'incomum', mods: { maxHp: 25 } },
  { id: 'bolsa_pano', name: 'Bolsa de pano', slot: 'bolsa', rarity: 'comum', mods: { carry: 8 }, price: 60 },
  { id: 'bolsa_couro', name: 'Bolsa de couro', slot: 'bolsa', rarity: 'incomum', mods: { carry: 14 } },
  { id: 'calca_reforcada', name: 'Calça reforçada', slot: 'calca', rarity: 'comum', mods: { costMod: -0.05 }, price: 70 },
  { id: 'calca_trabalho', name: 'Calça de trabalho', slot: 'calca', rarity: 'incomum', mods: { costMod: -0.08 } },
  { id: 'bota_couro', name: 'Bota de couro', slot: 'sapato', rarity: 'comum', mods: { speed: 8 }, price: 80 },
  { id: 'bota_corrida', name: 'Bota de corrida', slot: 'sapato', rarity: 'raro', mods: { speed: 16 } },
  { id: 'chapeu_explorador', name: 'Chapéu de explorador', slot: 'chapeu', rarity: 'raro', mods: { maxEnergy: 35 } },
  { id: 'camisa_vigor', name: 'Camisa do vigor', slot: 'camisa', rarity: 'raro', mods: { maxHp: 45 } },
  { id: 'bolsa_viajante', name: 'Bolsa de viajante', slot: 'bolsa', rarity: 'raro', mods: { carry: 22 } },
  { id: 'calca_agil', name: 'Calça ágil', slot: 'calca', rarity: 'raro', mods: { costMod: -0.12 } },
  { id: 'chapeu_lendario', name: 'Chapéu lendário', slot: 'chapeu', rarity: 'epico', mods: { maxEnergy: 60 } },
  { id: 'camisa_lendaria', name: 'Camisa lendária', slot: 'camisa', rarity: 'epico', mods: { maxHp: 80 } },
  { id: 'bolsa_sem_fundo', name: 'Bolsa sem fundo', slot: 'bolsa', rarity: 'epico', mods: { carry: 40 } },
  { id: 'calca_mestre', name: 'Calça do mestre', slot: 'calca', rarity: 'epico', mods: { costMod: -0.2 } },
  { id: 'bota_vento', name: 'Bota do vento', slot: 'sapato', rarity: 'epico', mods: { speed: 30 } },
];

export const EQUIPMENT: Record<string, EquipDef> = Object.fromEntries(LIST.map((e) => [e.id, e]));
export const EQUIPMENT_IDS: readonly string[] = LIST.map((e) => e.id);

export type Gear = Record<Slot, string | null>;

export function newGear(partial: Partial<Gear> = {}): Gear {
  return { chapeu: null, camisa: null, bolsa: null, calca: null, sapato: null, ...partial };
}

export function sumMods(gear: Gear): Mods {
  const total = { ...NO_MODS };
  for (const slot of SLOTS) {
    const id = gear[slot];
    if (!id) continue;
    const m = EQUIPMENT[id].mods;
    total.maxEnergy += m.maxEnergy ?? 0;
    total.maxHp += m.maxHp ?? 0;
    total.carry += m.carry ?? 0;
    total.costMod += m.costMod ?? 0;
    total.speed += m.speed ?? 0;
  }
  return total;
}

/** Texto curto dos bônus de uma peça, para a interface. */
export function describeMods(m: Partial<Mods>): string {
  const parts: string[] = [];
  if (m.maxEnergy) parts.push('+' + m.maxEnergy + ' energia máx.');
  if (m.maxHp) parts.push('+' + m.maxHp + ' vida máx.');
  if (m.carry) parts.push('+' + m.carry + ' kg');
  if (m.costMod) parts.push(Math.round(m.costMod * 100) + '% custo de ação');
  if (m.speed) parts.push('+' + m.speed + ' velocidade');
  return parts.join(', ');
}
