import { describe, expect, it } from 'vitest';
import { Game } from '../core/game';
import { parseCommand } from '../net/protocol';
import type { Command, CommandResult } from '../net/protocol';
import { runCommand } from './commands';
import { GameSession } from './session';
import { testDb } from './testdb';

const hooks = { save: async () => true };
const run = (g: Game, c: Command): Promise<CommandResult> => runCommand(g, c, hooks);

describe('modo automático: mercado, cozinha e armazém à distância', () => {
  it('em modo normal e longe, continua recusando; no automático, vale', async () => {
    const g = new Game(() => 0.99);
    g.player.silver = 500;
    g.player.x = -17; // longe de tudo
    g.player.z = 8;
    expect((await run(g, { t: 'buy', key: 'semente', n: 5 })).ok).toBe(false);
    expect((await run(g, { t: 'cook', n: 1 })).ok).toBe(false);
    g.mode = 'spec';
    expect((await run(g, { t: 'buy', key: 'semente', n: 5 })).ok).toBe(true);
    g.store.batata = 4;
    expect((await run(g, { t: 'cook', n: 2 })).ok).toBe(true);
    expect(g.store.assada).toBe(2);
    expect((await run(g, { t: 'sellStore' })).ok).toBe(true);
    expect((await run(g, { t: 'move', from: { at: 'bag' }, to: { at: 'store' }, key: 'semente', n: 5 })).ok).toBe(true);
  });

  it('mandar um trabalhador buscar item: no automático vale de longe, no normal só perto dele', async () => {
    const g = new Game(() => 0.99);
    g.store.pao = 5;
    g.player.x = -17;
    g.player.z = 8;
    expect((await run(g, { t: 'order', worker: 'Tião', key: 'pao', n: 2 })).ok).toBe(false);
    g.mode = 'spec';
    expect((await run(g, { t: 'order', worker: 'Tião', key: 'pao', n: 2 })).ok).toBe(true);
    expect(g.workers[0].order).toEqual({ key: 'pao', left: 2 });
    expect((await run(g, { t: 'order', worker: 'Tião', key: 'pao', n: 0 })).message).toContain('não tem mais ordem');
    expect(g.workers[0].order).toBeNull();
    expect((await run(g, { t: 'order', worker: 'Fantasma', key: 'pao', n: 1 })).ok).toBe(false);
    g.store.pao = 0;
    expect((await run(g, { t: 'order', worker: 'Tião', key: 'pao', n: 1 })).message).toContain('não tem');
  });

  it('as mensagens da rede aceitam quantidades grandes e ordens, e recusam o resto', () => {
    expect(parseCommand({ t: 'buy', key: 'semente', n: 25000 })).toEqual({ t: 'buy', key: 'semente', n: 25000 });
    expect(parseCommand({ t: 'buy', key: 'semente', n: 0 })).toBeNull();
    expect(parseCommand({ t: 'cook' })).toEqual({ t: 'cook', n: 1 });
    expect(parseCommand({ t: 'cook', n: 12 })).toEqual({ t: 'cook', n: 12 });
    expect(parseCommand({ t: 'cook', n: -1 })).toBeNull();
    expect(parseCommand({ t: 'order', worker: 'Tião', key: 'pao', n: 3 })).toEqual({ t: 'order', worker: 'Tião', key: 'pao', n: 3 });
    expect(parseCommand({ t: 'order', worker: 'Tião', key: 'diamante', n: 3 })).toBeNull();
    expect(parseCommand({ t: 'order', worker: '', key: 'pao', n: 3 })).toBeNull();
    expect(parseCommand({ t: 'order', worker: 'Tião', key: 'pao', n: -3 })).toBeNull();
  });
});

describe('salvar sem travar o jogo', () => {
  async function session(delayMs = 0) {
    const db = await testDb();
    const id = (await db.createUser('ana', 'h'))!;
    const writes: string[] = [];
    const real = db.writeSave.bind(db);
    db.writeSave = async (userId, json, now) => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      writes.push(json);
      return real(userId, json, now);
    };
    const s = new GameSession(id, 'ana', null, db, { send: () => {} }, { rng: () => 0.99, saveEvery: 1 });
    return { db, id, s, writes };
  }

  it('o relógio continua andando enquanto o banco demora para responder', async () => {
    const { s } = await session(150);
    const clock = s.game.clock;
    s.save();
    for (let i = 0; i < 10; i++) s.tick(0.1); // o banco ainda está escrevendo
    expect(s.game.clock).toBeGreaterThan(clock);
  });

  it('só grava se o jogo mudou desde o último salvamento', async () => {
    const { s, writes } = await session();
    expect(await s.saveNow()).toBe(true);
    expect(await s.saveNow()).toBe(true);
    expect(writes).toHaveLength(1);
    s.game.player.silver += 7;
    expect(await s.saveNow()).toBe(true);
    expect(writes).toHaveLength(2);
  });

  it('um salvamento antigo e lento nunca escreve por cima de um mais novo', async () => {
    const db = await testDb();
    const id = (await db.createUser('ana', 'h'))!;
    await db.writeSave(id, '{"v":2}', 200);
    await db.writeSave(id, '{"v":1}', 100); // chegou depois, mas é mais velho
    expect(await db.loadSave(id)).toBe('{"v":2}');
    await db.writeSave(id, '{"v":3}', 300);
    expect(await db.loadSave(id)).toBe('{"v":3}');
  });

  it('os salvamentos de uma pessoa chegam ao banco na ordem em que foram tirados', async () => {
    const { s, writes, db, id } = await session(30);
    s.game.player.silver = 111;
    const a = s.saveNow();
    s.game.player.silver = 222;
    const b = s.saveNow();
    await Promise.all([a, b]);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain('111');
    expect(writes[1]).toContain('222');
    expect(await db.loadSave(id)).toContain('222');
  });

  it('o relógio de quem negocia espera só durante a operação do mercado', async () => {
    const { s } = await session();
    const release = s.freeze();
    const clock = s.game.clock;
    s.tick(0.2);
    expect(s.game.clock).toBe(clock);
    release();
    release(); // liberar duas vezes não deixa o contador negativo
    s.tick(0.2);
    expect(s.game.clock).toBeGreaterThan(clock);
  });
});
