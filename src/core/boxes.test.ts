import { describe, expect, it } from 'vitest';
import { ABILITIES } from './abilities';
import { BOXES, GOLD_PRICE_IN_SILVER, RARITIES, generateWorker, rollBox, rollRarity } from './boxes';
import { EQUIPMENT } from './equipment';
import { Game, MAX_WORKERS } from './game';
import { mulberry32 } from './rng';

const REST = { x: -1.6, z: 6.6 };

/** Sorteio com valores combinados: devolve a lista em ordem e depois repete o último. */
function seq(...values: number[]) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

describe('chances das caixas', () => {
  it('somam 100%', () => {
    for (const box of Object.values(BOXES)) {
      expect(RARITIES.reduce((s, r) => s + box.odds[r], 0)).toBeCloseTo(1);
    }
  });

  it('a caixa de ouro é melhor em todas as raridades acima da comum', () => {
    expect(BOXES.ouro.odds.incomum).toBeGreaterThan(BOXES.prata.odds.incomum);
    expect(BOXES.ouro.odds.raro).toBeGreaterThan(BOXES.prata.odds.raro);
    expect(BOXES.ouro.odds.epico).toBeGreaterThan(BOXES.prata.odds.epico);
    expect(BOXES.ouro.workerChance).toBeGreaterThan(BOXES.prata.workerChance);
  });

  it('o sorteio respeita as faixas de cada raridade', () => {
    const o = BOXES.prata.odds;
    expect(rollRarity(() => 0, o)).toBe('comum');
    expect(rollRarity(() => 0.69, o)).toBe('comum');
    expect(rollRarity(() => 0.71, o)).toBe('incomum');
    expect(rollRarity(() => 0.95, o)).toBe('raro');
    expect(rollRarity(() => 0.999, o)).toBe('epico');
  });

  it('em muitos sorteios as frequências ficam perto das chances', () => {
    const rng = mulberry32(42);
    const n = 40000;
    for (const box of Object.values(BOXES)) {
      const count: Record<string, number> = { comum: 0, incomum: 0, raro: 0, epico: 0 };
      for (let i = 0; i < n; i++) count[rollRarity(rng, box.odds)]++;
      for (const r of RARITIES) expect(Math.abs(count[r] / n - box.odds[r])).toBeLessThan(0.01);
    }
  });
});

describe('prêmios', () => {
  it('todas as raridades têm peças de equipamento para sortear', () => {
    for (const r of RARITIES) expect(Object.values(EQUIPMENT).some((e) => e.rarity === r)).toBe(true);
  });

  it('com sorteio alto o prêmio é uma peça da raridade sorteada', () => {
    // 1º valor: raridade (0 = comum); 2º: trabalhador? (0.99 = não); 3º: qual peça
    const r = rollBox(seq(0, 0.99, 0), 'prata', [], REST);
    expect(r.type).toBe('equip');
    if (r.type === 'equip') expect(EQUIPMENT[r.id].rarity).toBe('comum');
  });

  it('com sorteio baixo o prêmio é um trabalhador da raridade sorteada', () => {
    const r = rollBox(seq(0.96, 0.0, 0.5), 'prata', [], REST);
    expect(r.type).toBe('worker');
    expect(r.rarity).toBe('raro');
  });

  it('sem permissão para trabalhador, sai sempre uma peça', () => {
    const r = rollBox(seq(0.5, 0.0, 0.5), 'ouro', [], REST, false);
    expect(r.type).toBe('equip');
  });
});

describe('trabalhador sorteado', () => {
  const ranges = { comum: [60, 70, 5, 35], incomum: [65, 80, 15, 50], raro: [75, 90, 30, 70], epico: [85, 100, 50, 90] } as const;

  it('respeita os limites de vida e de nível de cada raridade', () => {
    const rng = mulberry32(7);
    for (const r of RARITIES) {
      for (let i = 0; i < 200; i++) {
        const w = generateWorker(rng, r, [], REST);
        const [h0, h1, l0, l1] = ranges[r];
        expect(w.hp).toBeGreaterThanOrEqual(h0);
        expect(w.hp).toBeLessThanOrEqual(h1);
        for (const lv of Object.values(w.lv)) {
          expect(lv).toBeGreaterThanOrEqual(l0);
          expect(lv).toBeLessThanOrEqual(l1);
        }
      }
    }
  });

  it('quantidade de habilidades: comum 0 a 1, incomum 1, raro 1 a 2, épico 2, sem repetir', () => {
    const rng = mulberry32(9);
    const limits = { comum: [0, 1], incomum: [1, 1], raro: [1, 2], epico: [2, 2] } as const;
    for (const r of RARITIES) {
      for (let i = 0; i < 200; i++) {
        const w = generateWorker(rng, r, [], REST);
        expect(w.abilities.length).toBeGreaterThanOrEqual(limits[r][0]);
        expect(w.abilities.length).toBeLessThanOrEqual(limits[r][1]);
        expect(new Set(w.abilities).size).toBe(w.abilities.length);
        for (const id of w.abilities) expect(ABILITIES[id]).toBeDefined();
      }
    }
  });

  it('a primeira habilidade de raro e épico é da raridade dele', () => {
    const rng = mulberry32(11);
    for (const r of ['raro', 'epico'] as const) {
      for (let i = 0; i < 100; i++) {
        const w = generateWorker(rng, r, [], REST);
        expect(ABILITIES[w.abilities[0]].rarity).toBe(r);
      }
    }
  });

  it('nasce sem equipamento e sem ferramentas, com todas as tarefas ligadas', () => {
    const w = generateWorker(mulberry32(3), 'incomum', [], REST);
    expect(w.gear).toEqual({});
    expect(w.inv).toEqual({});
    expect(w.prios.every(([, on]) => on)).toBe(true);
    expect(w.prios.map(([k]) => k)).toEqual(['Plantar', 'Regar', 'Preparar', 'Colher']);
  });

  it('nunca repete o nome de quem já trabalha na fazenda', () => {
    const rng = mulberry32(5);
    const taken: string[] = [];
    for (let i = 0; i < 40; i++) {
      const w = generateWorker(rng, 'comum', taken, REST);
      expect(taken.includes(w.name)).toBe(false);
      taken.push(w.name);
    }
  });
});

describe('ouro e abertura no jogo', () => {
  it('câmbio: troca prata por ouro', () => {
    const g = new Game(() => 0.5);
    g.player.silver = GOLD_PRICE_IN_SILVER * 2 + 10;
    expect(g.buyGold(2)).toContain('2 de ouro');
    expect(g.player.gold).toBe(2);
    expect(g.player.silver).toBe(10);
    expect(g.buyGold(1)).toContain('insuficiente');
  });

  it('abrir caixa de prata cobra a prata e entrega o prêmio', () => {
    const g = new Game(seq(0, 0.99, 0));
    g.player.silver = 400;
    const pieces = g.player.gearInv.length;
    const r = g.openBox('prata');
    expect(r.result?.type).toBe('equip');
    expect(g.player.silver).toBe(100);
    expect(g.player.gearInv.length).toBe(pieces + 1);
  });

  it('abrir caixa de ouro cobra o ouro; sem ouro não abre', () => {
    const g = new Game(seq(0, 0.99, 0));
    expect(g.openBox('ouro').result).toBeNull();
    g.player.gold = 6;
    g.openBox('ouro');
    expect(g.player.gold).toBe(1);
  });

  it('trabalhador sorteado entra na fazenda com lugar de descanso próprio', () => {
    const g = new Game(seq(0.96, 0, 0.5));
    g.player.silver = 300;
    const before = g.workers.length;
    const r = g.openBox('prata');
    expect(r.result?.type).toBe('worker');
    expect(g.workers.length).toBe(before + 1);
    const w = g.workers[g.workers.length - 1];
    expect(w.rest).not.toEqual(g.workers[0].rest);
    expect(r.message).toContain(w.name);
  });

  it('com a fazenda cheia de trabalhadores só saem peças', () => {
    const g = new Game(seq(0.96, 0, 0.5));
    while (g.workers.length < MAX_WORKERS) g.addWorker({ ...g.workers[0].cfg, name: 'W' + g.workers.length });
    g.player.silver = 300;
    const r = g.openBox('prata');
    expect(r.result?.type).toBe('equip');
    expect(g.workers.length).toBe(MAX_WORKERS);
  });

  it('recomeçar tira os trabalhadores de caixa', () => {
    const g = new Game(seq(0.96, 0, 0.5));
    g.player.silver = 300;
    g.openBox('prata');
    g.reset();
    expect(g.workers.length).toBe(3);
  });
});
