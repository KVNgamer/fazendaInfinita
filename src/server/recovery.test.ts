import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { hashPassword, hashRecovery, newRecoveryCode, normalizeRecovery } from './auth';
import { createApp } from './app';
import type { App } from './app';
import { Lock } from './lock';
import { testDb } from './testdb';

describe('código de recuperação (formato)', () => {
  it('tem 16 caracteres em grupos de 4, sem letras confusas, e cada um é diferente', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = newRecoveryCode();
      expect(c).toMatch(/^[A-HJKMNP-TV-Z2-9]{4}(-[A-HJKMNP-TV-Z2-9]{4}){3}$/);
      seen.add(c);
    }
    expect(seen.size).toBe(200);
  });

  it('aceita minúsculas, espaços e traços a mais; recusa o que não parece um código', () => {
    const c = newRecoveryCode();
    expect(normalizeRecovery(c.toLowerCase().replace(/-/g, ' '))).toBe(c.replace(/-/g, ''));
    expect(normalizeRecovery('  ' + c + '  ')).toBe(c.replace(/-/g, ''));
    expect(normalizeRecovery('curto')).toBeNull();
    expect(normalizeRecovery(123)).toBeNull();
    expect(normalizeRecovery('A'.repeat(500))).toBeNull();
  });
});

describe('fila das operações', () => {
  it('roda uma de cada vez, na ordem, e uma que falha não trava as outras', async () => {
    const lock = new Lock();
    const log: string[] = [];
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    expect(lock.busy).toBe(false);
    const a = lock.run(async () => { log.push('a1'); await wait(20); log.push('a2'); return 1; });
    const b = lock.run(async () => { log.push('b'); throw new Error('falhou'); });
    const c = lock.run(() => { log.push('c'); return 3; });
    expect(lock.busy).toBe(true);
    expect(await a).toBe(1);
    await expect(b).rejects.toThrow('falhou');
    expect(await c).toBe(3);
    expect(log).toEqual(['a1', 'a2', 'b', 'c']);
    expect(lock.busy).toBe(false);
  });
});

describe('recuperar a senha pela rede', () => {
  let app: App | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const w of sockets.splice(0)) w.close();
    await app?.close();
    app = null;
  });

  async function start(authPerMinute = 100) {
    const db = await testDb();
    app = await createApp({ db, port: 0, tickMs: 10, authPerMinute, sessionOptions: { saveEvery: 999 } });
    const base = 'http://127.0.0.1:' + app.port;
    const post = async (path: string, body: unknown, token?: string) => {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, string> };
    };
    return { db, post };
  }

  it('ao criar a conta vem um código, e o banco guarda só o resumo', async () => {
    const { db, post } = await start();
    const r = await post('/api/register', { username: 'Rita', password: 'senha-antiga-1' });
    expect(r.status).toBe(200);
    expect(r.body.recovery).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
    const row = (await db.findUser('Rita'))!;
    expect(row.recoveryHash).toBe(hashRecovery(r.body.recovery.replace(/-/g, '')));
    expect(row.recoveryHash).not.toContain(r.body.recovery.replace(/-/g, ''));
    const login = await post('/api/login', { username: 'Rita', password: 'senha-antiga-1' });
    expect(login.body.recovery).toBeUndefined(); // o código só aparece uma vez
  });

  it('com o código certo troca a senha, derruba as sessões antigas e entrega um código novo', async () => {
    const { post } = await start();
    const reg = await post('/api/register', { username: 'Rita', password: 'senha-antiga-1' });
    const code = reg.body.recovery;
    const oldToken = reg.body.token;

    const wrong = await post('/api/recover', { username: 'Rita', code: 'AAAA-BBBB-CCCC-DDDD', password: 'senha-nova-123' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('Nome ou código incorretos.');

    // digitado do jeito que a pessoa digita: minúsculas e sem traços
    const typed = code.toLowerCase().replace(/-/g, ' ');
    const ok = await post('/api/recover', { username: 'rita', code: typed, password: 'senha-nova-123' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect(ok.body.recovery).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
    expect(ok.body.recovery).not.toBe(code);

    expect((await post('/api/login', { username: 'Rita', password: 'senha-antiga-1' })).status).toBe(401);
    expect((await post('/api/login', { username: 'Rita', password: 'senha-nova-123' })).status).toBe(200);

    // o código usado não vale mais
    const again = await post('/api/recover', { username: 'Rita', code, password: 'outra-senha-456' });
    expect(again.status).toBe(401);

    // a sessão antiga foi apagada: o jogo recusa o token
    const ws = new WebSocket('ws://127.0.0.1:' + app!.port + '/ws');
    sockets.push(ws);
    const closed = new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    ws.on('error', () => {});
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'auth', token: oldToken }));
    expect(await closed).toBe(4401);
  });

  it('a mesma resposta para nome inexistente, conta sem código e código errado', async () => {
    const { db, post } = await start();
    await db.createUser('Antiga', await hashPassword('senha-antiga-1')); // conta de antes do código
    await post('/api/register', { username: 'Rita', password: 'senha-antiga-1' });
    // a senha nova precisa ser válida antes de qualquer outra coisa
    expect((await post('/api/recover', { username: 'Rita', code: 'x', password: 'curta' })).status).toBe(400);
    const body = (username: string, code: string) => ({ username, code, password: 'senha-nova-123' });
    const results = [
      await post('/api/recover', body('Fantasma', 'AAAA-BBBB-CCCC-DDDD')),
      await post('/api/recover', body('Antiga', 'AAAA-BBBB-CCCC-DDDD')),
      await post('/api/recover', body('Rita', 'AAAA-BBBB-CCCC-DDDD')),
      await post('/api/recover', body('ab', 'AAAA-BBBB-CCCC-DDDD')),
    ];
    for (const r of results) {
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('Nome ou código incorretos.');
    }
  });

  it('tentativas demais por endereço são barradas', async () => {
    const { post } = await start();
    await post('/api/register', { username: 'Rita', password: 'senha-antiga-1' });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await post('/api/recover', { username: 'Rita', code: 'AAAA-BBBB-CCCC-DDDD', password: 'senha-nova-123' })).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it('gerar outro código exige sessão e a senha; o anterior deixa de valer (também para contas antigas)', async () => {
    const { db, post } = await start();
    const reg = await post('/api/register', { username: 'Rita', password: 'senha-antiga-1' });
    const token = reg.body.token;
    expect((await post('/api/recovery-code', { password: 'senha-antiga-1' })).status).toBe(401); // sem sessão
    expect((await post('/api/recovery-code', { password: 'errada-errada' }, token)).status).toBe(401);
    const fresh = await post('/api/recovery-code', { password: 'senha-antiga-1' }, token);
    expect(fresh.status).toBe(200);
    expect(fresh.body.recovery).not.toBe(reg.body.recovery);
    expect((await post('/api/recover', { username: 'Rita', code: reg.body.recovery, password: 'senha-nova-123' })).status).toBe(401);
    expect((await post('/api/recover', { username: 'Rita', code: fresh.body.recovery, password: 'senha-nova-123' })).status).toBe(200);

    // conta sem código (criada antes deste recurso) também pode gerar um logada
    await db.createUser('Velha', await hashPassword('senha-velha-12'));
    const login = await post('/api/login', { username: 'Velha', password: 'senha-velha-12' });
    const code = await post('/api/recovery-code', { password: 'senha-velha-12' }, login.body.token);
    expect(code.status).toBe(200);
    expect((await db.findUser('Velha'))!.recoveryHash).toBe(hashRecovery(code.body.recovery.replace(/-/g, '')));
  });

  it('o jogo conectado cai na hora quando a senha é trocada por recuperação', async () => {
    const { post } = await start();
    const reg = await post('/api/register', { username: 'Rita', password: 'senha-antiga-1' });
    const ws = new WebSocket('ws://127.0.0.1:' + app!.port + '/ws');
    sockets.push(ws);
    ws.on('error', () => {});
    const welcomed = new Promise<void>((resolve) => ws.on('message', (d) => { if (JSON.parse(d.toString()).t === 'welcome') resolve(); }));
    const closed = new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'auth', token: reg.body.token }));
    await welcomed;
    expect((await post('/api/recover', { username: 'Rita', code: reg.body.recovery, password: 'senha-nova-123' })).status).toBe(200);
    expect(await closed).toBe(4401);
  });

  it('atrás de um proxy, o limite vale para o IP do cabeçalho, não para o endereço do proxy', async () => {
    const db = await testDb();
    app = await createApp({ db, port: 0, tickMs: 10, authPerMinute: 2, clientIpHeader: 'CF-Connecting-IP', sessionOptions: { saveEvery: 999 } });
    const login = async (ip: string) => (await fetch('http://127.0.0.1:' + app!.port + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ username: 'ninguem', password: 'senha-qualquer-1' }),
    })).status;
    expect([await login('1.1.1.1'), await login('1.1.1.1'), await login('1.1.1.1')]).toEqual([401, 401, 429]);
    // outra pessoa, mesmo proxy: não é afetada
    expect(await login('2.2.2.2')).toBe(401);
  });
});
