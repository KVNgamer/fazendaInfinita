import { describe, expect, it } from 'vitest';
import { Game } from './game';
import { LANDS, landSize } from './lands';
import { Worker, pickTask } from './workers';
import type { MoveInput } from './player';

const NO_MOVE: MoveInput = { f: 0, b: 0, l: 0, r: 0, tl: 0, tr: 0 };

function game(rng: () => number = () => 0.99) {
  return new Game(rng);
}

describe('terrenos', () => {
  it('o terreno inicial tem 100 solos, é de graça e não cobra aluguel', () => {
    const g = game();
    expect(g.farm.tiles.length).toBe(100);
    expect(LANDS[0].price).toBe(0);
    expect(LANDS[0].rent).toBe(0);
    expect(g.dailyRent()).toBe(0);
  });

  it('cada terreno extra tem 50 solos', () => {
    for (const l of LANDS.slice(1)) expect(landSize(l)).toBe(50);
  });

  it('preço e aluguel crescem uns 50% a cada terreno', () => {
    for (let i = 2; i < LANDS.length; i++) {
      expect(LANDS[i].price / LANDS[i - 1].price).toBeGreaterThan(1.3);
      expect(LANDS[i].price / LANDS[i - 1].price).toBeLessThan(1.7);
      expect(LANDS[i].rent / LANDS[i - 1].rent).toBeGreaterThan(1.3);
      expect(LANDS[i].rent / LANDS[i - 1].rent).toBeLessThan(1.7);
    }
  });

  it('os terrenos não se sobrepõem', () => {
    const seen = new Set<string>();
    for (const l of LANDS) {
      for (let i = l.x0; i <= l.x1; i++) {
        for (let j = l.z0; j <= l.z1; j++) {
          const k = i + ',' + j;
          expect(seen.has(k)).toBe(false);
          seen.add(k);
        }
      }
    }
  });

  it('comprar desconta a prata, cria 50 solos e amplia a cerca', () => {
    const g = game();
    g.player.silver = 2000;
    const before = g.bounds;
    expect(before.x1).toBe(12);
    expect(g.buyLand()).toContain('Terreno 2');
    expect(g.player.silver).toBe(500);
    expect(g.farm.tiles.length).toBe(150);
    expect(g.farm.at(12, 4)).not.toBeNull();
    expect(g.farm.at(12, 4)!.land).toBe(1);
    expect(g.bounds.x1).toBe(17);
    expect(g.bounds.z1).toBe(before.z1);
  });

  it('compra na ordem e recusa sem prata', () => {
    const g = game();
    g.player.silver = 100;
    expect(g.buyLand()).toContain('insuficiente');
    expect(g.farm.tiles.length).toBe(100);
    g.player.silver = 1e6;
    for (let k = 1; k < LANDS.length; k++) g.buyLand();
    expect(g.nextLand()).toBeNull();
    expect(g.buyLand()).toContain('todos');
    expect(g.farm.tiles.length).toBe(100 + 50 * (LANDS.length - 1));
  });

  it('a cerca cresce para o sul quando o terreno vem para o sul', () => {
    const g = game();
    g.player.silver = 1e6;
    g.buyLand();
    g.buyLand();
    expect(g.bounds.z1).toBe(17);
    expect(g.bounds.x1).toBe(17);
  });
});

describe('aluguel', () => {
  it('é cobrado ao dormir, só dos terrenos comprados', () => {
    const g = game();
    g.player.silver = 1500 + 100;
    g.buyLand();
    expect(g.dailyRent()).toBe(30);
    g.endDay('sleep');
    expect(g.player.silver).toBe(70);
    expect(g.message).toContain('Aluguel pago: 30');
  });

  it('sem prata o terreno fica bloqueado e as plantas ficam paradas', () => {
    const g = game(() => 0);
    g.player.silver = 1500;
    g.buyLand();
    const t = g.farm.at(12, 4)!;
    t.state = 'planted';
    t.age = 2;
    t.wet = true;
    g.endDay('sleep');
    expect(g.lands[1].locked).toBe(true);
    expect(g.lands[1].debt).toBe(30);
    expect(t.locked).toBe(true);
    expect(g.message).toContain('bloqueado');
    // rng 0 mataria qualquer planta seca; a bloqueada nem cresce nem morre
    g.endDay('sleep');
    expect(t.state).toBe('planted');
    expect(t.age).toBe(2);
  });

  it('a dívida cresce a cada dia bloqueado e pagar libera o terreno', () => {
    const g = game();
    g.player.silver = 1500;
    g.buyLand();
    g.endDay('sleep');
    g.endDay('sleep');
    g.endDay('sleep');
    expect(g.lands[1].debt).toBe(90);
    g.player.silver = 50;
    expect(g.payDebt(1)).toContain('insuficiente');
    expect(g.lands[1].locked).toBe(true);
    g.player.silver = 200;
    expect(g.payDebt(1)).toContain('paga');
    expect(g.player.silver).toBe(110);
    expect(g.lands[1].locked).toBe(false);
    expect(g.farm.at(12, 4)!.locked).toBe(false);
    // de novo em dia: volta a cobrar o aluguel normal
    g.endDay('sleep');
    expect(g.player.silver).toBe(80);
  });

  it('o terreno inicial nunca é bloqueado, mesmo sem prata', () => {
    const g = game();
    g.player.silver = 0;
    g.endDay('sleep');
    expect(g.lands[0].locked).toBe(false);
  });

  it('o jogador não trabalha em solo bloqueado', () => {
    const g = game();
    g.player.silver = 1500;
    g.buyLand();
    g.endDay('sleep');
    g.player.x = 12 - 1.4;
    g.player.z = 4;
    g.player.yaw = -Math.PI / 2;
    g.selected = 0; // enxada
    g.useSelected();
    expect(g.farm.at(12, 4)!.state).toBe('raw');
    expect(g.message).toContain('bloqueado');
  });

  it('trabalhadores ignoram solo bloqueado', () => {
    const g = game();
    g.player.silver = 1500;
    g.buyLand();
    g.endDay('sleep');
    for (const t of g.farm.tiles) if (t.land === 0) t.reserved = {};
    const w = new Worker({ ...g.workers[0].cfg, prios: [['Preparar', true]], inv: { enxada: 1, semente: 5 } });
    w.pres = 'in';
    w.visible = true;
    w.waypoints = [];
    expect(pickTask(w, g.env)).toBeNull();
  });

  it('a prata cobre mais de um terreno', () => {
    const g = game();
    g.player.silver = 1e6;
    g.buyLand();
    g.buyLand();
    g.player.silver = 1000;
    g.endDay('sleep');
    expect(g.player.silver).toBe(1000 - 30 - 45);
  });

  it('um dia inteiro depois da compra continua funcionando', () => {
    const g = game();
    g.player.silver = 1600;
    g.buyLand();
    g.enterAuto();
    g.setSpeed(15);
    for (let k = 0; k < 400 && g.day === 1; k++) g.step(1, NO_MOVE);
    expect(g.day).toBe(2);
    expect(g.farm.tiles.length).toBe(150);
  });
});
