import { describe, expect, it } from 'vitest';
import { Farm } from './farm';
import { newInv } from './items';
import type { Inventory } from './items';
import { ROAD_START } from './layout';
import { RESUME_FRACTION, Worker, pickTask, stepWorker, walkTo } from './workers';
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

function world(store: Partial<Inventory> = {}, clock = 600, rng: () => number = () => 0.5) {
  const farm = new Farm();
  const s = newInv(store);
  const clockRef = { v: clock };
  const workers: Worker[] = [];
  const env = (): WorkerEnv => ({
    farm,
    store: s,
    clock: clockRef.v,
    seedsTotal: 0,
    emptyTilled: farm.count('tilled'),
    storeCap: 2000,
    rng,
    workers,
  });
  return { farm, store: s, envClock: clockRef, env, workers };
}

/** Coloca o trabalhador já dentro da fazenda, pronto para trabalhar. */
function inside(w: Worker, workers?: Worker[]): Worker {
  w.pres = 'in';
  w.visible = true;
  w.waypoints = [];
  w.x = 0;
  w.z = 5;
  workers?.push(w);
  return w;
}

function run(w: Worker, env: () => WorkerEnv, seconds: number) {
  for (let t = 0; t < seconds; t += 0.1) stepWorker(w, 0.1, env());
}

describe('andar', () => {
  it('chega ao destino em um número finito de passos (sem ficar preso por arredondamento)', () => {
    const w = new Worker(cfg());
    w.x = -17;
    w.z = 5;
    let steps = 0;
    while (!walkTo(w, 3.3, 7.7, 0.1, 0.7) && steps < 2000) steps++;
    expect(steps).toBeLessThan(2000);
  });
});

describe('expediente', () => {
  it('só aparece às 08:00 e some depois de sair às 17:00', () => {
    const { env, envClock } = world({}, 400);
    const w = new Worker(cfg());
    stepWorker(w, 0.1, env());
    expect(w.visible).toBe(false);
    envClock.v = 480;
    stepWorker(w, 0.1, env());
    expect(w.visible).toBe(true);
    expect(w.x).toBeGreaterThanOrEqual(ROAD_START.x);
    run(w, env, 20);
    expect(w.pres).toBe('in');
    envClock.v = 1020;
    run(w, env, 60);
    expect(w.pres).toBe('away');
    expect(w.visible).toBe(false);
  });
});

describe('tarefas', () => {
  it('planta em solo cru: ara e planta na mesma tarefa', () => {
    const { farm, env } = world();
    const w = inside(new Worker(cfg()));
    const t = pickTask(w, env())!;
    expect(t.name).toBe('Plantar');
    expect(t.till).toBe(true);
    run(w, env, 60);
    expect(farm.count('planted')).toBeGreaterThan(0);
  });

  it('com a tarefa Preparar desligada ele não ara solo cru', () => {
    const { env } = world();
    const w = inside(new Worker(cfg({ prios: [['Plantar', true], ['Preparar', false]] })));
    expect(pickTask(w, env())).toBeNull();
  });

  it('tarefa desligada nunca é escolhida, mesmo com a ferramenta', () => {
    const { farm, env } = world();
    farm.at(0, 0)!.state = 'tilled';
    const w = inside(new Worker(cfg({ prios: [['Plantar', false], ['Regar', true]] })));
    expect(pickTask(w, env())).toBeNull();
  });

  it('planta pronta é colhida e não regada quando ele pode colher', () => {
    const { farm, env } = world();
    const ready = farm.at(0, 0)!;
    ready.state = 'planted';
    ready.age = 5;
    const w = inside(new Worker(cfg({ prios: [['Regar', true], ['Colher', true]] })));
    expect(pickTask(w, env())!.name).toBe('Colher');
  });

  it('rega primeiro as plantas que ainda não estão prontas', () => {
    const { farm, env } = world();
    const ready = farm.at(0, 0)!;
    ready.state = 'planted';
    ready.age = 5;
    const young = farm.at(9, 9)!;
    young.state = 'planted';
    young.age = 1;
    const w = inside(new Worker(cfg({ prios: [['Regar', true], ['Colher', true]] })));
    const t = pickTask(w, env())!;
    expect(t.name).toBe('Regar');
    expect(t.tile).toBe(young);
  });

  it('sem foice, ele rega a planta pronta', () => {
    const { farm, env } = world();
    const ready = farm.at(0, 0)!;
    ready.state = 'planted';
    ready.age = 5;
    const w = inside(new Worker(cfg({ prios: [['Regar', true], ['Colher', true]], inv: { regador: 1 } })));
    expect(pickTask(w, env())!.name).toBe('Regar');
  });

  it('sem sementes na mochila ele vai buscar no armazém e depois planta', () => {
    const { farm, store, env } = world({ semente: 20 });
    farm.at(5, 5)!.state = 'tilled';
    const w = inside(new Worker(cfg({ inv: { enxada: 1 } })));
    expect(pickTask(w, env())!.name).toBe('Buscar');
    run(w, env, 60);
    expect(w.inv.semente + farm.count('planted')).toBeGreaterThan(0);
    expect(store.semente).toBeLessThan(20);
  });

  it('colheita vai para o armazém', () => {
    const { farm, store, env } = world();
    const t = farm.at(1, 1)!;
    t.state = 'planted';
    t.age = 5;
    const w = inside(new Worker(cfg({ prios: [['Colher', true]] })));
    run(w, env, 30);
    expect(store.batata).toBe(1);
  });
});

describe('energia', () => {
  it('para ao chegar em 15%, descansa recuperando aos poucos e volta com 50%', () => {
    const { farm, env } = world();
    farm.at(1, 1)!.state = 'planted';
    const w = inside(new Worker(cfg({ prios: [['Regar', true]] })));
    w.energy = w.restBelow;
    run(w, env, 1);
    expect(w.resting).toBe(true);
    const before = w.energy;
    run(w, env, 10);
    expect(w.energy).toBeGreaterThan(before);
    expect(w.resting).toBe(true);
    let steps = 0;
    while (w.resting && steps++ < 2000) stepWorker(w, 0.1, env());
    expect(w.resting).toBe(false);
    expect(w.energy).toBeGreaterThanOrEqual(w.maxEnergy * RESUME_FRACTION);
  });

  it('come comida pronta do armazém, mas nunca a colheita', () => {
    const { env, store } = world({ batata: 10, assada: 1 });
    const w = inside(new Worker(cfg({ prios: [] })));
    w.energy = 10;
    run(w, env, 1);
    expect(store.assada).toBe(0);
    expect(store.batata).toBe(10);
    expect(w.energy).toBeGreaterThan(30);
  });

  it('sem comida pronta, a batata crua do armazém fica intacta', () => {
    const { env, store } = world({ batata: 10 });
    const w = inside(new Worker(cfg({ prios: [] })));
    w.energy = 10;
    run(w, env, 5);
    expect(store.batata).toBe(10);
  });

  it('mostra o motivo quando está parado', () => {
    const { env } = world();
    const w = inside(new Worker(cfg({ prios: [['Plantar', true]], inv: { enxada: 1 } })));
    run(w, env, 1);
    expect(w.status).toContain('sem sementes');
  });

  it('parado sem tarefa a energia continua subindo', () => {
    const { env } = world();
    const w = inside(new Worker(cfg({ prios: [['Plantar', true]], inv: { enxada: 1 } })));
    w.energy = 60;
    run(w, env, 10);
    expect(w.status).toContain('sem sementes');
    expect(w.energy).toBeGreaterThan(60);
  });
});

describe('atributos e equipamento do trabalhador', () => {
  it('custo de ação cai com o nível da ferramenta, o equipamento e as habilidades', () => {
    const w = new Worker(cfg({ lv: { plantio: 0, regador: 0, enxada: 100, foice: 0 }, abilities: ['mao_leve'], gear: { calca: 'calca_reforcada' } }));
    expect(w.costOf('Preparar')).toBeCloseTo(8 * 0.5 * (1 - 0.1 - 0.05));
    expect(w.costOf('Regar')).toBeCloseTo(3 * (1 - 0.1 - 0.05));
  });

  it('Terra Fofa só barateia a enxada', () => {
    const w = new Worker(cfg({ abilities: ['terra_fofa'] }));
    expect(w.costOf('Preparar')).toBeCloseTo(8 * 0.85);
    expect(w.costOf('Colher')).toBeCloseTo(5);
  });

  it('velocidade: Pé de Vento e bota somam', () => {
    expect(new Worker(cfg({ abilities: ['pe_de_vento'] })).stats.speed).toBeCloseTo(57.5);
    expect(new Worker(cfg({ abilities: ['pe_de_vento'], gear: { sapato: 'bota_couro' } })).stats.speed).toBeCloseTo(58 * 1.15);
  });

  it('capacidade: base 12, bolsa de pano +8, Costas Fortes +6', () => {
    expect(new Worker(cfg()).cap).toBe(12);
    expect(new Worker(cfg({ gear: { bolsa: 'bolsa_pano' }, abilities: ['costas_fortes'] })).cap).toBe(26);
  });

  it('energia máxima: chapéu +10 e Pavio Longo +20', () => {
    const w = new Worker(cfg({ gear: { chapeu: 'chapeu_palha' }, abilities: ['pavio_longo'] }));
    expect(w.maxEnergy).toBe(130);
    expect(w.energy).toBe(130);
  });

  it('vida máxima: base + camisa', () => {
    expect(new Worker(cfg({ gear: { camisa: 'camisa_linho' } })).maxHp).toBe(80);
  });

  it('trocar a peça recalcula os atributos', () => {
    const w = new Worker(cfg());
    w.gear.sapato = 'bota_corrida';
    w.refreshStats();
    expect(w.stats.speed).toBe(66);
  });
});

describe('habilidades especiais', () => {
  it('Incansável só para com 5% de energia', () => {
    const w = new Worker(cfg({ abilities: ['incansavel'] }));
    expect(w.restBelow).toBeCloseTo(5);
    expect(new Worker(cfg()).restBelow).toBeCloseTo(15);
  });

  it('Sono Leve recupera energia mais rápido', () => {
    const a = world();
    const b = world();
    const normal = inside(new Worker(cfg({ prios: [] })));
    const leve = inside(new Worker(cfg({ prios: [], abilities: ['sono_leve'] })));
    normal.energy = 10;
    leve.energy = 10;
    normal.resting = true;
    leve.resting = true;
    run(normal, a.env, 5);
    run(leve, b.env, 5);
    expect(leve.energy).toBeGreaterThan(normal.energy);
  });

  it('Polegar Verde: com sorteio baixo colhe 2, senão 1', () => {
    for (const [roll, expected] of [[0, 2], [0.99, 1]] as const) {
      const { farm, store, env } = world({}, 600, () => roll);
      const t = farm.at(1, 1)!;
      t.state = 'planted';
      t.age = 5;
      const w = inside(new Worker(cfg({ prios: [['Colher', true]], abilities: ['polegar_verde'] })));
      run(w, env, 30);
      expect(store.batata).toBe(expected);
    }
  });

  it('Chuva Mansa molha 2 solos numa ação', () => {
    const { farm, env } = world();
    farm.at(4, 4)!.state = 'planted';
    farm.at(5, 4)!.state = 'planted';
    const w = inside(new Worker(cfg({ prios: [['Regar', true]], abilities: ['chuva_mansa'] })));
    w.x = 4;
    w.z = 4.7;
    run(w, env, 3);
    expect(farm.at(4, 4)!.wet && farm.at(5, 4)!.wet).toBe(true);
  });

  it('Mão Cuidadosa marca a planta e corta o risco de morrer pela metade', () => {
    const { farm, env } = world();
    const t = farm.at(4, 4)!;
    t.state = 'planted';
    const w = inside(new Worker(cfg({ prios: [['Regar', true]], abilities: ['mao_cuidadosa'] })));
    w.x = 4;
    w.z = 4.7;
    run(w, env, 3);
    expect(t.careful).toBe(true);
    // no dia seguinte sem regar: 10% vira 5%; sorteio de 7% sobrevive
    expect(farm.endDay(() => 0.99)).toBe(0); // regada: cresce
    expect(farm.endDay(() => 0.07)).toBe(0);
    const plain = new Farm();
    plain.at(0, 0)!.state = 'planted';
    expect(plain.endDay(() => 0.07)).toBe(1);
  });

  it('Semeador Ligeiro planta mais rápido', () => {
    function secondsToPlant(abilities: string[]): number {
      const { farm, env } = world();
      farm.at(0, 5)!.state = 'tilled';
      const w = inside(new Worker(cfg({ prios: [['Plantar', true]], abilities })));
      let t = 0;
      while (farm.count('planted') === 0 && t < 60) {
        stepWorker(w, 0.05, env());
        t += 0.05;
      }
      return t;
    }
    expect(secondsToPlant(['semeador_ligeiro'])).toBeLessThan(secondsToPlant([]));
  });

  it('Trabalho em Dupla dá velocidade só com outro trabalhador por perto', () => {
    const { env, workers } = world();
    const a = inside(new Worker(cfg({ abilities: ['trabalho_em_dupla'], prios: [] })), workers);
    stepWorker(a, 0.1, env());
    expect(a.speed).toBeCloseTo(50);
    const b = inside(new Worker(cfg({ prios: [] })), workers);
    b.x = 1;
    stepWorker(a, 0.1, env());
    expect(a.speed).toBeCloseTo(55);
  });
});
