import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Command, CommandResult, ServerMsg } from '../net/protocol';
import { createApp } from './app';
import type { App } from './app';
import { openDb } from './db';
import { testDb } from './testdb';

class Client {
  readonly msgs: ServerMsg[] = [];
  readonly ws: WebSocket;
  private next = 1;

  constructor(port: number) {
    this.ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    this.ws.on('message', (d) => this.msgs.push(JSON.parse(d.toString())));
    this.ws.on('error', () => {});
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
    });
  }

  async until<T>(find: () => T | undefined, ms = 3000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const v = find();
      if (v !== undefined) return v;
      if (Date.now() - start > ms) throw new Error('demorou demais');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async cmd(c: Command): Promise<CommandResult> {
    const id = this.next++;
    this.ws.send(JSON.stringify({ t: 'cmd', id, c }));
    const m = await this.until(() => this.msgs.find((x): x is Extract<ServerMsg, { t: 'result' }> => x.t === 'result' && x.id === id));
    return m.result;
  }

  count(t: ServerMsg['t']): number {
    return this.msgs.filter((m) => m.t === t).length;
  }
}

describe('amigos e visitas pela rede', () => {
  let app: App | null = null;
  const clients: Client[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.ws.close();
    await app?.close();
    app = null;
  });

  async function register(name: string): Promise<string> {
    const res = await fetch('http://127.0.0.1:' + app!.port + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'senhaforte1' }) });
    return ((await res.json()) as { token: string }).token;
  }

  async function enter(name: string): Promise<Client> {
    const token = await register(name);
    const c = new Client(app!.port);
    clients.push(c);
    await c.opened();
    c.ws.send(JSON.stringify({ t: 'auth', token }));
    await c.until(() => c.msgs.find((m) => m.t === 'welcome'));
    return c;
  }

  it('pedido, aceite, permissão, visita, ajuda e volta para casa', async () => {
    const db = await testDb();
    app = await createApp({ db, port: 0, tickMs: 10, sessionOptions: { sendEvery: 0.02, saveEvery: 999 } });
    const ana = await enter('Ana');
    const beto = await enter('Beto');
    const ids = { Ana: (await db.findUser('Ana'))!.id, Beto: (await db.findUser('Beto'))!.id };
    const gameOf = (n: 'Ana' | 'Beto') => app!.sessions.get(ids[n])!.game;

    expect((await ana.cmd({ t: 'friendRequest', name: 'Beto' })).ok).toBe(true);
    await beto.until(() => (beto.count('social') > 0 ? true : undefined));
    expect((await ana.cmd({ t: 'visit', name: 'Beto' })).ok).toBe(false);
    expect((await beto.cmd({ t: 'friendAnswer', name: 'Ana', accept: true })).ok).toBe(true);
    expect((await ana.cmd({ t: 'visit', name: 'Beto' })).message).toContain('ainda não deixou');
    expect((await beto.cmd({ t: 'friendPerm', name: 'Ana', level: 2 })).ok).toBe(true);

    const energy = gameOf('Ana').player.energy;
    const v = await ana.cmd({ t: 'visit', name: 'Beto' });
    expect(v.ok).toBe(true);
    const start = await ana.until(() => ana.msgs.find((m): m is Extract<ServerMsg, { t: 'visitStart' }> => m.t === 'visitStart'));
    expect(start.host).toBe('Beto');
    expect(start.canHelp).toBe(true);
    expect(start.patch.inv).toBeUndefined();
    const clock = gameOf('Ana').clock;

    // a visita recebe patches do mundo do dono, e o jogo dela não anda
    const before = ana.count('visitPatch');
    await ana.until(() => (ana.count('visitPatch') > before + 2 ? true : undefined));
    expect(gameOf('Ana').clock).toBe(clock);
    expect(gameOf('Beto').visitors).toEqual(['Ana']);
    expect((await ana.cmd({ t: 'buyLand' })).message).toContain('visitando');

    // ajuda: rega um solo do Beto
    const tile = gameOf('Beto').farm.at(0, 0)!;
    expect(tile.wet).toBe(false);
    const h = await ana.cmd({ t: 'help', action: 'water', i: 0, j: 0 });
    expect(h.ok).toBe(true);
    expect(tile.wet).toBe(true);
    expect(gameOf('Ana').player.energy).toBeLessThan(energy);

    // volta para casa
    expect((await ana.cmd({ t: 'leaveVisit' })).ok).toBe(true);
    await ana.until(() => ana.msgs.find((m) => m.t === 'visitEnd'));
    expect(gameOf('Beto').visitors).toEqual([]);
    expect((await ana.cmd({ t: 'help', action: 'water', i: 0, j: 1 })).ok).toBe(false);
  });

  it('quando o dono sai, a visita é encerrada', async () => {
    const db = await testDb();
    app = await createApp({ db, port: 0, tickMs: 10, sessionOptions: { sendEvery: 0.02, saveEvery: 999 } });
    const ana = await enter('Ana');
    const beto = await enter('Beto');
    await ana.cmd({ t: 'friendRequest', name: 'Beto' });
    await beto.cmd({ t: 'friendAnswer', name: 'Ana', accept: true });
    await beto.cmd({ t: 'friendPerm', name: 'Ana', level: 1 });
    expect((await ana.cmd({ t: 'visit', name: 'Beto' })).ok).toBe(true);
    expect((await ana.cmd({ t: 'help', action: 'water', i: 0, j: 0 })).message).toContain('só assistir');
    beto.ws.close();
    const end = await ana.until(() => ana.msgs.find((m): m is Extract<ServerMsg, { t: 'visitEnd' }> => m.t === 'visitEnd'));
    expect(end.reason).toContain('dono saiu');
    expect((await ana.cmd({ t: 'social' })).ok).toBe(true);
  });
});
