import { describe, expect, it } from 'vitest';
import { Farm } from './farm';
import { Game } from './game';
import { newInv } from './items';
import type { Inventory } from './items';
import { GATE_IN } from './layout';
import { Worker, pickTask, stepWorker } from './workers';
import type { WorkerCfg, WorkerEnv } from './workers';

function cfg(over: Partial<WorkerCfg> = {}): WorkerCfg {
  return {
    name: 'Teste',
    look: 'tiao',
    hp: 70,
    lv: { plantio: 0, regador: 0, enxada: 0, foice: 0 },
    abilities: [],
    gear: {},
    prios: [['Plantar', true], ['Regar', true], ['Preparar', true], ['Colher', true]],
    inv: { semente: 5, regador: 1, enxada: 1, foice: 1 },
    rest: { x: -1.6, z: 6.6 },
    ...over,
  };
}

function world(store: Partial<Inventory> = {}) {
  const farm = new Farm();
  const s = newInv(store);
  const workers: Worker[] = [];
  const env = (): WorkerEnv => ({
    farm, store: s, clock: 600, seedsTotal: 0, emptyTilled: farm.count('tilled'), storeCap: 2000, rng: () => 0.5, workers,
  });
  return { farm, store: s, env, workers };
}

/** Já dentro da fazenda, pronto para trabalhar. */
function inside(w: Worker, workers: Worker[]): Worker {
  w.pres = 'in';
  w.visible = true;
  w.x = GATE_IN.x + 2;
  w.z = GATE_IN.z;
  w.waypoints = [];
  workers.push(w);
  return w;
}

function run(w: Worker, env: () => WorkerEnv, seconds: number) {
  for (let t = 0; t < seconds; t += 0.1) stepWorker(w, 0.1, env());
}

describe('ordem de buscar item no armazém', () => {
  it('vale antes das tarefas, pega só o que foi pedido e some quando cumprida', () => {
    const { farm, store, env, workers } = world({ pao: 5, semente: 50 });
    farm.at(5, 5)!.state = 'planted';
    farm.at(5, 5)!.age = 5;
    const w = inside(new Worker(cfg({ inv: { foice: 1 } })), workers);
    w.order = { key: 'pao', left: 3 };
    const t = pickTask(w, env())!;
    expect(t.name).toBe('Buscar');
    expect(t.item).toBe('pao');
    run(w, env, 30);
    expect(w.inv.pao).toBe(3);
    expect(store.pao).toBe(2);
    expect(w.order).toBeNull();
    // cumprida: volta ao trabalho normal (colher a planta pronta)
    run(w, env, 120);
    expect(store.batata).toBeGreaterThan(0); // colheu a planta pronta (depois replantou)
  });

  it('desiste sozinho se o armazém não tem o item ou a mochila dele está cheia', () => {
    const empty = world({ pao: 0 });
    const w = inside(new Worker(cfg()), empty.workers);
    w.order = { key: 'pao', left: 3 };
    pickTask(w, empty.env());
    expect(w.order).toBeNull();

    const stocked = world({ pao: 5 });
    const full = inside(new Worker(cfg({ inv: {} })), stocked.workers);
    full.inv.pao = 100; // passa do que ele carrega
    full.order = { key: 'pao', left: 3 };
    pickTask(full, stocked.env());
    expect(full.order).toBeNull();
  });

  it('pega só o que cabe na mochila dele', () => {
    const { store, env, workers } = world({ enxada: 30 });
    const w = inside(new Worker(cfg({ inv: {} })), workers);
    w.order = { key: 'enxada', left: 30 };
    run(w, env, 30);
    expect(w.inv.enxada).toBeGreaterThan(0);
    expect(w.inv.enxada).toBeLessThan(30);
    expect(w.inv.enxada + store.enxada).toBe(30);
    expect(w.inv.enxada * 2).toBeLessThanOrEqual(w.cap + 1e-9);
  });
});

describe('compras vão para o armazém', () => {
  it('a compra entra no armazém; se ele encher, o resto vai para a mochila', () => {
    const g = new Game(() => 0.99);
    g.player.silver = 100000;
    g.store.semente = 0;
    expect(g.room('semente').store).toBeGreaterThan(30000);
    expect(g.buy('semente', 100)).toContain('no armazém');
    expect(g.store.semente).toBe(100);
    // armazém quase cheio: cabem só umas poucas, o resto da compra vai para a mochila
    g.store.semente = 0;
    g.store.pao = 0;
    g.store.batata = Math.floor((2000 - 0.5) / 0.4);
    const r = g.room('semente');
    expect(r.store).toBeGreaterThanOrEqual(5);
    expect(r.store).toBeLessThan(30);
    const bag = g.player.inv.semente;
    g.buy('semente', r.store + 5);
    expect(g.store.semente).toBe(r.store);
    expect(g.player.inv.semente).toBe(bag + 5);
  });

  it('o máximo é o menor entre o que cabe e o que a prata paga; passar disso é recusado', () => {
    const g = new Game(() => 0.99);
    g.player.silver = 23;
    expect(g.maxBuy('semente')).toBe(4); // 5 de prata cada
    expect(g.buy('semente', 5)).toContain('insuficiente');
    g.player.silver = 1e9;
    g.store.batata = Math.floor(2000 / 0.4);
    const cap = g.room('semente').store + g.room('semente').bag;
    expect(g.maxBuy('semente')).toBe(cap);
    expect(g.buy('semente', cap + 1)).toContain('Não cabe');
    expect(g.player.silver).toBe(1e9);
    expect(g.buy('semente', 0)).toContain('inválida');
    expect(g.buy('semente', 1.5)).toContain('inválida');
  });

  it('itens que chegam de fora (mercado, devolução) também vão para o armazém', () => {
    const g = new Game(() => 0.99);
    const before = g.store.pao;
    g.receiveItem('pao', 5);
    expect(g.store.pao).toBe(before + 5);
  });

  it('cozinhar em lote gasta 2 batatas por receita e o resultado cai no armazém', () => {
    const g = new Game(() => 0.99);
    g.player.inv.batata = 3;
    g.store.batata = 7;
    expect(g.maxCook()).toBe(5);
    expect(g.cook(4)).toContain('4');
    expect(g.player.inv.batata).toBe(0); // a mochila vai primeiro
    expect(g.store.batata).toBe(2);
    expect(g.store.assada).toBe(4);
    expect(g.player.inv.assada).toBe(0);
    expect(g.cook(10)).toContain('1'); // pede mais do que dá: faz o que dá
    expect(g.cook(1)).toContain('Precisa');
  });
});
