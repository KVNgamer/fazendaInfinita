// Robô de teste (descartável): entra como outro jogador, anda até o mercado e faz anúncios.
import WebSocket from 'ws';
import { Game } from '../src/core/game';
import { applyPatch } from '../src/net/snapshot';
import type { Command, CommandResult, ServerMsg } from '../src/net/protocol';

const base = 'http://127.0.0.1:3001';
const name = process.argv[2] ?? 'vendedor_teste';
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

let move = { f: 0, yaw: 0 };
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'input', f: move.f, b: 0, l: 0, r: 0, yaw: move.yaw, pitch: 0 }));
}, 50);

async function walkTo(x: number, z: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const dx = x - game.player.x;
    const dz = z - game.player.z;
    if (Math.hypot(dx, dz) < 0.3) break;
    move = { f: 1, yaw: Math.atan2(-dx, -dz) };
    await new Promise((r) => setTimeout(r, 50));
  }
  move = { f: 0, yaw: move.yaw };
  await new Promise((r) => setTimeout(r, 150));
}

ws.on('open', async () => {
  ws.send(JSON.stringify({ t: 'auth', token: await token() }));
  await welcomed;
  console.log('conectado como', name);
  await walkTo(-0.9, 5.2);
  await walkTo(-5.5, 5.2);
  await walkTo(-5.5, 6.1);
  console.log('no mercado em', game.player.x.toFixed(2), game.player.z.toFixed(2));
  const sells: Command[] = [
    { t: 'marketSell', spec: { what: 'item', key: 'semente', qty: 10 }, price: 60, currency: 'silver' },
    { t: 'marketSell', spec: { what: 'gear', id: 'bota_corrida' }, price: 3, currency: 'gold' },
    { t: 'marketSell', spec: { what: 'rent', name: 'Zeca', days: 2 }, price: 40, currency: 'silver' },
    { t: 'marketSell', spec: { what: 'worker', name: 'Cida' }, price: 500, currency: 'silver' },
  ];
  for (const c of sells) console.log((await send(c)).message);
  console.log('anúncios feitos; robô fica conectado');
});
