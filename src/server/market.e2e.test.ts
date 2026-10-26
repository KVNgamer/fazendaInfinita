import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { MarketData } from '../core/market';
import { sellerGets } from '../core/market';
import { parseCommand } from '../net/protocol';
import type { Command, CommandResult, ServerMsg } from '../net/protocol';
import { createApp } from './app';
import type { App } from './app';
import { openDb } from './db';
import { testDb } from './testdb';

describe('comandos do mercado no protocolo', () => {
  it('aceita anúncios bem formados', async () => {
    expect(parseCommand({ t: 'marketSell', spec: { what: 'item', key: 'semente', qty: 5 }, price: 100, currency: 'silver' })).not.toBeNull();
    expect(parseCommand({ t: 'marketSell', spec: { what: 'rent', name: 'Cida', days: 7 }, price: 50, currency: 'gold' })).not.toBeNull();
    expect(parseCommand({ t: 'marketSell', spec: { what: 'gold', qty: 3 }, price: 900, currency: 'silver' })).not.toBeNull();
    expect(parseCommand({ t: 'market' })).toEqual({ t: 'market' });
    expect(parseCommand({ t: 'market', kind: 'rent' })).toEqual({ t: 'market', kind: 'rent' });
    expect(parseCommand({ t: 'marketBuy', id: 3 })).toEqual({ t: 'marketBuy', id: 3 });
  });

  it('recusa o que está fora do formato ou dos limites', async () => {
    const spec = { what: 'item', key: 'semente', qty: 5 };
    expect(parseCommand({ t: 'marketSell', spec, price: 0, currency: 'silver' })).toBeNull();
    expect(parseCommand({ t: 'marketSell', spec, price: 1.5, currency: 'silver' })).toBeNull();
    expect(parseCommand({ t: 'marketSell', spec, price: 1e9, currency: 'silver' })).toBeNull();
    expect(parseCommand({ t: 'marketSell', spec, price: 10, currency: 'ouro' })).toBeNull();
    expect(parseCommand({ t: 'marketSell', spec: { what: 'item', key: 'diamante', qty: 1 }, price: 10, currency: 'silver' })).toBeNull();
    expect(parseCommand({ t: 'marketSell', spec: { what: 'item', key: 'semente', qty: -1 }, price: 10, currency: 'silver' })).toBeNull();
    expect(parseCommand({ t: 'marketSell', spec: { what: 'rent', name: 'Cida', days: 99 }, price: 10, currency: 'silver' })).toBeNull();
    expect(parseCommand({ t: 'marketSell', spec: { what: 'dar', id: 'x' }, price: 10, currency: 'silver' })).toBeNull();
    expect(parseCommand({ t: 'marketSell', spec: null, price: 10, currency: 'silver' })).toBeNull();
    expect(parseCommand({ t: 'market', kind: 'drogas' })).toBeNull();
    expect(parseCommand({ t: 'marketBuy', id: 0 })).toBeNull();
    expect(parseCommand({ t: 'marketBuy', id: 'um' })).toBeNull();
    expect(parseCommand({ t: 'rentRecall', id: -4 })).toBeNull();
  });
});

class Client {
  readonly msgs: ServerMsg[] = [];
  readonly ws: WebSocket;
  private next = 1;
  closed = false;

  constructor(port: number) {
    this.ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    this.ws.on('message', (d) => this.msgs.push(JSON.parse(d.toString())));
    this.ws.on('close', () => {
      this.closed = true;
    });
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
}

describe('mercado com dois jogadores pela rede', () => {
  let app: App | null = null;
  const clients: Client[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.ws.close();
    await app?.close();
    app = null;
  });

  async function register(base: string, name: string): Promise<string> {
    const res = await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'senhaforte1' }) });
    return ((await res.json()) as { token: string }).token;
  }

  async function enter(token: string): Promise<Client> {
    const c = new Client(app!.port);
    clients.push(c);
    await c.opened();
    c.ws.send(JSON.stringify({ t: 'auth', token }));
    await c.until(() => c.msgs.find((m) => m.t === 'welcome'));
    return c;
  }

  const nearShop = async (name: string, db: ReturnType<typeof openDb>) => {
    const id = (await db.findUser(name))!.id;
    const g = app!.sessions.get(id)!.game;
    g.player.x = -5.5;
    g.player.z = 6.1;
    return g;
  };

  it('só vende perto do mercado', async () => {
    const db = await testDb();
    app = await createApp({ db, port: 0, tickMs: 10, sessionOptions: { sendEvery: 0.02, saveEvery: 999 } });
    const c = await enter(await register('http://127.0.0.1:' + app.port, 'Vera'));
    const r = await c.cmd({ t: 'marketSell', spec: { what: 'item', key: 'semente', qty: 5 }, price: 10, currency: 'silver' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('perto');
  });

  it('vendedor conectado recebe na hora; vendedor ausente recebe ao voltar', async () => {
    const db = await testDb();
    app = await createApp({ db, port: 0, tickMs: 10, sessionOptions: { sendEvery: 0.02, saveEvery: 999 } });
    const base = 'http://127.0.0.1:' + app.port;
    const tokenV = await register(base, 'Vera');
    const tokenB = await register(base, 'Bento');
    const vera = await enter(tokenV);
    const bento = await enter(tokenB);
    const gv = await nearShop('Vera', db);
    const gb = await nearShop('Bento', db);
    gb.player.silver = 1000;

    // Vera anuncia 10 sementes por 100
    const sold = await vera.cmd({ t: 'marketSell', spec: { what: 'item', key: 'semente', qty: 10 }, price: 100, currency: 'silver' });
    expect(sold.ok).toBe(true);
    expect(gv.player.inv.semente).toBe(20);
    expect((sold.data as MarketData).mine[0]).toMatchObject({ kind: 'item', qty: 10, status: 'open' });

    // Bento vê e compra
    const seen = await bento.cmd({ t: 'market' });
    const listing = (seen.data as MarketData).listings[0];
    expect(listing).toMatchObject({ seller: 'Vera', price: 100, mine: false });
    const bought = await bento.cmd({ t: 'marketBuy', id: listing.id });
    expect(bought.ok).toBe(true);
    expect(gb.player.silver).toBe(900);
    expect(gb.store.semente).toBe(30);

    // Vera está conectada: o dinheiro entra na hora e a tela dela recebe
    expect(gv.player.silver).toBe(100 + sellerGets(100));
    await vera.until(() => vera.msgs.find((m) => m.t === 'patch' && m.patch.player?.silver === 100 + sellerGets(100)));
    await vera.until(() => vera.msgs.find((m) => m.t === 'msg' && m.text.includes('vendeu')));

    // segunda venda, com Vera fora
    const again = await vera.cmd({ t: 'marketSell', spec: { what: 'item', key: 'semente', qty: 5 }, price: 50, currency: 'silver' });
    expect(again.ok).toBe(true);
    vera.ws.close();
    await vera.until(() => (vera.closed ? true : undefined));
    await new Promise((r) => setTimeout(r, 150));
    const seen2 = await bento.cmd({ t: 'market' });
    const second = (seen2.data as MarketData).listings.find((l) => l.price === 50)!;
    expect((await bento.cmd({ t: 'marketBuy', id: second.id })).ok).toBe(true);
    expect(await db.pendingMail((await db.findUser('Vera'))!.id)).toHaveLength(1);

    const back = new Client(app.port);
    clients.push(back);
    await back.opened();
    back.ws.send(JSON.stringify({ t: 'auth', token: tokenV }));
    const welcome = await back.until(() => back.msgs.find((m): m is Extract<ServerMsg, { t: 'welcome' }> => m.t === 'welcome'));
    expect(welcome.fresh).toBe(false);
    expect(welcome.patch.player?.silver).toBe(100 + sellerGets(100) + sellerGets(50));
    expect(await db.pendingMail((await db.findUser('Vera'))!.id)).toHaveLength(0);
  });

  it('aluguel: o dono recebe por dia, e o trabalhador volta no fim', async () => {
    const db = await testDb();
    app = await createApp({ db, port: 0, tickMs: 10, sessionOptions: { sendEvery: 0.02, saveEvery: 999 } });
    const base = 'http://127.0.0.1:' + app.port;
    const dono = await enter(await register(base, 'Dora'));
    const loca = await enter(await register(base, 'Luca'));
    const gd = await nearShop('Dora', db);
    const gl = await nearShop('Luca', db);
    gl.player.silver = 1000;

    expect((await dono.cmd({ t: 'marketSell', spec: { what: 'rent', name: 'Cida', days: 2 }, price: 100, currency: 'silver' })).ok).toBe(true);
    expect(gd.workers.map((w) => w.name)).not.toContain('Cida');
    const listing = ((await loca.cmd({ t: 'market' })).data as MarketData).listings[0];
    expect(listing.rent).toMatchObject({ pricePerDay: 100, days: 2, total: 200 });
    expect((await loca.cmd({ t: 'marketBuy', id: listing.id })).ok).toBe(true);
    expect(gl.player.silver).toBe(800);
    const rented = gl.workers.find((w) => w.rental)!;
    expect(rented.rental).toMatchObject({ owner: 'Dora', daysLeft: 2 });

    // dois dias do locatário: o dono recebe 2 vezes e o trabalhador volta
    const ownerSilver = gd.player.silver;
    // o fim do dia roda na fila do servidor: espera terminar
    gl.endDay('sleep');
    gl.endDay('sleep');
    await vi.waitFor(() => expect(gd.workers.map((w) => w.name)).toContain('Cida'));
    expect(gd.player.silver).toBe(ownerSilver + 2 * sellerGets(100));
    expect(gl.workers.find((w) => w.rental)).toBeUndefined();
  });

  it('chamar de volta pela rede devolve os dias que sobraram', async () => {
    const db = await testDb();
    app = await createApp({ db, port: 0, tickMs: 10, sessionOptions: { sendEvery: 0.02, saveEvery: 999 } });
    const base = 'http://127.0.0.1:' + app.port;
    const dono = await enter(await register(base, 'Dora'));
    const loca = await enter(await register(base, 'Luca'));
    await nearShop('Dora', db);
    const gl = await nearShop('Luca', db);
    gl.player.silver = 1000;
    await dono.cmd({ t: 'marketSell', spec: { what: 'rent', name: 'Zeca', days: 4 }, price: 50, currency: 'silver' });
    const id = ((await loca.cmd({ t: 'market' })).data as MarketData).listings[0].id;
    await loca.cmd({ t: 'marketBuy', id });
    expect(gl.player.silver).toBe(800);
    const r = await dono.cmd({ t: 'rentRecall', id });
    expect(r.ok).toBe(true);
    expect(gl.player.silver).toBe(1000);
    expect(gl.workers.find((w) => w.rental)).toBeUndefined();
  });
});
