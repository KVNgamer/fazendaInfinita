import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Game } from '../core/game';
import { MAX_PENDING, MAX_VISITORS } from '../core/social';
import type { MoveInput } from '../core/player';
import type { Command, CommandResult, ServerMsg } from '../net/protocol';
import { parseCommand } from '../net/protocol';
import { Snapshotter, applyPatch } from '../net/snapshot';
import { openDb } from './db';
import { testDb } from './testdb';
import { Market } from './market';
import { GameSession } from './session';
import { Social } from './social';
import { runCommand } from './commands';

const NO_MOVE: MoveInput = { f: 0, b: 0, l: 0, r: 0, tl: 0, tr: 0 };

interface Player {
  s: GameSession;
  msgs: ServerMsg[];
  notes: string[];
  id: number;
}

async function world() {
  const db = await testDb();
  const sessions = new Map<number, GameSession>();
  const market = new Market(db, (id) => sessions.get(id));
  const social = new Social(db, (id) => sessions.get(id));
  const players = new Map<string, Player>();
  const join = async (name: string): Promise<Player> => {
    const id = (await db.findUser(name))?.id ?? (await db.createUser(name, 'h'))!;
    const msgs: ServerMsg[] = [];
    const s = new GameSession(id, name, null, db, { send: (m) => msgs.push(m) }, { rng: () => 0.99, market, social, saveEvery: 999 });
    const notes: string[] = [];
    s.game.onMessage = (t) => {
      notes.push(t);
      msgs.push({ t: 'msg', text: t });
    };
    sessions.set(id, s);
    const p = { s, msgs, notes, id };
    players.set(name, p);
    return p;
  };
  const leave = async (p: Player) => {
    await p.s.close();
    sessions.delete(p.id);
  };
  const run = (p: Player, c: Command): Promise<CommandResult> => runCommand(p.s.game, c, { save: async () => true, market, social, session: p.s });
  const friends = async (a: Player, b: Player, aAllowsB = 0, bAllowsA = 0) => {
    await social.request(a.s, b.s.username);
    await social.answer(b.s, a.s.username, true);
    if (aAllowsB) await social.setPermission(a.s, b.s.username, aAllowsB as 1 | 2);
    if (bAllowsA) await social.setPermission(b.s, a.s.username, bAllowsA as 1 | 2);
  };
  return { db, sessions, market, social, join, leave, run, friends };
}

const last = (p: Player) => p.notes[p.notes.length - 1] ?? '';
const types = (p: Player) => p.msgs.map((m) => m.t);

describe('amizades', () => {
  it('pedir, receber e aceitar', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    expect((await w.social.request(a.s, 'ninguem')).ok).toBe(false);
    expect((await w.social.request(a.s, 'ana')).ok).toBe(false);
    const r = await w.social.request(a.s, 'Beto');
    expect(r.ok).toBe(true);
    expect(last(b)).toContain('ana quer ser seu amigo');
    expect(types(b)).toContain('social');
    expect((await w.social.data(b.s)).incoming).toEqual(['ana']);
    expect((await w.social.data(a.s)).outgoing).toEqual(['beto']);
    expect((await w.social.request(a.s, 'beto')).ok).toBe(false); // já mandou
    expect((await w.social.answer(a.s, 'beto', true)).ok).toBe(false); // quem pediu não aceita o próprio pedido
    expect((await w.social.answer(b.s, 'ana', true)).ok).toBe(true);
    expect((await w.social.data(a.s)).friends.map((f) => f.name)).toEqual(['beto']);
    expect((await w.social.data(b.s)).friends.map((f) => f.name)).toEqual(['ana']);
    expect(await w.social.areFriends(a.id, b.id)).toBe(true);
    expect(last(a)).toContain('aceitou');
    expect((await w.social.request(a.s, 'beto')).message).toContain('já são amigos');
  });

  it('recusar apaga o pedido', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.social.request(a.s, 'beto');
    expect((await w.social.answer(b.s, 'ana', false)).ok).toBe(true);
    expect((await w.social.data(b.s)).incoming).toEqual([]);
    expect((await w.social.request(a.s, 'beto')).ok).toBe(true); // pode pedir de novo
  });

  it('pedidos cruzados viram amizade na hora', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.social.request(a.s, 'beto');
    await w.social.request(b.s, 'ana');
    expect(await w.social.areFriends(a.id, b.id)).toBe(true);
  });

  it('quem está fora recebe o aviso pelo correio', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.leave(b);
    await w.social.request(a.s, 'beto');
    const mail = await w.db.pendingMail(b.id);
    expect(mail).toHaveLength(1);
    expect(mail[0].kind).toBe('note');
    expect(mail[0].payload).toContain('ana quer ser seu amigo');
  });

  it('remover apaga a amizade e as permissões dos dois lados', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.friends(a, b, 2, 1);
    expect((await w.social.remove(a.s, 'beto')).ok).toBe(true);
    expect(await w.social.areFriends(a.id, b.id)).toBe(false);
    expect(await w.db.getPermission(a.id, b.id)).toBe(0);
    expect(await w.db.getPermission(b.id, a.id)).toBe(0);
    expect((await w.social.remove(a.s, 'beto')).ok).toBe(false);
  });

  it('bloquear desfaz a amizade e impede novos pedidos sem avisar quem foi bloqueado', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.friends(a, b, 1, 1);
    expect((await w.social.block(a.s, 'beto')).ok).toBe(true);
    expect(await w.social.areFriends(a.id, b.id)).toBe(false);
    expect((await w.social.data(a.s)).blocked).toEqual(['beto']);
    // beto tenta pedir: parece enviado, mas nada chega à ana
    const r = await w.social.request(b.s, 'ana');
    expect(r.ok).toBe(true);
    expect((await w.social.data(a.s)).incoming).toEqual([]);
    expect(await w.db.getFriendship(a.id, b.id)).toBeNull();
    // ana não pede a quem bloqueou, e pode desbloquear
    expect((await w.social.request(a.s, 'beto')).ok).toBe(false);
    expect((await w.social.unblock(a.s, 'beto')).ok).toBe(true);
    expect((await w.social.request(a.s, 'beto')).ok).toBe(true);
  });

  it(`no máximo ${MAX_PENDING} pedidos esperando`, async () => {
    const w = await world();
    const a = await w.join('ana');
    for (let i = 0; i < MAX_PENDING; i++) {
      await w.db.createUser('amigo' + i, 'h');
      expect((await w.social.request(a.s, 'amigo' + i)).ok).toBe(true);
    }
    await w.db.createUser('umamais', 'h');
    expect((await w.social.request(a.s, 'umamais')).ok).toBe(false);
  });

  it('permissão só para amigos, e começa em nada', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    expect((await w.social.setPermission(a.s, 'beto', 2)).ok).toBe(false);
    await w.friends(a, b);
    expect((await w.social.data(a.s)).friends[0]).toMatchObject({ iAllow: 0, theyAllow: 0, canVisit: false });
    await w.social.setPermission(a.s, 'beto', 1);
    expect((await w.social.data(a.s)).friends[0].iAllow).toBe(1);
    expect((await w.social.data(b.s)).friends[0]).toMatchObject({ theyAllow: 1, canVisit: true });
  });
});

describe('visitas', () => {
  it('regras para visitar', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    const c = await w.join('caio');
    expect((await w.social.visit(a.s, 'beto')).message).toContain('não é seu amigo');
    await w.friends(a, b);
    expect((await w.social.visit(a.s, 'beto')).message).toContain('ainda não deixou');
    await w.social.setPermission(b.s, 'ana', 1);
    expect((await w.social.visit(a.s, 'ana')).ok).toBe(false);
    await w.leave(b);
    expect((await w.social.visit(a.s, 'beto')).message).toContain('não está conectado');
    void c;
  });

  it('o visitante assiste: recebe a visão pública, sem carteira nem mochila', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.friends(a, b, 0, 1);
    b.s.game.player.silver = 4321;
    b.s.game.player.gold = 9;
    b.s.game.store.batata = 31337;
    expect((await w.social.visit(a.s, 'beto')).ok).toBe(true);
    const start = a.msgs.find((m): m is Extract<ServerMsg, { t: 'visitStart' }> => m.t === 'visitStart')!;
    expect(start.host).toBe('beto');
    expect(start.canHelp).toBe(false);
    const p = start.patch;
    expect(p.inv).toBeUndefined();
    expect(p.store).toBeUndefined();
    expect(p.gear).toBeUndefined();
    expect(p.gearInv).toBeUndefined();
    expect(p.hotbar).toBeUndefined();
    expect(p.data).toBeUndefined();
    expect(p.player).toMatchObject({ silver: 0, gold: 0, hp: 0 });
    expect(JSON.stringify(p)).not.toContain('4321');
    expect(JSON.stringify(p)).not.toContain('31337');
    expect(p.tiles!.length).toBe(100);
    expect(p.roster!.length).toBe(3);
    expect(start.patch.meta!.visitors).toEqual(['ana']);
    expect(last(b)).toContain('ana está visitando');
  });

  it('visitando, o jogo do visitante para e o do dono segue; o visitante acompanha o dono', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.friends(a, b, 0, 1);
    await w.social.visit(a.s, 'beto');
    const clockA = a.s.game.clock;
    const clockB = b.s.game.clock;
    a.msgs.length = 0;
    for (let i = 0; i < 30; i++) {
      a.s.tick(0.1);
      b.s.tick(0.1);
    }
    expect(a.s.game.clock).toBe(clockA);
    expect(b.s.game.clock).toBeGreaterThan(clockB);
    const patches = a.msgs.filter((m): m is Extract<ServerMsg, { t: 'visitPatch' }> => m.t === 'visitPatch');
    expect(patches.length).toBeGreaterThan(0);
    expect(a.msgs.some((m) => m.t === 'patch')).toBe(false); // o próprio jogo não manda nada
    // o visitante aplica e vê o relógio do dono andar
    const copy = new Game();
    const start = (w.sessions.get(b.id)!.visitorCount, 0);
    void start;
    applyPatch(copy, patches[patches.length - 1].patch, { followPaused: true });
    expect(copy.clock).toBeGreaterThan(clockB);
    expect(b.s.game.visitors).toEqual(['ana']);
  });

  it('o dono parado numa janela pausa a visão de quem visita', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.friends(a, b, 0, 1);
    await w.social.visit(a.s, 'beto');
    b.s.game.paused = true;
    a.msgs.length = 0;
    b.s.tick(0.2);
    const p = a.msgs.find((m): m is Extract<ServerMsg, { t: 'visitPatch' }> => m.t === 'visitPatch')!;
    expect(p.patch.meta?.paused).toBe(true);
  });

  it('visitando, só ações de amigos, ajuda e sair funcionam', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.friends(a, b, 0, 1);
    await w.social.visit(a.s, 'beto');
    a.s.game.player.silver = 99999;
    for (const c of [{ t: 'buyLand' }, { t: 'sleep' }, { t: 'use' }, { t: 'reset' }, { t: 'openBox', kind: 'prata' }, { t: 'visit', name: 'beto' }] as Command[]) {
      const r = await w.run(a, c);
      expect(r.ok, c.t).toBe(false);
      expect(r.message).toContain('visitando beto');
    }
    expect(a.s.game.farm.tiles.length).toBe(100);
    expect((await w.run(a, { t: 'social' })).ok).toBe(true);
    expect((await w.run(a, { t: 'leaveVisit' })).ok).toBe(true);
    expect(a.s.visiting).toBeNull();
    expect(types(a)).toContain('visitEnd');
    expect((await w.run(a, { t: 'buyLand' })).message).not.toContain('visitando');
  });

  it('o dono não visita enquanto recebe visitas, e quem visita não é visitado', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    const c = await w.join('caio');
    await w.friends(a, b, 0, 1);
    await w.friends(c, b, 0, 1);
    await w.friends(c, a, 1, 1);
    await w.social.visit(a.s, 'beto');
    expect((await w.social.visit(b.s, 'caio')).message).toContain('recebendo visitas');
    expect((await w.social.visit(c.s, 'ana')).message).toContain('visitando outra fazenda');
  });

  it(`no máximo ${MAX_VISITORS} visitantes`, async () => {
    const w = await world();
    const host = await w.join('dono');
    const guests: Player[] = [];
    for (let i = 0; i < MAX_VISITORS + 1; i++) {
      const g = await w.join('v' + i);
      await w.friends(g, host, 0, 1);
      guests.push(g);
    }
    for (let i = 0; i < MAX_VISITORS; i++) expect((await w.social.visit(guests[i].s, 'dono')).ok).toBe(true);
    const r = await w.social.visit(guests[MAX_VISITORS].s, 'dono');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('cheia');
  });

  it('quando o dono sai, todos os visitantes voltam para casa', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.friends(a, b, 0, 1);
    await w.social.visit(a.s, 'beto');
    await w.leave(b);
    expect(a.s.visiting).toBeNull();
    const end = a.msgs.find((m): m is Extract<ServerMsg, { t: 'visitEnd' }> => m.t === 'visitEnd')!;
    expect(end.reason).toContain('dono saiu');
  });

  it('quando o visitante sai, o dono fica sem ele', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.friends(a, b, 0, 1);
    await w.social.visit(a.s, 'beto');
    await w.leave(a);
    expect(b.s.visitorCount).toBe(0);
    expect(b.s.game.visitors).toEqual([]);
  });

  it('tirar a permissão no meio da visita encerra; baixar para assistir tira a ajuda', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.friends(a, b, 0, 2);
    await w.social.visit(a.s, 'beto');
    await w.social.setPermission(b.s, 'ana', 1);
    expect(a.s.visiting).not.toBeNull();
    expect((await w.social.help(a.s, 'water', 0, 0)).message).toContain('só assistir');
    await w.social.setPermission(b.s, 'ana', 0);
    expect(a.s.visiting).toBeNull();
  });

  it('remover a amizade ou bloquear no meio da visita também encerra', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.friends(a, b, 0, 1);
    await w.social.visit(a.s, 'beto');
    await w.social.block(b.s, 'ana');
    expect(a.s.visiting).toBeNull();
    expect((await w.social.visit(a.s, 'beto')).ok).toBe(false);
  });
});

describe('ajuda', () => {
  async function setup(level: 1 | 2 = 2) {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.friends(a, b, 0, level);
    await w.social.visit(a.s, 'beto');
    return { w, a, b };
  }

  it('regar: usa o regador e a energia de quem ajuda, e rega o solo do dono', async () => {
    const { w, a, b } = await setup();
    const t = b.s.game.farm.at(0, 0)!; // fileira pronta, não regada
    expect(t.wet).toBe(false);
    const energy = a.s.game.player.energy;
    const r = await w.social.help(a.s, 'water', 0, 0);
    expect(r.ok).toBe(true);
    expect(t.wet).toBe(true);
    expect(a.s.game.player.energy).toBeLessThan(energy);
    expect(a.s.game.player.levels.regador).toBeGreaterThan(0);
    expect(a.s.visiting!.water).toBe(1);
    expect((await w.social.help(a.s, 'water', 0, 0)).message).toContain('já foi regado');
  });

  it('só rega onde há planta; precisa de regador e de energia', async () => {
    const { w, a } = await setup();
    expect((await w.social.help(a.s, 'water', 9, 9)).message).toContain('onde há planta'); // solo cru
    expect((await w.social.help(a.s, 'water', 99, 99)).message).toContain('não existe');
    a.s.game.player.inv.regador = 0;
    expect((await w.social.help(a.s, 'water', 0, 1)).message).toContain('regador');
    a.s.game.player.inv.regador = 1;
    a.s.game.player.energy = 0;
    expect((await w.social.help(a.s, 'water', 0, 1)).ok).toBe(false);
  });

  it('colher: a batata vai para o armazém do dono, não para quem ajuda', async () => {
    const { w, a, b } = await setup();
    const t = b.s.game.farm.at(0, 0)!;
    expect(t.age).toBe(5);
    const mine = a.s.game.player.inv.batata;
    const r = await w.social.help(a.s, 'harvest', 0, 0);
    expect(r.ok).toBe(true);
    expect(b.s.game.store.batata).toBe(1);
    expect(a.s.game.player.inv.batata).toBe(mine);
    expect(t.state).toBe('tilled');
    expect((await w.social.help(a.s, 'harvest', 0, 0)).ok).toBe(false);
    expect((await w.social.help(a.s, 'harvest', 0, 1)).message).toContain('Ainda não está pronta');
  });

  it('colher precisa de foice e de espaço no armazém do dono', async () => {
    const { w, a, b } = await setup();
    a.s.game.player.inv.foice = 0;
    expect((await w.social.help(a.s, 'harvest', 0, 0)).message).toContain('foice');
    a.s.game.player.inv.foice = 1;
    b.s.game.store.batata = 5000;
    expect((await w.social.help(a.s, 'harvest', 0, 0)).message).toContain('cheio');
  });

  it('com a permissão só de assistir, ninguém ajuda', async () => {
    const { w, a, b } = await setup(1);
    const r = await w.social.help(a.s, 'water', 0, 0);
    expect(r.ok).toBe(false);
    expect(b.s.game.farm.at(0, 0)!.wet).toBe(false);
  });

  it('terreno bloqueado não recebe ajuda', async () => {
    const { w, a, b } = await setup();
    b.s.game.farm.at(0, 0)!.locked = true;
    expect((await w.social.help(a.s, 'water', 0, 0)).message).toContain('bloqueado');
  });

  it('só ajuda quem está visitando', async () => {
    const w = await world();
    const a = await w.join('ana');
    expect((await w.social.help(a.s, 'water', 0, 0)).ok).toBe(false);
  });

  it('o dono recebe o resumo da ajuda ao fim da visita', async () => {
    const { w, a, b } = await setup();
    await w.social.help(a.s, 'water', 0, 0);
    await w.social.help(a.s, 'harvest', 1, 0);
    await w.social.leave(a.s);
    expect(last(b)).toContain('1 solo(s) regado(s), 1 colhido(s)');
    expect(a.s.game.player.energy).toBeLessThan(a.s.game.stats.maxEnergy);
  });

  it('a energia gasta ajudando fica com o visitante depois de voltar', async () => {
    const { w, a } = await setup();
    const before = a.s.game.player.energy;
    await w.social.help(a.s, 'water', 0, 0);
    await w.social.leave(a.s);
    a.s.tick(0.1);
    expect(a.s.game.player.energy).toBeLessThanOrEqual(before);
  });
});

describe('visão pública', () => {
  it('não carrega carteira, mochila, armazém nem dívida', async () => {
    const g = new Game(() => 0.5);
    g.player.silver = 4321;
    g.store.batata = 77;
    g.player.gearInv.push('bota_corrida');
    g.lands[1].owned = true;
    g.lands[1].locked = true;
    g.lands[1].debt = 9876;
    g.farm.addLand(1);
    const patch = new Snapshotter(true).full(g, true);
    const text = JSON.stringify(patch);
    expect(text).not.toContain('4321');
    expect(text).not.toContain('9876');
    expect(text).not.toContain('bota_corrida');
    expect(patch.inv).toBeUndefined();
    expect(patch.selected).toBeUndefined();
    const own = new Snapshotter(false).full(g, true);
    expect(JSON.stringify(own)).toContain('4321');
    expect(own.selected).toBe(0);
  });

  it('a cópia de quem visita fica igual ao mundo do dono (solos, trabalhadores, cerca)', async () => {
    const g = new Game(() => 0.5);
    g.player.silver = 5000;
    g.buyLand();
    g.farm.at(3, 3)!.state = 'planted';
    const snap = new Snapshotter(true);
    const copy = new Game();
    applyPatch(copy, snap.full(g, true), { followPaused: true });
    expect(copy.farm.tiles.length).toBe(150);
    expect(copy.farm.at(3, 3)!.state).toBe('planted');
    expect(copy.bounds).toEqual(g.bounds);
    expect(copy.workers.map((w) => w.name)).toEqual(g.workers.map((w) => w.name));
    g.step(1, NO_MOVE);
    applyPatch(copy, snap.diff(g), { followPaused: true });
    expect(Math.round(copy.clock)).toBe(Math.round(g.clock));
  });
});

describe('emprestar trabalhador a um amigo', () => {
  it('só a um amigo, de graça se quiser, e só ele vê e aceita', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    const c = await w.join('caio');
    await w.friends(a, b);
    expect((await w.market.sell(a.s, { what: 'rent', name: 'Cida', days: 3, to: 'caio' }, 0, 'silver')).message).toContain('não é seu amigo');
    expect((await w.market.sell(a.s, { what: 'rent', name: 'Cida', days: 3 }, 0, 'silver')).ok).toBe(false); // público: preço mínimo 1
    const r = await w.market.sell(a.s, { what: 'rent', name: 'Cida', days: 3, to: 'beto' }, 0, 'silver');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('de graça');
    const seenByBeto = (await w.market.data(b.s)).listings;
    expect(seenByBeto).toHaveLength(1);
    expect(seenByBeto[0]).toMatchObject({ target: 'beto', price: 0 });
    expect((await w.market.data(c.s)).listings).toHaveLength(0); // caio não vê
    expect((await w.market.buy(c.s, seenByBeto[0].id)).ok).toBe(false);
    expect((await w.market.buy(b.s, seenByBeto[0].id)).ok).toBe(true);
    expect(b.s.game.player.silver).toBe(100);
    const got = b.s.game.workers.find((x) => x.rental)!;
    expect(got.rental).toMatchObject({ owner: 'ana', daysLeft: 3, pricePerDay: 0 });
  });

  it('empréstimo grátis: o dono não recebe nada, e o trabalhador volta no fim', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.friends(a, b);
    await w.market.sell(a.s, { what: 'rent', name: 'Zeca', days: 2, to: 'beto' }, 0, 'silver');
    await w.market.buy(b.s, (await w.market.data(b.s)).listings[0].id);
    const silver = a.s.game.player.silver;
    await w.market.rentalDay(b.s);
    await w.market.rentalDay(b.s);
    expect(a.s.game.player.silver).toBe(silver);
    expect(a.s.game.workers.map((x) => x.name)).toContain('Zeca');
    expect(b.s.game.workers.find((x) => x.rental)).toBeUndefined();
  });

  it('o dono vê o próprio empréstimo privado e pode cancelar', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.friends(a, b);
    await w.market.sell(a.s, { what: 'rent', name: 'Zeca', days: 2, to: 'beto' }, 5, 'silver');
    const mine = (await w.market.data(a.s)).listings[0];
    expect(mine).toMatchObject({ mine: true, target: 'beto' });
    expect((await w.market.cancel(a.s, mine.id)).ok).toBe(true);
    expect(a.s.game.workers.map((x) => x.name)).toContain('Zeca');
  });

  it('o aviso de amizade desfeita não deixa o empréstimo preso: dá para cancelar', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.friends(a, b);
    await w.market.sell(a.s, { what: 'rent', name: 'Cida', days: 2, to: 'beto' }, 0, 'silver');
    await w.social.remove(a.s, 'beto');
    const id = (await w.market.data(a.s)).listings[0].id;
    expect((await w.market.cancel(a.s, id)).ok).toBe(true);
  });

  it('a lista de amigos vai junto com a tela do mercado', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.friends(a, b);
    expect((await w.market.data(a.s)).friends).toEqual(['beto']);
  });
});

describe('banco antigo', () => {
  it('ganha as colunas de anúncio privado sem perder os anúncios que já existem', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fazenda-'));
    try {
      const path = join(dir, 'velho.sqlite');
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
      const old = new DatabaseSync(path);
      old.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, username_lower TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE listings (id INTEGER PRIMARY KEY AUTOINCREMENT, seller_id INTEGER NOT NULL, seller_name TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, qty INTEGER NOT NULL, payload TEXT NOT NULL, currency TEXT NOT NULL, price INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, buyer_id INTEGER, sold_at INTEGER);
        INSERT INTO users (username, username_lower, pass_hash, created_at) VALUES ('ana', 'ana', 'h', 1);
        INSERT INTO listings (seller_id, seller_name, kind, key, qty, payload, currency, price, created_at, expires_at) VALUES (1, 'ana', 'item', 'semente', 5, '{}', 'silver', 50, 1, 99999999999999);
      `);
      old.close();
      const db = openDb(path);
      const rows = await db.openListings(null, 2, 10, 2);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ key: 'semente', targetId: null, targetName: null });
      const id = await db.insertListing({ sellerId: 1, sellerName: 'ana', kind: 'rent', key: 'Cida', qty: 2, payload: '{}', currency: 'silver', price: 0, createdAt: 3, expiresAt: 99999999999999, targetId: 2, targetName: 'beto' });
      expect(await db.getListing(id)).toMatchObject({ targetId: 2, targetName: 'beto' });
      expect((await db.openListings(null, 4, 10, 3)).map((r) => r.id)).not.toContain(id); // outro jogador não vê
      expect((await db.openListings(null, 4, 10, 2)).map((r) => r.id)).toContain(id);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('protocolo de amigos', () => {
  it('aceita pedidos bem formados e recusa os estranhos', async () => {
    expect(parseCommand({ t: 'friendRequest', name: 'ana' })).toEqual({ t: 'friendRequest', name: 'ana' });
    expect(parseCommand({ t: 'friendAnswer', name: 'ana', accept: true })).toEqual({ t: 'friendAnswer', name: 'ana', accept: true });
    expect(parseCommand({ t: 'friendPerm', name: 'ana', level: 2 })).toEqual({ t: 'friendPerm', name: 'ana', level: 2 });
    expect(parseCommand({ t: 'visit', name: 'ana' })).toEqual({ t: 'visit', name: 'ana' });
    expect(parseCommand({ t: 'help', action: 'water', i: 3, j: 4 })).toEqual({ t: 'help', action: 'water', i: 3, j: 4 });
    expect(parseCommand({ t: 'leaveVisit' })).toEqual({ t: 'leaveVisit' });
    expect(parseCommand({ t: 'friendPerm', name: 'ana', level: 3 })).toBeNull();
    expect(parseCommand({ t: 'friendPerm', name: 'ana', level: 'tudo' })).toBeNull();
    expect(parseCommand({ t: 'friendAnswer', name: 'ana', accept: 'sim' })).toBeNull();
    expect(parseCommand({ t: 'friendRequest', name: '' })).toBeNull();
    expect(parseCommand({ t: 'friendRequest', name: 'a'.repeat(21) })).toBeNull();
    expect(parseCommand({ t: 'help', action: 'roubar', i: 0, j: 0 })).toBeNull();
    expect(parseCommand({ t: 'help', action: 'water', i: -1, j: 0 })).toBeNull();
    expect(parseCommand({ t: 'help', action: 'water', i: 1.5, j: 0 })).toBeNull();
  });

  it('empréstimo a amigo pode ter preço 0, o anúncio público não', async () => {
    const rent = (to?: string, price = 0) => parseCommand({ t: 'marketSell', spec: { what: 'rent', name: 'Cida', days: 2, ...(to ? { to } : {}) }, price, currency: 'silver' });
    expect(rent('ana', 0)).not.toBeNull();
    expect(rent(undefined, 0)).toBeNull();
    expect(rent('ana', -1)).toBeNull();
    expect(parseCommand({ t: 'marketSell', spec: { what: 'rent', name: 'Cida', days: 2, to: '' }, price: 5, currency: 'silver' })).toBeNull();
  });
});
