import { describe, expect, it } from 'vitest';
import { Game } from './game';
import { invWeight, newInv, transfer } from './items';
import { FAINT_AT } from './clock';
import type { MoveInput } from './player';

const NO_MOVE: MoveInput = { f: 0, b: 0, l: 0, r: 0, tl: 0, tr: 0 };

function game() {
  return new Game(() => 0.99);
}

/** Posiciona o jogador olhando para um solo a 1,4 de distância. */
function faceTile(g: Game, i: number, j: number) {
  g.player.x = i - 1.4;
  g.player.z = j;
  g.player.yaw = -Math.PI / 2;
}

describe('jogador', () => {
  it('começa com energia e vida cheias, contando o equipamento', () => {
    const g = game();
    expect(g.stats.maxEnergy).toBe(110); // chapéu de palha
    expect(g.stats.maxHp).toBe(110); // camisa de linho
    expect(g.player.energy).toBe(110);
    expect(g.player.hp).toBe(110);
    expect(g.carryCap).toBe(20); // bolsa de pano
  });

  it('andar não gasta energia', () => {
    const g = game();
    for (let k = 0; k < 100; k++) g.step(0.1, { ...NO_MOVE, f: 1 });
    expect(g.player.energy).toBe(g.stats.maxEnergy);
  });

  it('não sai da cerca', () => {
    const g = game();
    g.player.yaw = Math.PI / 2;
    for (let k = 0; k < 600; k++) g.step(0.1, { ...NO_MOVE, f: 1 });
    expect(g.player.x).toBeGreaterThanOrEqual(-9);
  });

  it('usar ferramenta gasta energia; sem energia não trabalha', () => {
    const g = game();
    faceTile(g, 5, 5);
    g.selected = 0; // enxada
    const before = g.player.energy;
    g.useSelected();
    expect(g.farm.at(5, 5)!.state).toBe('tilled');
    expect(g.player.energy).toBe(before - 8);
    g.player.energy = 2;
    faceTile(g, 6, 5);
    g.useSelected();
    expect(g.farm.at(6, 5)!.state).toBe('raw');
  });

  it('comer devolve energia e vida', () => {
    const g = game();
    g.player.energy = 40;
    g.player.hp = 50;
    g.player.inv.pao = 1;
    g.selected = 5; // pão
    g.useSelected();
    expect(g.player.energy).toBe(70);
    expect(g.player.hp).toBe(60);
  });

  it('colhe só planta pronta e respeita o peso da mochila', () => {
    const g = game();
    faceTile(g, 0, 0); // fileira 0 já pronta
    g.selected = 2; // foice
    g.useSelected();
    expect(g.player.inv.batata).toBe(1);
    expect(g.farm.at(0, 0)!.state).toBe('tilled');
    g.player.inv.semente = 0;
    g.player.inv.batata = 50; // 20 kg: cheio
    faceTile(g, 1, 0);
    g.useSelected();
    expect(g.farm.at(1, 0)!.state).toBe('planted');
  });
});

describe('níveis de ferramenta do jogador', () => {
  it('sobem com o uso e baixam o custo de energia', () => {
    const g = game();
    expect(g.toolCost('enxada')).toBe(8);
    faceTile(g, 5, 5);
    g.selected = 0;
    g.useSelected();
    expect(g.player.levels.enxada).toBe(0.5);
    g.player.levels.enxada = 100;
    expect(g.toolCost('enxada')).toBe(4);
  });

  it('o nível nunca passa de 100', () => {
    const g = game();
    g.player.levels.regador = 99.9;
    faceTile(g, 0, 0);
    g.selected = 1; // regador
    g.useSelected();
    expect(g.player.levels.regador).toBe(100);
  });

  it('calça reforçada reduz o custo de ação', () => {
    const g = game();
    g.equip('calca_reforcada');
    expect(g.toolCost('foice')).toBeCloseTo(5 * 0.95);
  });
});

describe('equipamento do jogador', () => {
  it('equipar troca a peça e devolve a antiga para a mochila', () => {
    const g = game();
    expect(g.equip('bolsa_couro')).toContain('vestiu');
    expect(g.carryCap).toBe(26);
    expect(g.player.gear.bolsa).toBe('bolsa_couro');
    expect(g.player.gearInv).toContain('bolsa_pano');
    expect(g.player.gearInv).not.toContain('bolsa_couro');
  });

  it('bota aumenta a velocidade de caminhada', () => {
    const slow = game();
    const fast = game();
    fast.equip('bota_corrida');
    expect(fast.stats.speed).toBe(66);
    slow.step(1, { ...NO_MOVE, f: 1 });
    fast.step(1, { ...NO_MOVE, f: 1 });
    const d = (g: Game) => Math.hypot(g.player.x + 0.9, g.player.z - 2);
    expect(d(fast)).toBeGreaterThan(d(slow));
  });

  it('não deixa tirar a bolsa se a carga não cabe no novo limite', () => {
    const g = game();
    g.player.inv.batata = 35; // 14 kg + ferramentas > 12 kg
    expect(g.unequip('bolsa')).toContain('Tire peso');
    expect(g.player.gear.bolsa).toBe('bolsa_pano');
  });

  it('tirar o chapéu reduz a energia máxima e corta a energia atual', () => {
    const g = game();
    g.unequip('chapeu');
    expect(g.stats.maxEnergy).toBe(100);
    expect(g.player.energy).toBe(100);
  });

  it('compra peça com prata e ela vai para a mochila', () => {
    const g = game();
    g.player.silver = 100;
    expect(g.buyGear('chapeu_palha')).toContain('Comprou');
    expect(g.player.silver).toBe(60);
    expect(g.player.gearInv).toContain('chapeu_palha');
    expect(g.buyGear('bota_corrida')).toContain('não está à venda');
    g.player.silver = 5;
    expect(g.buyGear('bolsa_pano')).toContain('insuficiente');
  });
});

describe('equipamento dos trabalhadores', () => {
  function nearWorker(g: Game) {
    const w = g.workers[1]; // Zeca
    w.pres = 'in';
    w.visible = true;
    w.waypoints = [];
    w.x = g.player.x + 1;
    w.z = g.player.z;
    return w;
  }

  it('só troca peça com o trabalhador por perto', () => {
    const g = game();
    const w = g.workers[1];
    expect(g.giveGear(w, 'bota_couro')).toContain('perto');
    nearWorker(g);
    const before = w.stats.speed;
    expect(g.giveGear(w, 'bota_corrida')).toContain('vestiu');
    expect(w.stats.speed).toBeGreaterThan(before);
    expect(g.player.gearInv).not.toContain('bota_corrida');
  });

  it('a peça que o trabalhador usava volta para o jogador', () => {
    const g = game();
    const w = nearWorker(g);
    g.giveGear(w, 'bolsa_couro');
    expect(w.cap).toBe(26);
    g.player.gearInv.push('chapeu_aba');
    expect(w.gear.chapeu).toBe('chapeu_palha');
    g.giveGear(w, 'chapeu_aba');
    expect(w.gear.chapeu).toBe('chapeu_aba');
    expect(w.maxEnergy).toBe(120);
    expect(g.player.gearInv).toContain('chapeu_palha');
    expect(g.takeGear(w, 'chapeu')).toContain('pegou');
    expect(g.player.gearInv).toContain('chapeu_aba');
  });

  it('não deixa tirar a bolsa do trabalhador com a mochila cheia', () => {
    const g = game();
    const w = nearWorker(g);
    g.giveGear(w, 'bolsa_couro');
    w.inv.batata = 60; // 24 kg
    expect(g.takeGear(w, 'bolsa')).toContain('Tire peso');
  });
});

describe('tempo', () => {
  it('desmaia às 02:00 com penalidade', () => {
    const g = game();
    g.clock = FAINT_AT - 0.01;
    g.step(1, NO_MOVE);
    expect(g.day).toBe(2);
    expect(g.player.energy).toBeCloseTo(g.stats.maxEnergy * 0.7);
    expect(g.player.hp).toBeCloseTo(g.stats.maxHp * 0.8);
  });

  it('dormir restaura tudo e acorda às 06:00', () => {
    const g = game();
    g.player.energy = 3;
    g.endDay('sleep');
    expect(g.player.energy).toBe(g.stats.maxEnergy);
    expect(g.clock).toBe(360);
  });

  it('modo automático: acorda às 07:00 e dorme às 18:00 sozinho, sem penalidade', () => {
    const g = game();
    g.enterAuto();
    g.setSpeed(15);
    expect(g.clock).toBe(420);
    for (let k = 0; k < 400 && g.day === 1; k++) g.step(1, NO_MOVE);
    expect(g.day).toBe(2);
    expect(g.clock).toBe(420);
    expect(g.player.energy).toBe(g.stats.maxEnergy);
  });

  it('a velocidade só vale no modo automático', () => {
    const g = game();
    g.setSpeed(15);
    expect(g.speed).toBe(1);
    g.enterAuto();
    g.setSpeed(5);
    expect(g.speed).toBe(5);
    g.exitAuto();
    expect(g.speed).toBe(1);
    expect(g.mode).toBe('fp');
  });

  it('janela aberta pausa o tempo', () => {
    const g = game();
    g.paused = true;
    const c = g.clock;
    g.step(5, NO_MOVE);
    expect(g.clock).toBe(c);
  });
});

describe('economia', () => {
  it('vende batata e compra semente e pão', () => {
    const g = game();
    g.player.inv.batata = 3;
    expect(g.sellPotatoes(3)).toContain('42');
    expect(g.player.silver).toBe(142);
    g.buy('semente', 10);
    expect(g.player.silver).toBe(92);
    expect(g.store.semente).toBe(30);
    expect(g.player.inv.semente).toBe(30);
    g.player.silver = 5;
    expect(g.buy('pao', 1)).toContain('insuficiente');
  });

  it('cozinha batata assada com 2 batatas, usando a mochila antes do armazém', () => {
    const g = game();
    g.player.inv.batata = 1;
    g.store.batata = 4;
    g.cook();
    expect(g.player.inv.batata).toBe(0);
    expect(g.store.batata).toBe(3);
    expect(g.store.assada).toBe(1); // o resultado cai no armazém
    expect(g.player.inv.assada).toBe(0);
  });

  it('transferência respeita o peso do destino', () => {
    const a = newInv({ enxada: 3 });
    const b = newInv();
    const r = transfer(a, b, 'enxada', 3, 5);
    expect(r.moved).toBe(2);
    expect(invWeight(b)).toBe(4);
  });
});

describe('descanso do jogador', () => {
  it('a energia sobe sozinha quando ele passa um tempo sem usar ferramenta', () => {
    const g = game();
    g.player.energy = 50;
    g.step(1, NO_MOVE);
    expect(g.player.energy).toBe(50);
    for (let k = 0; k < 100; k++) g.step(0.1, NO_MOVE);
    expect(g.player.energy).toBeGreaterThan(50);
  });

  it('enquanto ele trabalha a energia não sobe', () => {
    const g = game();
    faceTile(g, 5, 5);
    g.selected = 0;
    g.useSelected();
    const after = g.player.energy;
    g.step(1, NO_MOVE);
    expect(g.player.energy).toBe(after);
  });
});

describe('trabalhadores em um dia completo', () => {
  it('em ×15 os trabalhadores colhem e guardam no armazém', () => {
    const g = game();
    g.enterAuto();
    g.setSpeed(15);
    for (let k = 0; k < 400 && g.day === 1; k++) g.step(1, NO_MOVE);
    expect(g.store.batata).toBeGreaterThan(0);
  });
});
