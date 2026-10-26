import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Game } from '../core/game';
import { serialize } from '../core/save';
import type { Command, CommandResult, ServerMsg } from '../net/protocol';
import { applyPatch } from '../net/snapshot';
import { RateLimiter, hashPassword, hashToken, newToken, validPassword, validUsername, verifyPassword } from './auth';
import { runCommand } from './commands';
import { createApp } from './app';
import type { App } from './app';
import { openDb } from './db';
import { testDb } from './testdb';

const HOOKS = { save: async () => true };

describe('banco de dados', () => {
  it('cria usuário e não deixa repetir o nome, nem trocando maiúsculas', async () => {
    const db = await testDb();
    const id = await db.createUser('Kevin', 'hash');
    expect(id).toBeGreaterThan(0);
    expect(await db.createUser('kevin', 'outro')).toBeNull();
    expect(await db.createUser('KEVIN', 'outro')).toBeNull();
    expect(await db.findUser('KeViN')).toMatchObject({ id, username: 'Kevin', passHash: 'hash' });
    expect(await db.findUser('ninguem')).toBeNull();
  });

  it('sessões expiram e podem ser apagadas', async () => {
    const db = await testDb();
    const id = (await db.createUser('ana', 'h'))!;
    await db.createSession(id, 'tok1', 1000);
    await db.createSession(id, 'tok2', 5000);
    expect(await db.findSession('tok1', 500)).toEqual({ userId: id, username: 'ana' });
    expect(await db.findSession('tok1', 1000)).toBeNull();
    expect(await db.findSession('tok2', 1000)).not.toBeNull();
    await db.deleteSession('tok2');
    expect(await db.findSession('tok2', 1000)).toBeNull();
    await db.purgeSessions(2000);
    expect(await db.findSession('tok1', 0)).toBeNull();
  });

  it('guarda e atualiza o save de cada conta separadamente', async () => {
    const db = await testDb();
    const a = (await db.createUser('a', 'h'))!;
    const b = (await db.createUser('b', 'h'))!;
    expect(await db.loadSave(a)).toBeNull();
    await db.writeSave(a, '{"x":1}', 1);
    await db.writeSave(a, '{"x":2}', 2);
    await db.writeSave(b, '{"y":1}', 3);
    expect(await db.loadSave(a)).toBe('{"x":2}');
    expect(await db.loadSave(b)).toBe('{"y":1}');
  });
});

describe('contas e senhas', () => {
  it('guarda só um resumo da senha, e confere certo', async () => {
    const h = await hashPassword('senha-boa-123');
    expect(h).not.toContain('senha-boa-123');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('senha-boa-123', h)).toBe(true);
    expect(await verifyPassword('senha-errada', h)).toBe(false);
    expect(await verifyPassword('x', 'lixo')).toBe(false);
    expect(await hashPassword('senha-boa-123')).not.toBe(h); // sal diferente a cada vez
  });

  it('token: o banco só vê o resumo', async () => {
    const { token, hash } = newToken();
    expect(token.length).toBe(64);
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toBe(token);
    expect(newToken().token).not.toBe(token);
  });

  it('regras de nome e senha', async () => {
    expect(validUsername('kevin_01')).toBe(true);
    for (const n of ['ab', 'a'.repeat(21), 'com espaço', 'açúcar', "x'; drop", '', 5, null]) expect(validUsername(n)).toBe(false);
    expect(validPassword('12345678')).toBe(true);
    for (const p of ['1234567', 'a'.repeat(129), '', 12345678, undefined]) expect(validPassword(p)).toBe(false);
  });

  it('limite de tentativas por janela de tempo', async () => {
    const l = new RateLimiter(3, 1000);
    expect([1, 2, 3, 4].map((i) => l.allow('ip', i))).toEqual([true, true, true, false]);
    expect(l.allow('outro', 5)).toBe(true);
    expect(l.allow('ip', 1500)).toBe(true);
  });
});

describe('comandos no servidor', () => {
  const game = () => new Game(() => 0.99);
  const run = (g: Game, c: Command, hooks = HOOKS): Promise<CommandResult> => runCommand(g, c, hooks);

  it('ações de um lugar só valem perto dele', async () => {
    const g = game();
    g.player.x = 0;
    g.player.z = 0; // longe da casa, do mercado e do armazém
    for (const c of [{ t: 'sleep' }, { t: 'cook' }, { t: 'buyGold', n: 1 }, { t: 'sellStore' }, { t: 'openBox', kind: 'prata' }] as Command[]) {
      const r = await run(g, c);
      expect(r.ok).toBe(false);
      expect(r.message).toContain('perto');
    }
    expect(g.day).toBe(1);
  });

  it('perto do mercado, compra e vende', async () => {
    const g = game();
    g.player.x = -5.5;
    g.player.z = 6.1;
    g.player.silver = 1000;
    const r = await run(g, { t: 'buyGold', n: 2 });
    expect(r.ok).toBe(true);
    expect(g.player.gold).toBe(2);
    expect(g.player.silver).toBe(500);
  });

  it('abrir caixa devolve o prêmio na resposta', async () => {
    const g = new Game(() => 0.01);
    g.player.x = -5.5;
    g.player.z = 6.1;
    g.player.silver = 300;
    const r = await run(g, { t: 'openBox', kind: 'prata' });
    expect(r.box).toBeTruthy();
    expect(g.player.silver).toBe(0);
  });

  it('passar itens: só entre a mochila e o armazém/trabalhador, e só por perto', async () => {
    const g = game();
    g.player.x = -1.7;
    g.player.z = -2.8;
    const r = await run(g, { t: 'move', from: { at: 'bag' }, to: { at: 'store' }, key: 'semente', n: 10 });
    expect(r.ok).toBe(true);
    expect(g.store.semente).toBe(30);
    expect((await run(g, { t: 'move', from: { at: 'store' }, to: { at: 'store' }, key: 'semente', n: 1 })).ok).toBe(false);
    g.player.x = 6;
    g.player.z = 6;
    expect((await run(g, { t: 'move', from: { at: 'bag' }, to: { at: 'store' }, key: 'semente', n: 1 })).message).toContain('armazém');
    expect((await run(g, { t: 'move', from: { at: 'bag' }, to: { at: 'worker', name: 'Tião' }, key: 'enxada', n: 1 })).message).toContain('perto');
    expect((await run(g, { t: 'move', from: { at: 'bag' }, to: { at: 'worker', name: 'Fantasma' }, key: 'enxada', n: 1 })).message).toContain('não existe');
  });

  it('usar ferramenta e os modos', async () => {
    const g = game();
    g.player.x = -1.8;
    g.player.z = 2;
    expect((await run(g, { t: 'auto' })).ok).toBe(true);
    expect(g.mode).toBe('spec');
    expect((await run(g, { t: 'use' })).message).toContain('automático');
    expect((await run(g, { t: 'speed', speed: 5 })).ok).toBe(true);
    expect(g.speed).toBe(5);
    expect((await run(g, { t: 'exitAuto' })).ok).toBe(true);
    expect((await run(g, { t: 'exitAuto' })).ok).toBe(false);
  });

  it('prioridades: aceita uma ordem válida e recusa repetição', async () => {
    const g = game();
    const ok = await run(g, { t: 'prios', worker: 'Zeca', order: ['Colher', 'Regar', 'Plantar', 'Preparar'], on: [true, true, true, false] });
    expect(ok.ok).toBe(true);
    expect(g.workers[1].prios[0].k).toBe('Colher');
    const bad = await run(g, { t: 'prios', worker: 'Zeca', order: ['Colher', 'Colher', 'Plantar', 'Preparar'], on: [true, true, true, true] });
    expect(bad.ok).toBe(false);
    expect(g.workers[1].prios[0].k).toBe('Colher');
  });

  it('as mensagens do jogo voltam na resposta e o aviso solto é restaurado', async () => {
    const g = game();
    const heard: string[] = [];
    g.onMessage = (t) => heard.push(t);
    g.player.x = 4 - 1.4;
    g.player.z = 5;
    g.player.yaw = -Math.PI / 2;
    g.selected = 0;
    const r = await run(g, { t: 'use' });
    expect(r.message).toBe('Solo preparado.');
    expect(heard).toEqual([]);
    g.say('depois');
    expect(heard).toEqual(['depois']);
  });
});

// ---------- ponta a ponta: servidor de verdade + WebSocket ----------

class Client {
  readonly msgs: ServerMsg[] = [];
  readonly ws: WebSocket;
  closed: number | null = null;

  constructor(port: number, origin?: string) {
    this.ws = new WebSocket('ws://127.0.0.1:' + port + '/ws', origin ? { origin } : undefined);
    this.ws.on('message', (d) => this.msgs.push(JSON.parse(d.toString())));
    this.ws.on('close', (code) => {
      this.closed = code;
    });
    this.ws.on('error', () => {});
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
    });
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }

  async waitFor<T extends ServerMsg>(pred: (m: ServerMsg) => m is T, ms = 3000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const found = this.msgs.find(pred);
      if (found) return found;
      if (Date.now() - start > ms) throw new Error('mensagem não chegou; recebidas: ' + this.msgs.map((m) => m.t).join(','));
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async waitClosed(ms = 3000): Promise<number> {
    const start = Date.now();
    while (this.closed === null) {
      if (Date.now() - start > ms) throw new Error('não fechou');
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.closed;
  }
}

const isT = <K extends ServerMsg['t']>(t: K) => (m: ServerMsg): m is Extract<ServerMsg, { t: K }> => m.t === t;

describe('servidor completo', () => {
  let app: App | null = null;
  const clients: Client[] = [];
  const db = () => openDb(':memory:');

  afterEach(async () => {
    for (const c of clients.splice(0)) c.ws.close();
    await app?.close();
    app = null;
  });

  async function start(extra: Partial<Parameters<typeof createApp>[0]> = {}, database = db()) {
    app = await createApp({ db: database, port: 0, tickMs: 10, sessionOptions: { sendEvery: 0.02, saveEvery: 999 }, ...extra });
    return { port: app.port, database, base: 'http://127.0.0.1:' + app.port };
  }

  async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, string> };
  }

  async function login(port: number, token: string) {
    const c = new Client(port);
    clients.push(c);
    await c.opened();
    c.send({ t: 'auth', token });
    return c;
  }

  it('cadastro, login e erros de login iguais para nome e senha', async () => {
    const { base } = await start();
    const created = await post(base, '/api/register', { username: 'Kevin', password: 'senhaforte1' });
    expect(created.status).toBe(200);
    expect(created.body.token).toHaveLength(64);
    expect((await post(base, '/api/register', { username: 'kevin', password: 'outrasenha1' })).status).toBe(409);
    expect((await post(base, '/api/register', { username: 'a', password: 'senhaforte1' })).status).toBe(400);
    expect((await post(base, '/api/register', { username: 'novo', password: 'curta' })).status).toBe(400);
    const ok = await post(base, '/api/login', { username: 'KEVIN', password: 'senhaforte1' });
    expect(ok.status).toBe(200);
    const wrong = await post(base, '/api/login', { username: 'Kevin', password: 'senhaerrada1' });
    const ghost = await post(base, '/api/login', { username: 'Fantasma', password: 'senhaerrada1' });
    expect(wrong.status).toBe(401);
    expect(ghost.status).toBe(401);
    expect(wrong.body.error).toBe(ghost.body.error);
  });

  it('segura quem tenta senhas em sequência', async () => {
    const { base } = await start({ authPerMinute: 4 });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post(base, '/api/login', { username: 'x', password: 'senhaerrada1' })).status);
    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(statuses.slice(4)).toEqual([429, 429]);
  });

  it('a API recusa corpo que não é JSON e métodos errados', async () => {
    const { base } = await start();
    const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    expect(res.status).toBe(415);
    expect((await fetch(base + '/api/login')).status).toBe(405);
    expect((await fetch(base + '/api/health')).status).toBe(200);
  });

  it('entra com o token, recebe o jogo e vê o servidor mover o jogador', async () => {
    const { port, base } = await start();
    const { body } = await post(base, '/api/register', { username: 'Ana', password: 'senhaforte1' });
    const c = await login(port, body.token);
    const welcome = await c.waitFor(isT('welcome'));
    expect(welcome.user).toBe('Ana');
    expect(welcome.fresh).toBe(true);
    const replica = new Game();
    applyPatch(replica, welcome.patch);
    const x0 = replica.player.x;
    c.send({ t: 'input', f: 1, b: 0, l: 0, r: 0, yaw: -Math.PI / 2, pitch: 0 });
    await new Promise((r) => setTimeout(r, 300));
    c.send({ t: 'input', f: 0, b: 0, l: 0, r: 0, yaw: -Math.PI / 2, pitch: 0 });
    await new Promise((r) => setTimeout(r, 100));
    for (const m of c.msgs) if (m.t === 'patch') applyPatch(replica, m.patch);
    expect(replica.player.x).toBeGreaterThan(x0 + 0.3);
  });

  it('ações passam pelo servidor e voltam com a resposta', async () => {
    const { port, base } = await start();
    const { body } = await post(base, '/api/register', { username: 'Bia', password: 'senhaforte1' });
    const c = await login(port, body.token);
    await c.waitFor(isT('welcome'));
    c.send({ t: 'cmd', id: 7, c: { t: 'equip', id: 'bolsa_couro' } });
    const r = await c.waitFor((m): m is Extract<ServerMsg, { t: 'result' }> => m.t === 'result' && m.id === 7);
    expect(r.result.ok).toBe(true);
    expect(r.result.message).toContain('vestiu');
    c.send({ t: 'cmd', id: 8, c: { t: 'sleep' } });
    const far = await c.waitFor((m): m is Extract<ServerMsg, { t: 'result' }> => m.t === 'result' && m.id === 8);
    expect(far.result.ok).toBe(true); // o jogador começa na frente da casa
  });

  it('quem não manda o token certo é barrado', async () => {
    const { port } = await start();
    const c = await login(port, 'a'.repeat(64));
    await c.waitFor(isT('error'));
    expect(await c.waitClosed()).toBe(4401);
  });

  it('mensagens antes do login são ignoradas', async () => {
    const { port } = await start();
    const c = new Client(port);
    clients.push(c);
    await c.opened();
    c.send({ t: 'cmd', id: 1, c: { t: 'buyLand' } });
    c.send({ t: 'input', f: 1, b: 0, l: 0, r: 0, yaw: 0, pitch: 0 });
    await new Promise((r) => setTimeout(r, 150));
    expect(c.msgs).toEqual([]);
    expect(app!.sessions.size).toBe(0);
  });

  it('recusa conexão de site desconhecido', async () => {
    const { port } = await start();
    const c = new Client(port, 'https://site-malicioso.example');
    await expect(c.opened()).rejects.toBeTruthy();
    const ok = new Client(port, 'http://localhost:5173');
    clients.push(ok);
    await expect(ok.opened()).resolves.toBeUndefined();
  });

  it('uma conexão por conta: a nova derruba a antiga', async () => {
    const { port, base } = await start();
    const { body } = await post(base, '/api/register', { username: 'Caio', password: 'senhaforte1' });
    const a = await login(port, body.token);
    await a.waitFor(isT('welcome'));
    const b = await login(port, body.token);
    await b.waitFor(isT('welcome'));
    await a.waitFor(isT('kicked'));
    expect(await a.waitClosed()).toBe(4000);
    expect(app!.sessions.size).toBe(1);
  });

  it('o progresso fica guardado: sai, reinicia o servidor e volta igual', async () => {
    const database = db();
    let { port, base } = await start({}, database);
    const { body } = await post(base, '/api/register', { username: 'Duda', password: 'senhaforte1' });
    let c = await login(port, body.token);
    await c.waitFor(isT('welcome'));
    c.send({ t: 'cmd', id: 1, c: { t: 'equip', id: 'bolsa_couro' } });
    await c.waitFor((m): m is Extract<ServerMsg, { t: 'result' }> => m.t === 'result');
    c.ws.close();
    await c.waitClosed();
    await new Promise((r) => setTimeout(r, 100));
    await app!.close();
    app = null;

    ({ port } = await start({}, database));
    c = await login(port, body.token);
    const welcome = await c.waitFor(isT('welcome'));
    expect(welcome.fresh).toBe(false);
    expect(welcome.patch.gear?.bolsa).toBe('bolsa_couro');
  });

  it('o relógio da fazenda para quando a pessoa sai', async () => {
    const { port, base } = await start();
    const { body } = await post(base, '/api/register', { username: 'Edu', password: 'senhaforte1' });
    const c = await login(port, body.token);
    await c.waitFor(isT('welcome'));
    await new Promise((r) => setTimeout(r, 150));
    expect(app!.sessions.size).toBe(1);
    c.ws.close();
    await c.waitClosed();
    await new Promise((r) => setTimeout(r, 100));
    expect(app!.sessions.size).toBe(0);
  });

  it('logout apaga o token', async () => {
    const { port, base } = await start();
    const { body } = await post(base, '/api/register', { username: 'Fabi', password: 'senhaforte1' });
    await post(base, '/api/logout', {}, { Authorization: 'Bearer ' + body.token });
    const c = await login(port, body.token);
    await c.waitFor(isT('error'));
  });

  it('mensagens demais derrubam a conexão', async () => {
    const { port, base } = await start();
    const { body } = await post(base, '/api/register', { username: 'Gabi', password: 'senhaforte1' });
    const c = await login(port, body.token);
    await c.waitFor(isT('welcome'));
    for (let i = 0; i < 300; i++) c.send({ t: 'input', f: 0, b: 0, l: 0, r: 0, yaw: 0, pitch: 0 });
    expect(await c.waitClosed()).toBe(4429);
  });

  it('cada conta tem o seu jogo, sem misturar', async () => {
    const { port, base } = await start();
    const a = await post(base, '/api/register', { username: 'Hugo', password: 'senhaforte1' });
    const b = await post(base, '/api/register', { username: 'Iara', password: 'senhaforte1' });
    const ca = await login(port, a.body.token);
    const cb = await login(port, b.body.token);
    await ca.waitFor(isT('welcome'));
    await cb.waitFor(isT('welcome'));
    ca.send({ t: 'cmd', id: 1, c: { t: 'equip', id: 'bolsa_couro' } });
    await ca.waitFor((m): m is Extract<ServerMsg, { t: 'result' }> => m.t === 'result');
    expect(app!.sessions.size).toBe(2);
    const games = [...app!.sessions.values()].map((s) => s.game.player.gear.bolsa);
    expect(games.sort()).toEqual(['bolsa_couro', 'bolsa_pano']);
  });
});
