export type ItemKey = 'enxada' | 'regador' | 'foice' | 'semente' | 'batata' | 'pao' | 'assada';

export const ITEM_KEYS: readonly ItemKey[] = ['enxada', 'regador', 'foice', 'semente', 'batata', 'pao', 'assada'];

export interface ItemDef {
  name: string;
  /** Peso em kg. */
  weight: number;
  /** Itens que se empilham mostram a quantidade na hotbar. */
  stack: boolean;
}

export const ITEMS: Record<ItemKey, ItemDef> = {
  enxada: { name: 'Enxada', weight: 2, stack: false },
  regador: { name: 'Regador', weight: 1.5, stack: false },
  foice: { name: 'Foice', weight: 1, stack: false },
  semente: { name: 'Semente de batata', weight: 0.05, stack: true },
  batata: { name: 'Batata', weight: 0.4, stack: true },
  pao: { name: 'Pão', weight: 0.3, stack: true },
  assada: { name: 'Batata assada', weight: 0.4, stack: true },
};

export type Inventory = Record<ItemKey, number>;

export function newInv(partial: Partial<Inventory> = {}): Inventory {
  const inv = {} as Inventory;
  for (const k of ITEM_KEYS) inv[k] = partial[k] ?? 0;
  return inv;
}

export function invWeight(inv: Inventory): number {
  let w = 0;
  for (const k of ITEM_KEYS) w += inv[k] * ITEMS[k].weight;
  return w;
}

/** Comida: energia e vida devolvidas. O jogador come qualquer uma; trabalhadores só comida pronta. */
export const FOOD: Partial<Record<ItemKey, { energy: number; hp: number }>> = {
  pao: { energy: 30, hp: 10 },
  batata: { energy: 5, hp: 1 },
  assada: { energy: 25, hp: 8 },
};
export const READY_FOOD: readonly ItemKey[] = ['assada', 'pao'];

export const SELL_PRICE: Partial<Record<ItemKey, number>> = { batata: 14 };
export const BUY_PRICE: Partial<Record<ItemKey, number>> = { semente: 5, pao: 10 };

export const STORE_CAP = 2000;

export interface TransferResult {
  moved: number;
  /** Peso livre que havia no destino antes de mover. */
  free: number;
}

/** Move até `amount` unidades, respeitando o limite de peso do destino. */
export function transfer(from: Inventory, to: Inventory, key: ItemKey, amount: number, capTo: number): TransferResult {
  const free = capTo - invWeight(to);
  const moved = Math.max(0, Math.min(amount, from[key], Math.floor((free + 1e-9) / ITEMS[key].weight)));
  from[key] -= moved;
  to[key] += moved;
  return { moved, free };
}
