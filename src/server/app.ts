import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { Rng } from '../core/rng';
import { MAX_MESSAGE_BYTES, parseClientMsg } from '../net/protocol';
import type { ServerMsg } from '../net/protocol';
import { RateLimiter, SESSION_DAYS, dummyHash, hashPassword, hashRecovery, hashToken, newRecoveryCode, newToken, normalizeRecovery, sameHash, validPassword, validUsername, verifyPassword } from './auth';
import { Lock } from './lock';
import type { Db } from './db';
import { Market } from './market';
import { Social } from './social';
import { GameSession } from './session';

export interface AppOptions {
  db: Db;
  port: number;
  /** Endereço onde escuta. Por padrão só este computador; para outras máquinas, use 0.0.0.0. */
  host?: string;
  /** Pasta do site já compilado (`npm run build`). Se não existir, só a API e o WebSocket respondem. */
  staticDir?: string;
  /** Cabeçalho com o IP real de quem chama, quando há um proxy na frente (por exemplo cf-connecting-ip). */
  clientIpHeader?: string;
  /** Origens extras aceitas além de localhost. */
  allowedOrigins?: string[];
  rng?: Rng;
  tickMs?: number;
  /** Quantas tentativas de login/cadastro por minuto, por endereço. */
  authPerMinute?: number;
  sessionOptions?: Omit<NonNullable<ConstructorParameters<typeof GameSession>[5]>, 'lock'>;
  /** Relógio em milissegundos (para os testes do mercado). */
  now?: () => number;
  log?: (text: string) => void;
}

export interface App {
  server: Server;
  port: number;
  sessions: Map<number, GameSession>;
  market: Market;
  social: Social;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

async function readBody(req: IncomingMessage, limit = 4096): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('grande demais');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Endereço de quem chamou. Atrás de um proxy (Cloudflare, Fly) o endereço da conexão é o do proxy, igual para todos;
 * então, se o servidor foi configurado com `clientIpHeader`, vale o cabeçalho (só use atrás do proxy que o escreve:
 * quem chega direto ao servidor poderia inventar o valor).
 */
function clientIp(req: IncomingMessage, header?: string): string {
  if (header) {
    const v = req.headers[header.toLowerCase()];
    const first = (Array.isArray(v) ? v[0] : v)?.split(',')[0].trim();
    if (first && first.length <= 64) return first;
  }
  return req.socket.remoteAddress ?? 'desconhecido';
}

export async function createApp(opts: AppOptions): Promise<App> {
  const { db } = opts;
  const log = opts.log ?? (() => {});
  const limiter = new RateLimiter(opts.authPerMinute ?? 10, 60_000);
  // recuperar senha tem limite próprio, mais apertado, por endereço e por conta
  const recoverByIp = new RateLimiter(5, 60_000);
  const recoverByUser = new RateLimiter(10, 3_600_000);
  const lock = new Lock();
  const sessions = new Map<number, GameSession>();
  const sockets = new Map<number, WebSocket>();
  const allowed = new Set(opts.allowedOrigins ?? []);
  const market = new Market(db, (id) => sessions.get(id), opts.now);
  const social = new Social(db, (id) => sessions.get(id));

  const originOk = (origin: string | undefined): boolean => {
    if (!origin) return true; // clientes que não são navegador (testes, ferramentas)
    return allowed.has(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  };

  async function startSession(res: ServerResponse, userId: number, username: string, recovery?: string): Promise<void> {
    const { token, hash } = newToken();
    await db.createSession(userId, hash, Date.now() + SESSION_DAYS * 86_400_000);
    json(res, 200, recovery ? { token, user: username, recovery } : { token, user: username });
  }

  /** Um novo código de recuperação, mostrado uma vez só: o banco guarda apenas o resumo. */
  async function issueRecovery(userId: number): Promise<string> {
    const code = newRecoveryCode();
    await db.setRecovery(userId, hashRecovery(code.replace(/-/g, '')));
    return code;
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (path === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
    if (req.method !== 'POST') return json(res, 405, { error: 'Método não permitido.' });
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'Envie JSON.' });

    if (path === '/api/logout') {
      const auth = req.headers.authorization ?? '';
      if (auth.startsWith('Bearer ')) await db.deleteSession(hashToken(auth.slice(7)));
      return json(res, 200, { ok: true });
    }
    if (path !== '/api/register' && path !== '/api/login' && path !== '/api/recover' && path !== '/api/recovery-code') return json(res, 404, { error: 'Não encontrado.' });

    if (!limiter.allow(clientIp(req, opts.clientIpHeader), Date.now())) return json(res, 429, { error: 'Muitas tentativas. Espere um minuto.' });
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { error: 'Pedido inválido.' });
    }
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

    if (path === '/api/register') {
      if (!validUsername(b.username)) return json(res, 400, { error: 'Nome de 3 a 20 letras, números ou _.' });
      if (!validPassword(b.password)) return json(res, 400, { error: 'A senha precisa ter de 8 a 128 caracteres.' });
      const code = newRecoveryCode();
      const id = await db.createUser(b.username, await hashPassword(b.password), hashRecovery(code.replace(/-/g, '')));
      if (id === null) return json(res, 409, { error: 'Esse nome já está em uso.' });
      log('Conta criada: ' + b.username);
      return startSession(res, id, b.username, code);
    }

    // esqueci a senha: o código de recuperação (dado ao criar a conta) vale uma vez e é trocado por outro
    if (path === '/api/recover') {
      const wrong = () => json(res, 401, { error: 'Nome ou código incorretos.' });
      if (!recoverByIp.allow(clientIp(req, opts.clientIpHeader), Date.now())) return json(res, 429, { error: 'Muitas tentativas. Espere um minuto.' });
      if (!validPassword(b.password)) return json(res, 400, { error: 'A nova senha precisa ter de 8 a 128 caracteres.' });
      if (!validUsername(b.username) || !recoverByUser.allow(b.username.toLowerCase(), Date.now())) return wrong();
      const code = normalizeRecovery(b.code);
      const target = await db.findUser(b.username);
      // o mesmo trabalho (e a mesma resposta) quando o nome não existe, a conta não tem código ou o código está errado
      const expected = target?.recoveryHash ?? hashRecovery('0'.repeat(16));
      const match = sameHash(hashRecovery(code ?? '1'.repeat(16)), expected);
      if (!target || !target.recoveryHash || !code || !match) return wrong();
      const fresh = newRecoveryCode();
      await db.resetCredentials(target.id, await hashPassword(b.password), hashRecovery(fresh.replace(/-/g, '')));
      // quem tinha a senha antiga (ou a sessão) perde o acesso
      await db.deleteSessionsOf(target.id);
      sockets.get(target.id)?.close(4401, 'Senha trocada');
      log('Senha recuperada: ' + target.username);
      return startSession(res, target.id, target.username, fresh);
    }

    // gerar um novo código (para contas antigas ou para trocar o que foi perdido): precisa da sessão e da senha
    if (path === '/api/recovery-code') {
      const auth = req.headers.authorization ?? '';
      const found = auth.startsWith('Bearer ') ? await db.findSession(hashToken(auth.slice(7)), Date.now()) : null;
      if (!found) return json(res, 401, { error: 'Entre de novo.' });
      const me = await db.findUserById(found.userId);
      const okPass = me && typeof b.password === 'string' && b.password.length <= 128 && (await verifyPassword(b.password, me.passHash));
      if (!okPass) return json(res, 401, { error: 'Senha incorreta.' });
      return json(res, 200, { recovery: await issueRecovery(found.userId) });
    }

    // login: a mesma resposta (e o mesmo tempo) para nome inexistente e senha errada
    const user = validUsername(b.username) ? await db.findUser(b.username) : null;
    const ok = typeof b.password === 'string' && b.password.length <= 128
      ? await verifyPassword(b.password, user ? user.passHash : await dummyHash())
      : false;
    if (!user || !ok) return json(res, 401, { error: 'Nome ou senha incorretos.' });
    return startSession(res, user.id, user.username);
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): void {
    const dir = opts.staticDir;
    if (!dir || !existsSync(dir) || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end();
      return;
    }
    const rel = normalize(path).replace(/^([/\\])+/, '');
    let file = join(dir, rel || 'index.html');
    // precisa ficar DENTRO da pasta do site ("dist-outra" começa com "dist" mas não está dentro dela)
    if (file !== dir && !file.startsWith(dir + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  }

  const server = createServer((req, res) => {
    // um endereço malformado não pode derrubar o servidor
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (path.startsWith('/api/')) {
      handleApi(req, res, path).catch((e) => {
        log('Erro na API: ' + (e as Error).message);
        if (!res.headersSent) json(res, 500, { error: 'Erro no servidor.' });
      });
      return;
    }
    try {
      serveStatic(req, res, path);
    } catch (e) {
      log('Erro ao servir arquivo: ' + (e as Error).message);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: MAX_MESSAGE_BYTES,
    verifyClient: (info: { origin: string }) => originOk(info.origin),
  });

  wss.on('connection', (ws) => {
    let session: GameSession | null = null;
    let userId = 0;
    const send = (msg: ServerMsg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    // quem não se identifica logo é desconectado
    const authTimer = setTimeout(() => {
      if (!session) ws.close(4401, 'Sem login');
    }, 5000);
    let windowStart = Date.now();
    let windowCount = 0;

    let authenticating = false;

    /** Entra na fila: fecha o jogo antigo da conta, carrega o save e abre o novo jogo. */
    async function authenticate(token: string): Promise<void> {
      const found = await db.findSession(hashToken(token), Date.now());
      if (!found) {
        send({ t: 'error', text: 'Sessão expirada. Entre de novo.' });
        ws.close(4401, 'Sessão inválida');
        return;
      }
      clearTimeout(authTimer);
      // uma conexão por conta: a nova derruba a antiga
      const old = sockets.get(found.userId);
      if (old && old !== ws) {
        old.send(JSON.stringify({ t: 'kicked', reason: 'Você entrou em outro lugar.' } satisfies ServerMsg));
        old.close(4000, 'Outra conexão');
      }
      userId = found.userId;
      sockets.set(userId, ws);
      await lock.run(async () => {
        const previous = sessions.get(userId);
        sessions.delete(userId);
        await previous?.close();
        const created = new GameSession(userId, found.username, await db.loadSave(userId), db, { send }, { rng: opts.rng, market, social, ...opts.sessionOptions, lock });
        sessions.set(userId, created);
        session = created;
        // correio e aluguéis que mudaram enquanto a pessoa estava fora entram antes de ela ver o jogo
        await market.reconcile(created);
        await market.deliver(userId);
        created.start();
        log(found.username + ' entrou');
        // a conexão caiu enquanto o jogo abria
        if (ws.readyState !== ws.OPEN && sockets.get(userId) === ws) {
          sessions.delete(userId);
          sockets.delete(userId);
          await created.close();
        }
      });
    }

    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        windowCount = 0;
      }
      if (++windowCount > 120) {
        ws.close(4429, 'Mensagens demais');
        return;
      }
      if (isBinary) return;
      const msg = parseClientMsg(data.toString());
      if (!msg) return;
      if (!session) {
        if (msg.t !== 'auth' || authenticating) return;
        authenticating = true;
        authenticate(msg.token)
          .catch((e) => {
            log('Erro ao entrar: ' + (e as Error).message);
            ws.close(1011, 'Erro no servidor');
          })
          .finally(() => {
            authenticating = false;
          });
        return;
      }
      session.onMessage(msg).catch((e) => log('Erro numa ação de ' + session?.username + ': ' + (e as Error).message));
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (session && sockets.get(userId) === ws) {
        const closing = session;
        sessions.delete(userId);
        sockets.delete(userId);
        lock.run(() => closing.close()).catch((e) => log('Erro ao fechar o jogo de ' + closing.username + ': ' + (e as Error).message));
        log(closing.username + ' saiu');
      }
    });
    ws.on('error', () => ws.close());
  });

  const tickMs = opts.tickMs ?? 50;
  let last = Date.now();
  const ticker = setInterval(() => {
    const now = Date.now();
    const dt = (now - last) / 1000;
    last = now;
    for (const s of sessions.values()) {
      try {
        s.tick(dt);
      } catch (e) {
        log('Erro no jogo de ' + s.username + ': ' + (e as Error).message);
      }
    }
  }, tickMs);
  const purger = setInterval(() => {
    db.purgeSessions(Date.now()).catch((e) => log('Erro ao limpar sessões: ' + (e as Error).message));
  }, 3_600_000);
  const expirer = setInterval(() => {
    lock.run(() => market.expire()).catch((e) => log('Erro ao vencer anúncios: ' + (e as Error).message));
  }, 60_000);

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host ?? '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;

  return {
    server,
    port,
    sessions,
    market,
    social,
    async close() {
      clearInterval(ticker);
      clearInterval(purger);
      clearInterval(expirer);
      // os jogos ainda abertos são salvos antes de fechar
      for (const s of [...sessions.values()]) await lock.run(() => s.close());
      sessions.clear();
      for (const ws of wss.clients) ws.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
