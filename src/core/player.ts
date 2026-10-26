import { BLOCKS, SPAWN } from './layout';
import type { Bounds } from './layout';
import { newGear } from './equipment';
import type { Gear } from './equipment';
import { newInv } from './items';
import type { Inventory } from './items';
import { PLAYER_BASE, computeStats } from './stats';
import type { Stats } from './stats';

/** Níveis de ferramenta do jogador, de 0 a 100. Começam em 0 e sobem com o uso. */
export interface ToolLevels {
  enxada: number;
  regador: number;
  foice: number;
  plantio: number;
}

export interface Player {
  x: number;
  z: number;
  yaw: number;
  pitch: number;
  hp: number;
  energy: number;
  silver: number;
  /** Ouro: moeda rara, usada nas melhores caixas. */
  gold: number;
  inv: Inventory;
  /** Peças vestidas. */
  gear: Gear;
  /** Peças guardadas na mochila (ids de EQUIPMENT). */
  gearInv: string[];
  levels: ToolLevels;
}

export function newPlayer(): Player {
  return {
    x: SPAWN.x,
    z: SPAWN.z,
    yaw: SPAWN.yaw,
    pitch: 0,
    hp: 100,
    energy: 100,
    silver: 100,
    gold: 0,
    inv: newInv({ enxada: 1, regador: 1, foice: 1, semente: 30 }),
    gear: newGear({ chapeu: 'chapeu_palha', camisa: 'camisa_linho', bolsa: 'bolsa_pano' }),
    gearInv: ['calca_reforcada', 'bota_couro', 'bota_corrida', 'bolsa_couro'],
    levels: { enxada: 0, regador: 0, foice: 0, plantio: 0 },
  };
}

export function playerStats(p: Player): Stats {
  return computeStats(PLAYER_BASE, p.gear, []);
}

export function placeAtDoor(p: Player): void {
  p.x = SPAWN.x;
  p.z = SPAWN.z;
  p.yaw = SPAWN.yaw;
  p.pitch = 0;
}

/** Entrada de movimento: 1 liga, 0 desliga. f/b andam, l/r desviam, tl/tr giram. */
export interface MoveInput {
  f: number;
  b: number;
  l: number;
  r: number;
  tl: number;
  tr: number;
}

/** Velocidade de caminhada com atributo de velocidade 50. */
export const PLAYER_SPEED = 3.4;

/** Andar não gasta energia. O jogador fica dentro da cerca e fora das construções. */
export function movePlayer(p: Player, input: MoveInput, dt: number, speedStat: number, bounds: Bounds): void {
  const forward = input.f - input.b;
  const side = input.r - input.l;
  p.yaw += (input.tl - input.tr) * 1.9 * dt;
  if (!forward && !side) return;
  const fx = -Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  const rx = Math.cos(p.yaw);
  const rz = -Math.sin(p.yaw);
  const vx = fx * forward + rx * side;
  const vz = fz * forward + rz * side;
  const len = Math.hypot(vx, vz) || 1;
  const speed = PLAYER_SPEED * (speedStat / 50);
  p.x += (vx / len) * speed * dt;
  p.z += (vz / len) * speed * dt;
  p.x = Math.max(bounds.x0 + 0.6, Math.min(bounds.x1 - 0.6, p.x));
  p.z = Math.max(bounds.z0 + 0.6, Math.min(bounds.z1 - 0.6, p.z));
  for (const [x0, x1, z0, z1] of BLOCKS) {
    if (p.x > x0 && p.x < x1 && p.z > z0 && p.z < z1) {
      const dl = p.x - x0;
      const dr = x1 - p.x;
      const dtp = p.z - z0;
      const db = z1 - p.z;
      const m = Math.min(dl, dr, dtp, db);
      if (m === dl) p.x = x0;
      else if (m === dr) p.x = x1;
      else if (m === dtp) p.z = z0;
      else p.z = z1;
    }
  }
}
