import { LANDS } from './lands';
import type { Rng } from './rng';

export type TileState = 'raw' | 'tilled' | 'planted';

export interface Tile {
  i: number;
  j: number;
  /** Terreno a que o solo pertence (0 é o inicial). */
  land: number;
  state: TileState;
  /** Dias regados desde o plantio. Pronta para colher com 5 ou mais. */
  age: number;
  wet: boolean;
  /** Dias secos seguidos. */
  dry: number;
  /** Trabalhador que já escolheu este solo. */
  reserved: object | null;
  /** Regada por quem tem Mão Cuidadosa: metade do risco de morrer num dia seco seguinte. */
  careful: boolean;
  /** Terreno com aluguel atrasado: ninguém trabalha nele e nada cresce. */
  locked: boolean;
}

export const READY_AGE = 5;

/** 0 semente, 1 plantinha, 2 planta grande, 3 pronta. */
export function stageOf(age: number): 0 | 1 | 2 | 3 {
  if (age >= READY_AGE) return 3;
  if (age >= 3) return 2;
  if (age >= 1) return 1;
  return 0;
}

/** Chance de a planta morrer na noite, depois de `dry` dias secos seguidos: 10%, 20%, 30%... */
export function deathChance(dry: number): number {
  return Math.min(1, 0.1 * dry);
}

export class Farm {
  /** Todos os solos, na ordem em que os terrenos foram comprados. */
  readonly tiles: Tile[] = [];
  private readonly byPos = new Map<number, Tile>();

  constructor() {
    this.addLand(0);
  }

  private key(i: number, j: number): number {
    return i * 1000 + j;
  }

  at(i: number, j: number): Tile | null {
    return this.byPos.get(this.key(i, j)) ?? null;
  }

  /** Cria os solos de um terreno (crus). Devolve os solos novos. */
  addLand(index: number): Tile[] {
    const l = LANDS[index];
    const added: Tile[] = [];
    for (let i = l.x0; i <= l.x1; i++) {
      for (let j = l.z0; j <= l.z1; j++) {
        const t: Tile = { i, j, land: index, state: 'raw', age: 0, wet: false, dry: 0, reserved: null, careful: false, locked: false };
        this.tiles.push(t);
        this.byPos.set(this.key(i, j), t);
        added.push(t);
      }
    }
    return added;
  }

  hasLand(index: number): boolean {
    return this.tiles.some((t) => t.land === index);
  }

  setLocked(land: number, locked: boolean): void {
    for (const t of this.tiles) if (t.land === land) t.locked = locked;
  }

  /** Estado de partida da demo: só o terreno inicial, com 3 fileiras plantadas e uma preparada. */
  reset(): void {
    this.tiles.length = 0;
    this.byPos.clear();
    this.addLand(0);
    for (const t of this.tiles) {
      if (t.j < 3) {
        t.state = 'planted';
        t.age = [5, 3, 1][t.j];
      } else if (t.j === 3) {
        t.state = 'tilled';
      }
    }
  }

  count(state: TileState): number {
    let n = 0;
    for (const t of this.tiles) if (t.state === state) n++;
    return n;
  }

  /** Passa a noite: planta regada cresce e zera os dias secos; seca sorteia a morte. Terrenos bloqueados ficam parados. Devolve quantas morreram. */
  endDay(rng: Rng): number {
    let died = 0;
    for (const t of this.tiles) {
      t.reserved = null;
      if (t.locked) continue;
      if (t.state === 'planted') {
        if (t.wet) {
          t.age++;
          t.dry = 0;
        } else {
          t.dry++;
          if (rng() < deathChance(t.dry) * (t.careful ? 0.5 : 1)) {
            t.state = 'tilled';
            t.age = 0;
            t.dry = 0;
            t.careful = false;
            died++;
          }
        }
      }
      t.wet = false;
    }
    return died;
  }
}
