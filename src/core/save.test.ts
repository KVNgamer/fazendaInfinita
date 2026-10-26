import { describe, expect, it } from 'vitest';
import { Game } from './game';
import { SAVE_VERSION, restore, serialize } from './save';
import type { MoveInput } from './player';

const NO_MOVE: MoveInput = { f: 0, b: 0, l: 0, r: 0, tl: 0, tr: 0 };

function game() {
  return new Game(() => 0.99);
}

/** Passa pelo JSON, como acontece no localStorage. */
function roundTrip(g: Game): unknown {
  return JSON.parse(JSON.stringify(serialize(g)));
}

describe('salvar e carregar', () => {
  it('guarda a fazenda, o jogador, o armazém e os trabalhadores', () => {
    const a = game();
    a.farm.at(5, 5)!.state = 'planted';
    a.farm.at(5, 5)!.age = 3;
    a.farm.at(5, 5)!.wet = true;
    a.farm.at(6, 5)!.state = 'tilled';
    a.player.silver = 777;
    a.player.levels.enxada = 12.5;
    a.player.inv.batata = 4;
    a.equip('bota_couro');
    a.store.assada = 3;
    a.day = 5;
    a.clock = 700;
    a.hotbar[7] = 'regador';
    a.selected = 3;
    a.workers[0].inv.semente = 3;
    a.workers[0].prios[0].on = false;
    a.workers[0].prios.reverse();
    a.workers[1].gear.sapato = 'bota_corrida';
    a.workers[1].refreshStats();
    a.workers[1].energy = 33;

    const b = game();
    expect(restore(b, roundTrip(a))).toBe(true);

    expect(b.farm.at(5, 5)).toMatchObject({ state: 'planted', age: 3, wet: true });
    expect(b.farm.at(6, 5)!.state).toBe('tilled');
    expect(b.player.silver).toBe(777);
    expect(b.player.levels.enxada).toBe(12.5);
    expect(b.player.inv.batata).toBe(4);
    expect(b.player.gear.sapato).toBe('bota_couro');
    expect(b.stats.speed).toBe(58);
    expect(b.store.assada).toBe(3);
    expect(b.day).toBe(5);
    expect(b.clock).toBe(700);
    expect(b.hotbar[7]).toBe('regador');
    expect(b.selected).toBe(3);
    expect(b.workers[0].inv.semente).toBe(3);
    expect(b.workers[0].prios.map((p) => p.k)).toEqual(a.workers[0].prios.map((p) => p.k));
    expect(b.workers[0].prios.find((p) => p.k === 'Plantar')!.on).toBe(false);
    expect(b.workers[1].stats.speed).toBeCloseTo((50 + 16) * 1.15);
    expect(b.workers[1].energy).toBe(33);
  });

  it('o jogo carregado continua funcionando (trabalhadores voltam pelo portão)', () => {
    const a = game();
    a.enterAuto();
    a.setSpeed(15);
    for (let k = 0; k < 20; k++) a.step(1, NO_MOVE);
    const b = game();
    restore(b, roundTrip(a));
    expect(b.mode).toBe('fp');
    expect(b.workers.every((w) => w.pres === 'away')).toBe(true);
    b.enterAuto();
    b.setSpeed(15);
    for (let k = 0; k < 400 && b.day === a.day; k++) b.step(1, NO_MOVE);
    expect(b.day).toBe(a.day + 1);
  });

  it('salvo no modo automático volta com o jogador na frente de casa', () => {
    const a = game();
    a.enterAuto();
    a.player.x = 10;
    const b = game();
    restore(b, roundTrip(a));
    expect(b.mode).toBe('fp');
    expect(b.player.x).toBeCloseTo(-0.9);
  });

  it('save com versão errada ou formato estranho é recusado sem mexer no jogo', () => {
    const g = game();
    g.player.silver = 123;
    expect(restore(g, null)).toBe(false);
    expect(restore(g, 'oi')).toBe(false);
    expect(restore(g, { version: SAVE_VERSION + 1 })).toBe(false);
    expect(restore(g, { version: SAVE_VERSION, farm: [], player: {} })).toBe(false);
    expect(g.player.silver).toBe(123);
  });

  it('corrige valores absurdos em vez de quebrar', () => {
    const a = game();
    const data = roundTrip(a) as any;
    data.player.silver = -50;
    data.player.energy = 99999;
    data.player.levels.foice = 500;
    data.player.gear.chapeu = 'coisa_que_nao_existe';
    data.player.gear.sapato = 'chapeu_palha'; // peça no espaço errado
    data.player.inv.batata = 'muitas';
    data.farm[0] = { s: 'planta_estranha', a: 99, w: 1, d: -4, c: 'sim' };
    data.hotbar[0] = 'item_inventado';
    data.clock = 99999;
    const b = game();
    expect(restore(b, data)).toBe(true);
    expect(b.player.silver).toBe(0);
    expect(b.player.energy).toBe(b.stats.maxEnergy);
    expect(b.player.levels.foice).toBe(100);
    expect(b.player.gear.chapeu).toBeNull();
    expect(b.player.gear.sapato).toBeNull();
    expect(b.player.inv.batata).toBe(0);
    expect(b.farm.tiles[0]).toMatchObject({ state: 'raw', age: 5, wet: false, dry: 0, careful: false });
    expect(b.hotbar[0]).toBeNull();
    expect(b.clock).toBe(1560);
  });

  it('save de trabalhador sem alguma tarefa ainda fica com as quatro', () => {
    const a = game();
    const data = roundTrip(a) as any;
    data.workers[0].prios = [{ k: 'Colher', on: true }];
    const b = game();
    restore(b, data);
    expect(b.workers[0].prios.map((p) => p.k)).toEqual(['Colher', 'Plantar', 'Regar', 'Preparar']);
  });

  it('avisa quando um novo dia começa', () => {
    const g = game();
    let calls = 0;
    g.onDayEnd = () => calls++;
    g.endDay('sleep');
    expect(calls).toBe(1);
  });
});

describe('salvar terrenos, ouro e trabalhadores de caixa', () => {
  it('guarda terrenos comprados, bloqueio e dívida, e refaz os solos', () => {
    const a = game();
    a.player.silver = 1e6;
    a.buyLand();
    a.buyLand();
    a.farm.at(12, 4)!.state = 'planted';
    a.farm.at(12, 4)!.age = 4;
    a.lands[2].locked = true;
    a.lands[2].debt = 90;
    a.farm.setLocked(2, true);
    a.player.gold = 7;

    const b = game();
    expect(restore(b, roundTrip(a))).toBe(true);
    expect(b.farm.tiles.length).toBe(200);
    expect(b.farm.at(12, 4)).toMatchObject({ state: 'planted', age: 4, land: 1, locked: false });
    expect(b.lands[1]).toMatchObject({ owned: true, locked: false });
    expect(b.lands[2]).toMatchObject({ owned: true, locked: true, debt: 90 });
    expect(b.farm.at(5, 12)!.locked).toBe(true);
    expect(b.lands[3].owned).toBe(false);
    expect(b.player.gold).toBe(7);
    expect(b.bounds).toEqual(a.bounds);
  });

  it('guarda o trabalhador vindo de caixa com tudo que ele tem', () => {
    let calls = 0;
    const a = new Game(() => [0.96, 0, 0.5][Math.min(calls++, 2)]);
    a.player.silver = 300;
    a.openBox('prata');
    const novo = a.workers[a.workers.length - 1];
    novo.inv.enxada = 1;
    novo.gear.sapato = 'bota_couro';
    novo.refreshStats();
    novo.prios.reverse();
    const abilities = [...novo.abilities];

    const b = game();
    restore(b, roundTrip(a));
    expect(b.workers.length).toBe(a.workers.length);
    const w = b.workers[b.workers.length - 1];
    expect(w.name).toBe(novo.name);
    expect(w.abilities).toEqual(abilities);
    expect(w.inv.enxada).toBe(1);
    expect(w.gear.sapato).toBe('bota_couro');
    expect(w.prios.map((p) => p.k)).toEqual(novo.prios.map((p) => p.k));
    expect(w.lv).toEqual(novo.lv);
  });

  it('lê um save da versão 1 (antes dos terrenos): fica só com o terreno inicial', () => {
    const a = game();
    a.player.silver = 321;
    const data = roundTrip(a) as any;
    data.version = 1;
    delete data.lands;
    delete data.player.gold;
    for (const w of data.workers) delete w.cfg;
    const b = game();
    expect(restore(b, data)).toBe(true);
    expect(b.player.silver).toBe(321);
    expect(b.player.gold).toBe(0);
    expect(b.lands.filter((l) => l.owned).length).toBe(1);
    expect(b.farm.tiles.length).toBe(100);
  });

  it('recusa save cujo número de solos não bate com os terrenos', () => {
    const a = game();
    const data = roundTrip(a) as any;
    data.lands[1].owned = true; // diz que comprou, mas só há 100 solos
    expect(restore(game(), data)).toBe(false);
  });

  it('ignora trabalhador de caixa com dados inválidos', () => {
    const a = game();
    const data = roundTrip(a) as any;
    data.workers.push({ name: 'Fantasma', cfg: { name: 42 }, inv: {}, gear: {}, prios: [], energy: 1, hp: 1 });
    const b = game();
    expect(restore(b, data)).toBe(true);
    expect(b.workers.length).toBe(3);
  });
});
