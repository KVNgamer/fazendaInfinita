/** Posições fixas do mundo, compartilhadas entre as regras e o desenho. Unidade: 1 solo = 1. */

export interface Bounds {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Lado oeste e norte da cerca não mudam; leste e sul crescem com os terrenos. */
export const FENCE_X0 = -9;
export const FENCE_Z0 = -9;
/** Folga entre o último solo e a cerca. */
export const FENCE_MARGIN = 3;

export function fenceBounds(maxX: number, maxZ: number): Bounds {
  return { x0: FENCE_X0, z0: FENCE_Z0, x1: maxX + FENCE_MARGIN, z1: maxZ + FENCE_MARGIN };
}

export const GATE = { z0: 4, z1: 6, z: 5 };

/** Onde o trabalhador aparece no fim da estrada e onde ele entra na fazenda. */
export const ROAD_START = { x: -17, z: 5 };
export const ROAD_END = { x: -18, z: 5 };
export const GATE_IN = { x: -1.2, z: 5 };

export const SPAWN = { x: -0.9, z: 2, yaw: -Math.PI / 2 };

export const HOUSE_POS = { x: -3.5, z: 2 };
export const HOUSE_DOOR = { x: -1.8, z: 2 };
export const STORE_POS = { x: -3.5, z: -2.8 };
export const STORE_DOOR = { x: -1.7, z: -2.8 };
export const SHOP_POS = { x: -5.5, z: 7.2 };
export const SHOP_FRONT = { x: -5.5, z: 6.1 };

/** Retângulos [x0, x1, z0, z1] onde o jogador não entra. */
export const BLOCKS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-5.3, -1.7, 0.2, 3.8],
  [-6.9, -4.1, 6.4, 8.1],
  [-5.1, -1.9, -4.3, -1.3],
];

/** Lugares de descanso dos trabalhadores, ao lado da estrada. */
export function restSpot(index: number): { x: number; z: number } {
  return { x: -1.6 - 1.3 * Math.floor(index / 4), z: 6.6 + 1.1 * (index % 4) };
}
