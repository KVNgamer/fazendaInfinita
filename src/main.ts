import './style.css';
import { getToken, logout, setToken } from './net/account';
import { Remote } from './net/remote';
import { Input } from './input';
import { View } from './render/view';
import { Gate } from './ui/gate';
import { Ui } from './ui/ui';

const remote = new Remote();
const game = remote.game;
const app = document.getElementById('app')!;
const view = new View(app, game);
const ui = new Ui(game, remote);

const gate = new Gate((token) => {
  gate.hideAuth();
  remote.connect(token);
});

const input = new Input(view.canvas, {
  use: () => {
    remote.send({ t: 'use' }).then((r) => ui.usedResult(r)).catch(() => {});
  },
  interact: () => ui.interact(),
  inventory: () => ui.openInventory(),
  workers: () => ui.open('workers'),
  character: () => ui.open('char'),
  lands: () => ui.open('lands'),
  slot: (i) => ui.selectSlot(i),
  toggleLegend: () => ui.toggleLegend(),
  closeModal: () => ui.close(),
  modalOpen: () => ui.modalOpen,
  blocked: () => gate.authVisible || remote.status !== 'online',
  spectating: () => game.mode === 'spec' || remote.visit !== null,
  tap: (x, y) => {
    const t = view.pickTile(x, y);
    if (t) ui.helpAt(t.i, t.j);
  },
  hover: (x, y) => view.setHover(remote.visit ? view.pickTile(x, y) : null),
  friends: () => ui.openFriends(),
  menu: () => ui.toggleMenu(),
  look: (dyaw, dpitch) => {
    game.player.yaw += dyaw;
    game.player.pitch = Math.max(-1.2, Math.min(1.2, game.player.pitch + dpitch));
  },
  orbit: (dx, dy) => view.orbit(dx, dy),
});
ui.bindPointer(
  () => input.releasePointer(),
  () => input.locked,
  () => input.lockFailed,
);

// ---------- conexão ----------

remote.onStatus = (status) => {
  if (status === 'online') gate.hideConn();
  else if (status === 'connecting') gate.showConn('Conectando ao servidor…');
  else if (status === 'offline') gate.showConn('Conexão perdida. Tentando de novo…');
  else if (status === 'kicked') gate.showConn('Você entrou em outro lugar. Feche aquela janela e recarregue esta página para jogar aqui.');
  else if (status === 'auth-failed') {
    setToken('');
    gate.hideConn();
    gate.showAuth('Sua sessão expirou. Entre de novo.');
  }
};
remote.onChange = () => ui.refreshModal();
remote.onSocial = () => ui.socialChanged();
remote.onVisit = () => {
  if (remote.visit) input.releasePointer();
  view.setSource(remote.visit ?? game, remote.visit !== null);
  ui.visitChanged();
  ui.refreshModal();
};
remote.onWelcome = () => {
  ui.buildHotbar();
};

ui.onLogout = () => {
  const token = getToken();
  remote.disconnect();
  setToken('');
  if (token) void logout(token);
  location.reload();
};

// a fazenda só anda enquanto você está olhando: ao esconder a aba, o servidor pausa
document.addEventListener('visibilitychange', () => {
  const hidden = document.hidden;
  game.paused = hidden || ui.modalOpen;
  void remote.send({ t: 'paused', value: game.paused }).catch(() => {});
});

const token = getToken();
if (token) remote.connect(token);
else gate.showAuth();

// ---------- laço principal ----------

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (remote.status === 'online') {
    // o servidor decide; aqui só se anima e se prevê o seu próprio passo
    if (remote.visit) {
      // visitando: o seu jogo está parado; só se anima a fazenda do amigo
      remote.visit.animate(dt);
    } else {
      game.animate(dt);
      game.predictMove(dt, input.move);
      remote.setInput(input.move, game.player.yaw, game.player.pitch);
      remote.flushInput(false, now);
    }
  }
  view.render(now);
  ui.update(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// para inspecionar no console do navegador durante o desenvolvimento
const debug = window as unknown as { game: typeof game; ui: Ui; remote: Remote };
debug.game = game;
debug.ui = ui;
debug.remote = remote;
