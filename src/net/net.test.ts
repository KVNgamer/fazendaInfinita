import { describe, expect, it } from 'vitest';
import { Game } from '../core/game';
import { serialize } from '../core/save';
import type { MoveInput } from '../core/player';
import { MAX_MESSAGE_BYTES, parseClientMsg, parseCommand } from './protocol';
import { RESYNC_EVERY, Snapshotter, applyPatch } from './snapshot';

const NO_MOVE: MoveInput = { f: 0, b: 0, l: 0, r: 0, tl: 0, tr: 0 };

/** O jogo como o servidor e a cópia o enxergam, sem a hora do salvamento. */
function view(g: Game) {
  const s = serialize(g) as unknown as Record<string, unknown>;
  delete s.savedAt;
  return JSON.parse(JSON.stringify(s));
}

function pair() {
  const server = new Game(() => 0.99);
  const replica = new Game();
  const snap = new Snapshotter();
  applyPatch(replica, snap.full(server, true));
  return { server, replica, snap };
}

function sync(p: ReturnType<typeof pair>) {
  applyPatch(p.replica, p.snap.diff(p.server), { snapDistance: 1 });
}

describe('mensagens do navegador', () => {
  it('aceita entrada de movimento bem formada', () => {
    expect(parseClientMsg(JSON.stringify({ t: 'input', f: 1, b: 0, l: 0, r: 1, yaw: 1.5, pitch: -0.2 }))).toEqual({ t: 'input', f: 1, b: 0, l: 0, r: 1, yaw: 1.5, pitch: -0.2 });
  });

  it('recusa entrada fora do formato', () => {
    const bad = [
      { t: 'input', f: 2, b: 0, l: 0, r: 0, yaw: 0, pitch: 0 },
      { t: 'input', f: 1, b: 0, l: 0, r: 0, yaw: 'x', pitch: 0 },
      { t: 'input', f: 1, b: 0, l: 0, r: 0, yaw: null, pitch: 0 },
      { t: 'input', f: 1, b: 0, l: 0, yaw: 0, pitch: 0 },
    ];
    for (const m of bad) expect(parseClientMsg(JSON.stringify(m))).toBeNull();
    expect(parseClientMsg('{"t":"input","f":1,"b":0,"l":0,"r":0,"yaw":1e999,"pitch":0}')).toBeNull();
  });

  it('recusa lixo: texto que não é JSON, tipos desconhecidos, mensagem enorme', () => {
    expect(parseClientMsg('isso não é json')).toBeNull();
    expect(parseClientMsg('[]')).toBeNull();
    expect(parseClientMsg('null')).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'hackear' }))).toBeNull();
    expect(parseClientMsg('x'.repeat(MAX_MESSAGE_BYTES + 1))).toBeNull();
  });

  it('auth precisa de um token em texto', () => {
    expect(parseClientMsg('{"t":"auth","token":"abc"}')).toEqual({ t: 'auth', token: 'abc' });
    expect(parseClientMsg('{"t":"auth","token":""}')).toBeNull();
    expect(parseClientMsg('{"t":"auth","token":5}')).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'auth', token: 'a'.repeat(500) }))).toBeNull();
  });

  it('comandos: valores dentro dos limites', () => {
    expect(parseCommand({ t: 'select', slot: 3 })).toEqual({ t: 'select', slot: 3 });
    expect(parseCommand({ t: 'select', slot: 9 })).toBeNull();
    expect(parseCommand({ t: 'select', slot: 1.5 })).toBeNull();
    expect(parseCommand({ t: 'buy', key: 'semente', n: 10 })).toEqual({ t: 'buy', key: 'semente', n: 10 });
    expect(parseCommand({ t: 'buy', key: 'semente', n: -1 })).toBeNull();
    expect(parseCommand({ t: 'buy', key: 'ouro_falso', n: 1 })).toBeNull();
    expect(parseCommand({ t: 'buyGold', n: 1e9 })).toBeNull();
    expect(parseCommand({ t: 'openBox', kind: 'diamante' })).toBeNull();
    expect(parseCommand({ t: 'speed', speed: 100 })).toBeNull();
    expect(parseCommand({ t: 'unequip', slot: 'cabeca' })).toBeNull();
    expect(parseCommand({ t: 'apagarTudo' })).toBeNull();
    expect(parseCommand('use')).toBeNull();
  });

  it('prioridades: precisam ser as quatro tarefas, sem repetir, com quatro valores', () => {
    const ok = { t: 'prios', worker: 'Tião', order: ['Colher', 'Regar', 'Plantar', 'Preparar'], on: [true, true, false, true] };
    expect(parseCommand(ok)).toEqual(ok);
    expect(parseCommand({ ...ok, order: ['Colher', 'Colher', 'Plantar', 'Preparar'] })).not.toBeNull(); // repetição: o jogo recusa depois
    expect(parseCommand({ ...ok, order: ['Colher', 'Regar', 'Plantar'] })).toBeNull();
    expect(parseCommand({ ...ok, order: ['Colher', 'Regar', 'Plantar', 'Hackear'] })).toBeNull();
    expect(parseCommand({ ...ok, on: [true, 'sim', true, true] })).toBeNull();
  });

  it('mover itens: lugares conhecidos', () => {
    const m = { t: 'move', from: { at: 'bag' }, to: { at: 'worker', name: 'Zeca' }, key: 'enxada', n: 1 };
    expect(parseCommand(m)).toEqual(m);
    expect(parseCommand({ ...m, to: { at: 'lua' } })).toBeNull();
    expect(parseCommand({ ...m, to: { at: 'worker' } })).toBeNull();
  });
});

describe('sincronização do servidor com a cópia', () => {
  it('a atualização completa deixa a cópia igual ao servidor', () => {
    const { server, replica } = pair();
    expect(view(replica)).toEqual(view(server));
  });

  it('só manda o que mudou', () => {
    const p = pair();
    sync(p);
    const quiet = p.snap.diff(p.server);
    expect(Object.keys(quiet)).toEqual(['rt']);
    p.server.player.silver += 5;
    const next = p.snap.diff(p.server);
    expect(Object.keys(next).sort()).toEqual(['player', 'rt']);
  });

  it('acompanha ações do jogador: plantar, equipar, comprar terreno', () => {
    const p = pair();
    p.server.player.silver = 5000;
    p.server.player.x = 4 - 1.4;
    p.server.player.z = 5;
    p.server.player.yaw = -Math.PI / 2;
    p.server.selected = 0;
    p.server.useSelected();
    p.server.equip('bolsa_couro');
    p.server.buyLand();
    p.server.hotbar[8] = 'foice';
    sync(p);
    const a = view(p.server);
    const b = view(p.replica);
    delete a.player.x; delete a.player.z; delete b.player.x; delete b.player.z;
    expect(b).toEqual(a);
    expect(p.replica.farm.tiles.length).toBe(150);
    expect(p.replica.bounds).toEqual(p.server.bounds);
  });

  it('acompanha um dia inteiro em modo automático', () => {
    const p = pair();
    p.server.enterAuto();
    p.server.setSpeed(15);
    for (let k = 0; k < 120; k++) {
      p.server.step(0.5, NO_MOVE);
      sync(p);
    }
    expect(p.replica.day).toBe(p.server.day);
    expect(Math.round(p.replica.clock)).toBe(Math.round(p.server.clock));
    expect(p.replica.store).toEqual(p.server.store);
    expect(view(p.replica).farm).toEqual(view(p.server).farm);
  });

  it('trabalhador novo (de caixa) chega à cópia com a ficha completa', () => {
    const p = pair();
    let n = 0;
    const server = new Game(() => [0.96, 0, 0.5][Math.min(n++, 2)]);
    const snap = new Snapshotter();
    const replica = new Game();
    applyPatch(replica, snap.full(server, true));
    server.player.silver = 300;
    server.openBox('prata');
    applyPatch(replica, snap.diff(server), { snapDistance: 1 });
    expect(replica.workers.length).toBe(4);
    const w = replica.workers[3];
    expect(w.name).toBe(server.workers[3].name);
    expect(w.abilities).toEqual(server.workers[3].abilities);
    expect(w.lv).toEqual(server.workers[3].lv);
    void p;
  });

  it('recomeçar manda tudo de novo e a cópia volta ao começo', () => {
    const p = pair();
    p.server.player.silver = 99999;
    p.server.buyLand();
    sync(p);
    expect(p.replica.farm.tiles.length).toBe(150);
    p.server.reset();
    const patch = p.snap.diff(p.server);
    expect(patch.reset).toBe(true);
    applyPatch(p.replica, patch, { snapDistance: 1 });
    expect(p.replica.farm.tiles.length).toBe(100);
    expect(p.replica.player.silver).toBe(100);
    expect(view(p.replica)).toEqual(view(p.server));
  });

  it('a posição do jogador só é corrigida se a cópia errar por mais que o limite', () => {
    const p = pair();
    p.replica.player.x = p.server.player.x + 0.4;
    sync(p);
    expect(p.replica.player.x).toBeCloseTo(p.server.player.x + 0.4);
    p.server.player.silver++; // força o envio da seção do jogador
    p.replica.player.x = p.server.player.x + 3;
    sync(p);
    expect(p.replica.player.x).toBeCloseTo(p.server.player.x);
  });

  it('a animação da cópia entre atualizações fica perto do servidor', () => {
    const p = pair();
    p.server.enterAuto();
    p.server.setSpeed(5);
    sync(p);
    for (let k = 0; k < 150; k++) {
      p.server.step(0.1, NO_MOVE);
      p.replica.animate(0.1);
    }
    sync(p);
    p.server.step(0.1, NO_MOVE);
    p.replica.animate(0.1);
    p.server.workers.forEach((w, i) => {
      const r = p.replica.workers[i];
      expect(Math.hypot(w.x - r.x, w.z - r.z)).toBeLessThan(1);
    });
  });

  it('uma mudança feita só na cópia (trapaça) é desfeita na ressincronização', () => {
    const p = pair();
    p.replica.player.silver = 99999;
    p.replica.farm.tiles[0].state = 'planted';
    for (let i = 0; i < RESYNC_EVERY - 1; i++) sync(p);
    expect(p.replica.player.silver).toBe(99999);
    sync(p);
    expect(p.replica.player.silver).toBe(p.server.player.silver);
    expect(p.replica.farm.tiles[0].state).toBe(p.server.farm.tiles[0].state);
  });

  it('a ressincronização não mexe no slot escolhido da hotbar', () => {
    const p = pair();
    p.replica.selected = 4;
    for (let i = 0; i < RESYNC_EVERY; i++) sync(p);
    expect(p.replica.selected).toBe(4);
  });

  it('a reserva de solo dos trabalhadores acompanha a tarefa', () => {
    const p = pair();
    p.server.enterAuto();
    p.server.setSpeed(15);
    for (let k = 0; k < 40; k++) p.server.step(0.5, NO_MOVE);
    sync(p);
    const busy = p.replica.workers.filter((w) => w.task?.tile);
    for (const w of busy) expect(w.task!.tile!.reserved).toBe(w);
  });
});
