/**
 * Terrenos. O inicial (100 solos) é de graça e sem aluguel. Cada terreno extra tem 50 solos,
 * custa uns 50% mais que o anterior e cobra aluguel por dia. Compra-se na ordem.
 * Coordenadas em solos, inclusivas.
 */
export interface LandDef {
  index: number;
  name: string;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Preço de compra em prata. */
  price: number;
  /** Aluguel por dia em prata. */
  rent: number;
}

const L = (index: number, x0: number, x1: number, z0: number, z1: number, price: number, rent: number): LandDef => ({
  index,
  name: index === 0 ? 'Terreno inicial' : 'Terreno ' + (index + 1),
  x0, x1, z0, z1, price, rent,
});

export const LANDS: readonly LandDef[] = [
  L(0, 0, 9, 0, 9, 0, 0),
  L(1, 10, 14, 0, 9, 1500, 30),
  L(2, 0, 9, 10, 14, 2250, 45),
  L(3, 15, 19, 0, 9, 3400, 68),
  L(4, 10, 19, 10, 14, 5100, 102),
  L(5, 0, 9, 15, 19, 7600, 153),
  L(6, 10, 19, 15, 19, 11400, 230),
  L(7, 20, 24, 0, 9, 17100, 345),
];

export function landSize(l: LandDef): number {
  return (l.x1 - l.x0 + 1) * (l.z1 - l.z0 + 1);
}

export function landCenter(l: LandDef): { x: number; z: number } {
  return { x: (l.x0 + l.x1) / 2, z: (l.z0 + l.z1) / 2 };
}

export interface LandState {
  owned: boolean;
  /** Aluguel atrasado: o terreno fica parado (plantas não crescem nem morrem) até pagar a dívida. */
  locked: boolean;
  debt: number;
}

export function initialLands(): LandState[] {
  return LANDS.map((_, i) => ({ owned: i === 0, locked: false, debt: 0 }));
}
