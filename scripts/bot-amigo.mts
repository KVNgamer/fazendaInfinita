// Robô de teste (descartável): entra como outro jogador, aceita pedidos de amizade, deixa
// os amigos assistirem e ajudarem na fazenda dele e, se você indicar um nome, pede amizade.
//   npm run bot:amigo            entra como amigo_teste e espera pedidos
//   npm run bot:amigo -- seu_nome  também pede amizade a "seu_nome"
import WebSocket from 'ws';
import { Game } from '../src/core/game';
import { applyPatch } from '../src/net/snapshot';
import type { Command, CommandResult, ServerMsg } from '../src/net/protocol';
import type { SocialData } from '../src/core/social';

const base = 'http://127.0.0.1:3001';
const name = 'amigo_teste';
const target = process.argv[2];
const pass = 'bot-senha-2026-x';

async function token(): Promise<string> {
  const body = JSON.stringify({ username: name, password: pass });
  const h = { 'Content-Type': 'application/json' };
  let r = await fetch(base + '/api/register', { method: 'POST', headers: h, body });
  if (r.status === 409) r = await fetch(base + '/api/login', { method: 'POST', headers: h, body });
  return ((await r.json()) as { token: string }).token;
}

const game = new Game();
const ws = new WebSocket('ws://127.0.0.1:3001/ws');
const pending = new Map<number, (r: CommandResult) => void>();
let nextId = 1;
let welcome: () => void = () => {};
const welcomed = new Promise<void>((r) => (welcome = r));

ws.on('message', (d) => {
  const m = JSON.parse(d.toString()) as ServerMsg;
  if (m.t === 'welcome') {
    applyPatch(game, m.patch);
    welcome();
  } else if (m.t === 'patch') applyPatch(game, m.patch, { snapDistance: 0 });
  else if (m.t === 'result') pending.get(m.id)?.(m.result);
  else if (m.t === 'msg') console.log('aviso:', m.text);
});

function send(c: Command): Promise<CommandResult> {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ t: 'cmd', id, c }));
  });
}

// o jogo do robô fica parado em casa, sem se mexer
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'input', f: 0, b: 0, l: 0, r: 0, yaw: 0, pitch: 0 }));
}, 200);

async function round(): Promise<void> {
  const data = (await send({ t: 'social' })).data as SocialData;
  for (const n of data.incoming) console.log('aceitei', n, (await send({ t: 'friendAnswer', name: n, accept: true })).message);
  for (const f of data.friends) {
    if (f.iAllow !== 2) console.log('permissão total para', f.name, (await send({ t: 'friendPerm', name: f.name, level: 2 })).message);
  }
}

ws.on('open', async () => {
  ws.send(JSON.stringify({ t: 'auth', token: await token() }));
  await welcomed;
  console.log('conectado como', name);
  if (target) console.log('pedido a', target + ':', (await send({ t: 'friendRequest', name: target })).message);
  await round();
  setInterval(() => void round(), 2000);
  console.log('robô fica conectado, aceitando amigos');
});
