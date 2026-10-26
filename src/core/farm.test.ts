import { describe, expect, it } from 'vitest';
import { Farm, deathChance, stageOf } from './farm';

describe('plantas', () => {
  it('só avançam de estágio quando regadas', () => {
    const f = new Farm();
    const t = f.at(0, 0)!;
    t.state = 'planted';
    f.endDay(() => 0.99);
    expect(t.age).toBe(0);
    t.wet = true;
    f.endDay(() => 0.99);
    expect(t.age).toBe(1);
  });

  it('estágios da batata: semente, plantinha, grande, pronta no dia 6', () => {
    expect([0, 1, 2, 3, 4, 5].map(stageOf)).toEqual([0, 1, 1, 2, 2, 3]);
  });

  it('a chance de morrer sobe 10 pontos por dia seco seguido', () => {
    expect([1, 2, 3, 4, 10, 12].map(deathChance)).toEqual([0.1, 0.2, 0.30000000000000004, 0.4, 1, 1]);
  });

  it('morre no primeiro dia seco com sorteio abaixo de 10%', () => {
    const f = new Farm();
    const t = f.at(1, 1)!;
    t.state = 'planted';
    expect(f.endDay(() => 0.05)).toBe(1);
    expect(t.state).toBe('tilled');
  });

  it('sorteio de 15% sobrevive ao dia 1 (10%) mas morre no dia 2 (20%)', () => {
    const f = new Farm();
    const t = f.at(1, 1)!;
    t.state = 'planted';
    expect(f.endDay(() => 0.15)).toBe(0);
    expect(t.dry).toBe(1);
    expect(f.endDay(() => 0.15)).toBe(1);
  });

  it('regar zera a contagem de dias secos', () => {
    const f = new Farm();
    const t = f.at(2, 2)!;
    t.state = 'planted';
    f.endDay(() => 0.99);
    f.endDay(() => 0.99);
    expect(t.dry).toBe(2);
    t.wet = true;
    f.endDay(() => 0.99);
    expect(t.dry).toBe(0);
  });

  it('no 10º dia seco a morte é certa', () => {
    const f = new Farm();
    const t = f.at(3, 3)!;
    t.state = 'planted';
    let died = 0;
    for (let d = 0; d < 10 && !died; d++) died = f.endDay(() => 0.999);
    expect(died).toBe(1);
  });
});
