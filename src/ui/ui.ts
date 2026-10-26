import { hhmm } from '../core/clock';
import type { Game, InteractKind } from '../core/game';
import { HOTBAR_SIZE, SPEEDS } from '../core/game';
import { BUY_PRICE, ITEMS, ITEM_KEYS, STORE_CAP, invWeight } from '../core/items';
import type { Inventory, ItemKey } from '../core/items';
import { ABILITIES } from '../core/abilities';
import { BOXES, GOLD_PRICE_IN_SILVER, RARITIES } from '../core/boxes';
import type { BoxKind, BoxResult } from '../core/boxes';
import { LANDS, landSize } from '../core/lands';
import { EQUIPMENT, EQUIPMENT_IDS, RARITY_NAME, SLOTS, SLOT_NAME, describeMods } from '../core/equipment';
import type { Slot } from '../core/equipment';
import type { MarketData } from '../core/market';
import type { Command, CommandResult, Where } from '../net/protocol';
import type { Remote } from '../net/remote';
import { PERMISSION_NAME } from '../core/social';
import { getToken, newRecoveryCode } from '../net/account';
import type { FriendView, HelpAction, Permission, SocialData } from '../core/social';
import { MarketView } from './marketPanel';
import { TASK_NEEDS } from '../core/workers';
import type { Worker } from '../core/workers';
import { EMPTY_ICON, iconSvg } from './icons';

type ModalKind = InteractKind | 'inv' | 'workers' | 'char' | 'lands' | 'friends' | 'account' | 'menu' | 'kitchen' | 'history';

const LEGEND_KEY = 'fazenda-infinita:legend';
const HISTORY_MAX = 300;

const SOCIAL_CMDS = new Set<string>(['social', 'friendRequest', 'friendAnswer', 'friendRemove', 'friendBlock', 'friendUnblock', 'friendPerm', 'leaveVisit', 'visit']);

const TITLES: Record<string, string> = {
  house: 'Sua casa',
  shop: 'Mercado',
  inv: 'Inventário',
  store: 'Armazém',
  workers: 'Trabalhadores',
  char: 'Personagem',
  lands: 'Terrenos',
  friends: 'Amigos',
  account: 'Conta',
  menu: 'Menu',
  kitchen: 'Cozinha',
  history: 'Histórico',
};
const NEED_LABEL: Record<ItemKey, string> = {
  enxada: 'enxada', regador: 'regador', foice: 'foice', semente: 'sementes', batata: 'batatas', pao: 'pão', assada: 'batata assada',
};

function kg(n: number): string {
  return n.toFixed(1).replace('.', ',');
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function $(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error('Elemento #' + id + ' não encontrado');
  return e;
}

/** HUD, hotbar e janelas. Só lê e comanda o Game; não tem regra de jogo. */
export class Ui {
  private modal: { kind: ModalKind; worker?: Worker } | null = null;
  private step = 1;
  private shopTab: 'loja' | 'caixas' | 'jogadores' = 'loja';
  private readonly marketView: MarketView;
  private boxResult: BoxResult | null = null;
  private note = '';
  private lastText = 0;
  private readonly modalEl = $('modal');
  private readonly hotbarEl = $('hotbar');
  private hotbarRefs: Array<{ btn: HTMLButtonElement; em: HTMLElement }> = [];
  private hotbarSig = '';
  private onRelease: () => void = () => {};
  private locked: () => boolean = () => false;
  private lockFailed: () => boolean = () => false;

  private resetArmed = false;
  private resetTimer = 0;
  private toastTimer = 0;
  private history: Array<{ day: number; clock: number; text: string }> = [];
  private unread = 0;
  /** Quantidade escrita em cada campo (compra, cozinha, ordens), para sobreviver a refazer a janela. */
  private readonly qty = new Map<string, string>();
  private readonly orderDraft = new Map<string, { key: ItemKey; n: string }>();
  /** O que o botão Sair faz (quem monta a tela define). */
  onLogout: () => void = () => {};
  private social: SocialData | null = null;
  private friendName = '';
  private accountPass = '';
  private newCode = '';
  private accountBusy = false;
  private helpMode: HelpAction | null = null;
  private visitBtns: Array<{ mode: HelpAction | null; btn: HTMLButtonElement }> = [];

  constructor(private readonly game: Game, private readonly net: Remote) {
    this.marketView = new MarketView(game, {
      act: (c, done) => this.act(c, done),
      render: () => this.renderModal(),
      load: () => this.loadMarket(),
    });
    // o que o próprio jogo diz (ações suas) aparece um instante; o que o servidor avisa por conta própria só vai ao histórico
    game.onMessage = (t) => this.say(t);
    net.onNotice = (t) => this.log(t);
    try {
      $('legend').hidden = localStorage.getItem(LEGEND_KEY) === '0';
    } catch {
      /* sem armazenamento: a lista de controles aparece */
    }
    $('btnMenu').addEventListener('click', () => this.toggleMenu());
    this.buildClock();
    this.buildVisitBar();
        $('btnExit').addEventListener('click', () => this.act({ t: 'exitAuto' }));
    const seg = $('speeds');
    for (const s of SPEEDS) {
      const b = h('button', undefined, '×' + s);
      b.type = 'button';
      b.dataset.speed = String(s);
      b.addEventListener('click', () => this.act({ t: 'speed', speed: s }));
      seg.appendChild(b);
    }
    this.buildHotbar();
  }

  /** Liga a UI ao mouse: para soltar o cursor ao abrir janelas e saber se há captura. */
  bindPointer(release: () => void, locked: () => boolean, lockFailed: () => boolean): void {
    this.onRelease = release;
    this.locked = locked;
    this.lockFailed = lockFailed;
  }

  // ---------- avisos e histórico ----------

  /** Anota no histórico (Tab → Histórico). Não aparece na tela. */
  log(text: string): void {
    if (!text) return;
    this.history.push({ day: this.game.day, clock: this.game.clock, text });
    if (this.history.length > HISTORY_MAX) this.history.shift();
    if (this.modal?.kind === 'history') this.renderModal();
    else {
      this.unread++;
      this.updateUnread();
    }
  }

  /** Um aviso curto no meio da tela, que some sozinho. */
  toast(text: string): void {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { el.hidden = true; }, 2800);
  }

  /** Resposta a uma ação sua: vai ao histórico e aparece um instante. */
  say(text: string): void {
    this.log(text);
    this.toast(text);
  }

  /** Resultado de usar o item da hotbar (plantar, regar...): é o retorno que o jogo em primeira pessoa precisa. */
  usedResult(r: CommandResult): void {
    if (r.message) this.say(r.message);
  }

  private updateUnread(): void {
    $('unread').hidden = this.unread === 0;
  }

  // ---------- menu (Tab) ----------

  toggleMenu(): void {
    if (this.modal?.kind === 'menu') this.close();
    else this.open('menu');
  }

  /** Só mostra "Recomeçar" quando o jogador quebrou: sem prata, sem nada plantado, sem sementes e sem batatas para vender. */
  private broke(): boolean {
    const g = this.game;
    return g.player.silver < 50
      && !g.farm.tiles.some((t) => t.state === 'planted')
      && g.env.seedsTotal === 0
      && g.player.inv.batata + g.store.batata === 0;
  }

  private menuAction(grid: HTMLElement, label: string, key: string, fn: () => void, off = '', danger = false): void {
    const b = h('button', 'mact' + (danger ? ' danger' : ''));
    b.type = 'button';
    b.appendChild(document.createTextNode(label));
    if (key) b.appendChild(h('kbd', undefined, key));
    if (off) b.appendChild(h('small', undefined, off));
    b.disabled = !!off && off !== '';
    b.addEventListener('click', fn);
    grid.appendChild(b);
  }

  private menuPanel(box: HTMLElement): void {
    const g = this.game;
    const p = g.player;
    const auto = g.mode === 'spec';
    const st = h('div', 'mstat');
    const kv = h('div', 'kv');
    const kvs: Array<[string, string]> = [
      ['Prata', String(p.silver)],
      ['Ouro', String(p.gold)],
      ['Aluguel por dia', String(g.dailyRent())],
      ['Dia', g.day + ' · ' + hhmm(g.clock)],
      ['Modo', auto ? 'automático' : 'normal'],
      ['Capacidade', kg(invWeight(p.inv)) + ' / ' + kg(g.carryCap) + ' kg'],
    ];
    for (const [k, v] of kvs) {
      const sp = h('span', undefined, k + ': ');
      sp.appendChild(h('b', undefined, v));
      kv.appendChild(sp);
    }
    st.appendChild(kv);
    const store = ITEM_KEYS.filter((k) => g.store[k] > 0).map((k) => g.store[k] + ' × ' + ITEMS[k].name.toLowerCase());
    st.appendChild(h('p', 'mnote', 'Armazém: ' + (store.length ? store.join(', ') : 'vazio') + ' (' + kg(invWeight(g.store)) + ' / ' + kg(STORE_CAP) + ' kg)'));
    st.appendChild(this.statBar('Energia', p.energy, '#4fd067', g.stats.maxEnergy));
    st.appendChild(this.statBar('Vida', p.hp, '#e5574f', g.stats.maxHp));
    const lv = h('div', 'kv');
    for (const [k, label] of [['enxada', 'Enxada'], ['regador', 'Regador'], ['foice', 'Foice'], ['plantio', 'Plantio']] as const) {
      lv.appendChild(this.statBar(label + ' nv ' + p.levels[k], p.levels[k], '#6aa8ff'));
    }
    st.appendChild(lv);
    st.appendChild(h('p', 'mnote', 'Cada nível de ferramenta reduz a energia gasta (até metade no nível 100); os trabalhadores também sobem de nível trabalhando. Atributos completos em Personagem.'));
    box.appendChild(st);

    const grid = h('div', 'menugrid');
    this.menuAction(grid, 'Inventário', 'I', () => this.open('inv'));
    this.menuAction(grid, 'Personagem', 'C', () => this.open('char'));
    this.menuAction(grid, 'Terrenos', 'L', () => this.open('lands'));
    this.menuAction(grid, 'Trabalhadores', 'T', () => this.open('workers'));
    this.menuAction(grid, 'Armazém', '', () => this.open('store'), auto || g.isNear('store') ? '' : 'chegue perto do armazém');
    this.menuAction(grid, 'Cozinha', '', () => this.open('kitchen'), auto || g.isNear('house') ? '' : 'chegue perto da casa');
    this.menuAction(grid, 'Mercado', '', () => this.open('shop'), auto || g.isNear('shop') ? '' : 'chegue perto do mercado');
    this.menuAction(grid, 'Amigos', 'F', () => this.openFriends());
    this.menuAction(grid, 'Histórico' + (this.unread ? ' (' + this.unread + ' novo(s))' : ''), '', () => this.open('history'));
    this.menuAction(grid, 'Conta', '', () => {
      this.accountPass = '';
      this.newCode = '';
      this.open('account');
    });
    this.menuAction(grid, 'Controles', 'H', () => {
      this.close();
      this.toggleLegend();
    });
    this.menuAction(grid, 'Salvar', '', () => this.act({ t: 'save' }));
    this.menuAction(grid, 'Sair (' + this.net.user + ')', '', () => this.onLogout());
    if (this.broke()) {
      this.menuAction(grid, this.resetArmed ? 'Apagar tudo? Clique de novo' : 'Recomeçar', '', () => this.resetClicked(), '', true);
    }
    box.appendChild(grid);
    if (this.broke()) box.appendChild(h('p', 'mnote', 'Você está sem prata, sem plantas, sem sementes e sem batatas para vender. Recomeçar apaga tudo e volta ao dia 1.'));
  }

  /** Recomeçar apaga o progresso, então pede um segundo clique. */
  private resetClicked(): void {
    if (this.resetArmed) {
      window.clearTimeout(this.resetTimer);
      this.resetArmed = false;
      this.close();
      this.act({ t: 'reset' });
      return;
    }
    this.resetArmed = true;
    this.resetTimer = window.setTimeout(() => {
      this.resetArmed = false;
      if (this.modal?.kind === 'menu') this.renderModal();
    }, 4000);
    this.renderModal();
  }

  private historyPanel(box: HTMLElement): void {
    box.appendChild(h('p', 'mnote', 'O que aconteceu por último: dormir, aluguel, avisos dos amigos, mercado. Os mais novos ficam em cima.'));
    if (!this.history.length) box.appendChild(h('p', 'mnote', 'Nada ainda.'));
    for (const e of [...this.history].reverse()) {
      const row = h('div', 'hrow');
      row.appendChild(h('time', undefined, 'Dia ' + e.day + ' · ' + hhmm(e.clock)));
      row.appendChild(h('span', undefined, e.text));
      box.appendChild(row);
    }
    if (this.history.length) box.appendChild(this.btn('Limpar histórico', () => { this.history = []; this.renderModal(); }, true));
  }

  /** Quantidade escolhida num campo, com o botão "Máx". */
  private qtyControls(id: string, max: number, def: string): HTMLElement {
    const box = h('span', 'mbs');
    const inp = h('input', 'mini');
    inp.type = 'number';
    inp.min = '1';
    inp.max = String(Math.max(1, max));
    inp.step = '1';
    inp.value = this.qty.get(id) ?? def;
    inp.style.width = '86px';
    inp.setAttribute('aria-label', 'Quantidade');
    inp.addEventListener('input', () => { this.qty.set(id, inp.value); });
    const maxBtn = this.btn('Máx (' + max + ')', () => {
      this.qty.set(id, String(max));
      this.renderModal();
    }, true);
    maxBtn.disabled = max < 1;
    box.append(inp, maxBtn);
    return box;
  }

  private qtyValue(id: string, def = 1): number {
    const n = Math.floor(Number(this.qty.get(id) ?? def));
    return Number.isFinite(n) ? n : 0;
  }

  /** Cozinha: quantas batatas assadas fazer (2 batatas cada). O resultado cai no armazém. */
  private kitchenPanel(box: HTMLElement): void {
    const g = this.game;
    const max = g.maxCook();
    box.appendChild(h('p', 'mnote', 'Batata assada = 2 batatas (primeiro da mochila, depois do armazém): +25 de energia e +8 de vida. O resultado vai para o armazém. Os trabalhadores comem do armazém quando estão cansados.'));
    box.appendChild(h('p', 'mnote', 'Batatas: mochila ' + g.player.inv.batata + ' · armazém ' + g.store.batata + ' · batatas assadas no armazém: ' + g.store.assada));
    const row = h('div', 'mrow');
    row.appendChild(h('span', undefined, 'Cozinhar batata assada (dá para fazer até ' + max + ')'));
    const ctl = h('span', 'mbs');
    ctl.appendChild(this.qtyControls('cook', max, '1'));
    const go = this.btn('Cozinhar', () => {
      const n = this.qtyValue('cook');
      if (n < 1 || n > max) return void (this.note = 'Escolha de 1 a ' + max + '.', this.renderModal());
      this.act({ t: 'cook', n });
    });
    go.disabled = max < 1;
    ctl.appendChild(go);
    row.appendChild(ctl);
    box.appendChild(row);
  }

  /** Item de compra com quantidade livre; o máximo é o que cabe no armazém e na mochila e que a prata paga. */
  private buyRow(box: HTMLElement, key: ItemKey, text: string): void {
    const g = this.game;
    const price = BUY_PRICE[key]!;
    const max = g.maxBuy(key);
    const room = g.room(key);
    const row = h('div', 'mrow');
    const info = h('span');
    info.appendChild(h('b', undefined, text));
    info.appendChild(h('span', 'mnote', ' · cabem ' + room.store + ' no armazém e ' + room.bag + ' na mochila · sua prata paga ' + Math.floor(g.player.silver / price)));
    row.appendChild(info);
    const ctl = h('span', 'mbs');
    ctl.appendChild(this.qtyControls('buy:' + key, max, '10'));
    const go = this.btn('Comprar', () => {
      const n = this.qtyValue('buy:' + key);
      if (n < 1) return void (this.note = 'Escreva uma quantidade de 1 para cima.', this.renderModal());
      if (n > max) return void (this.note = 'No máximo ' + max + ' agora (o que cabe e a sua prata).', this.renderModal());
      this.act({ t: 'buy', key, n });
    });
    go.disabled = max < 1;
    ctl.appendChild(go);
    row.appendChild(ctl);
    box.appendChild(row);
  }

  /** Mandar um trabalhador buscar um item no armazém, mesmo em modo automático. */
  private orderPanel(box: HTMLElement): void {
    const g = this.game;
    box.appendChild(h('h4', undefined, 'Mandar um trabalhador buscar no armazém'));
    box.appendChild(h('p', 'mnote', 'A ordem vale antes das tarefas dele: ele vai ao armazém, pega o que cabe na mochila dele e volta ao trabalho. Dá para mandar mesmo no modo automático.'));
    const items = ITEM_KEYS.filter((k) => g.store[k] > 0);
    for (const w of g.workers) {
      let d = this.orderDraft.get(w.name);
      if (!d) {
        d = { key: items[0] ?? 'semente', n: '10' };
        this.orderDraft.set(w.name, d);
      }
      const draft = d;
      const row = h('div', 'mrow');
      const info = h('span');
      info.appendChild(h('b', undefined, w.name));
      info.appendChild(h('span', 'mnote', ' · ' + w.status));
      row.appendChild(info);
      const ctl = h('span', 'mbs');
      const sel = h('select', 'mini');
      sel.setAttribute('aria-label', 'Item para ' + w.name);
      for (const k of items) {
        const o = h('option', undefined, ITEMS[k].name + ' (' + g.store[k] + ')');
        o.value = k;
        o.selected = draft.key === k;
        sel.appendChild(o);
      }
      if (!items.length) sel.appendChild(h('option', undefined, 'armazém vazio'));
      sel.disabled = !items.length;
      sel.addEventListener('change', () => { draft.key = sel.value as ItemKey; });
      const inp = h('input', 'mini');
      inp.type = 'number';
      inp.min = '1';
      inp.value = draft.n;
      inp.style.width = '80px';
      inp.setAttribute('aria-label', 'Quantidade para ' + w.name);
      inp.addEventListener('input', () => { draft.n = inp.value; });
      const go = this.btn('Buscar', () => {
        const n = Math.floor(Number(draft.n));
        if (!Number.isFinite(n) || n < 1) return void (this.note = 'Escreva uma quantidade de 1 para cima.', this.renderModal());
        this.act({ t: 'order', worker: w.name, key: draft.key, n });
      });
      go.disabled = !items.length;
      ctl.append(sel, inp, go, this.btn('Cancelar ordem', () => this.act({ t: 'order', worker: w.name, key: draft.key, n: 0 }), true));
      row.appendChild(ctl);
      box.appendChild(row);
    }
  }

    /** Manda a ação ao servidor. A resposta (com a mensagem) chega depois; a tela da janela é refeita ao chegar. */
  private act(c: Command, done?: (r: CommandResult) => void): void {
    this.net
      .send(c)
      .then((r) => {
        if (r.message) {
          this.log(r.message);
          if (this.modal) this.note = r.message;
          else if (!r.ok) this.toast(r.message);
        }
        // as ações do mercado devolvem a tela do mercado já atualizada
        if (r.data) {
          if (SOCIAL_CMDS.has(c.t)) this.social = r.data as SocialData;
          else this.marketView.data = r.data as MarketData;
        }
        done?.(r);
        if (this.modal) this.renderModal();
      })
      .catch(() => this.say('Sem conexão com o servidor.'));
  }

  /** Busca os anúncios no servidor para a aba Jogadores. */
  private loadMarket(): void {
    this.net
      .send({ t: 'market' })
      .then((r) => {
        if (r.data) this.marketView.data = r.data as MarketData;
        else if (r.message) this.note = r.message;
        if (this.modal) this.renderModal();
      })
      .catch(() => this.say('Sem conexão com o servidor.'));
  }

  /** Com uma janela aberta o tempo para, também no servidor. */
  setPaused(value: boolean): void {
    this.game.paused = value;
    void this.net.send({ t: 'paused', value }).catch(() => {});
  }

  selectSlot(i: number): void {
    this.game.selectSlot(i);
    void this.net.send({ t: 'select', slot: i }).catch(() => {});
    this.updateHotbar();
  }

  private sendPrios(w: Worker): void {
    void this.net.send({ t: 'prios', worker: w.name, order: w.prios.map((p) => p.k), on: w.prios.map((p) => p.on) }).catch(() => {});
  }

  /** O servidor mandou novidades que mudam o conteúdo da janela aberta. */
  refreshModal(): void {
    if (this.modal) this.renderModal();
  }

  get modalOpen(): boolean {
    return this.modal !== null;
  }

  /** Mostra ou esconde a lista de controles e lembra a escolha para a próxima vez. */
  toggleLegend(): void {
    const l = $('legend');
    l.hidden = !l.hidden;
    try {
      localStorage.setItem(LEGEND_KEY, l.hidden ? '0' : '1');
    } catch {
      /* sem armazenamento: vale só nesta visita */
    }
  }

  // ---------- amigos e visitas ----------

  openFriends(): void {
    if (this.modal) return;
    this.open('friends');
    this.loadSocial();
  }

  private loadSocial(): void {
    this.net
      .send({ t: 'social' })
      .then((r) => {
        if (r.data) this.social = r.data as SocialData;
        if (this.modal?.kind === 'friends') this.renderModal();
      })
      .catch(() => {});
  }

  /** O servidor avisou que algo mudou nos amigos. */
  socialChanged(): void {
    if (this.modal?.kind === 'friends') this.loadSocial();
  }

  private buildVisitBar(): void {
    const bar = $('visitBtns');
    const defs: Array<[HelpAction | null, string]> = [['water', 'Regar'], ['harvest', 'Colher'], [null, 'Só olhar']];
    for (const [mode, label] of defs) {
      const b = h('button', undefined, label);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.helpMode = mode;
        this.updateVisitBar();
      });
      bar.appendChild(b);
      this.visitBtns.push({ mode, btn: b });
    }
    const back = h('button', undefined, 'Voltar para casa (E)');
    back.type = 'button';
    back.addEventListener('click', () => this.act({ t: 'leaveVisit' }));
    bar.appendChild(back);
  }

  /** Muda a barra da visita quando começa, termina ou muda a permissão. */
  visitChanged(): void {
    if (!this.net.visit || !this.net.canHelp) this.helpMode = null;
    this.updateVisitBar();
  }

  private updateVisitBar(): void {
    const v = this.net.visit;
    $('visitbar').hidden = !v;
    $('visitTitle').textContent = v ? 'Visitando a fazenda de ' + this.net.visitHost + (this.net.canHelp ? '' : ' (só assistindo)') : '';
    for (const { mode, btn } of this.visitBtns) {
      btn.hidden = !this.net.canHelp;
      btn.setAttribute('aria-pressed', String(mode === this.helpMode));
    }
  }

  get visiting(): boolean {
    return this.net.visit !== null;
  }

  /** Toque num solo da fazenda visitada: ajuda, se você escolheu regar ou colher. */
  helpAt(i: number, j: number): void {
    if (!this.net.visit || this.modal) return;
    if (!this.net.canHelp) return this.say('Seu amigo deixou você só assistir.');
    if (!this.helpMode) return this.say('Escolha Regar ou Colher na barra de baixo e clique num solo.');
    this.act({ t: 'help', action: this.helpMode, i, j });
  }

  /** Conta: gerar um novo código de recuperação (o antigo deixa de valer). */
  private accountPanel(box: HTMLElement): void {
    box.appendChild(h('p', 'mnote', 'O código de recuperação é a única forma de trocar a senha se você esquecer. Foi mostrado ao criar a conta. Se você o perdeu (ou a conta é antiga e não tem um), gere outro aqui: o anterior deixa de valer. Ele aparece uma vez só.'));
    const row = h('div', 'mrow');
    row.appendChild(h('span', undefined, 'Confirme a sua senha'));
    const ctl = h('span', 'mbs');
    const inp = h('input', 'mini');
    inp.type = 'password';
    inp.maxLength = 128;
    inp.autocomplete = 'current-password';
    inp.placeholder = 'senha';
    inp.value = this.accountPass;
    inp.setAttribute('aria-label', 'Senha');
    inp.addEventListener('input', () => { this.accountPass = inp.value; });
    const go = () => {
      if (this.accountBusy || !this.accountPass) return;
      this.accountBusy = true;
      newRecoveryCode(getToken(), this.accountPass).then((r) => {
        this.accountBusy = false;
        this.accountPass = '';
        if (r.ok && r.recovery) this.newCode = r.recovery;
        else this.note = r.error ?? 'Não foi possível gerar o código.';
        if (this.modal?.kind === 'account') this.renderModal();
      });
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    ctl.append(inp, this.btn('Gerar novo código', go));
    row.appendChild(ctl);
    box.appendChild(row);
    if (this.newCode) {
      box.appendChild(h('p', 'mnote', 'Anote agora. Este é o seu novo código (o anterior não vale mais):'));
      const code = h('code', undefined, this.newCode);
      code.id = 'recoveryCodeInline';
      code.style.cssText = 'font-size:1.3rem;letter-spacing:0.08em;color:var(--gold);user-select:all;padding:6px 10px;background:rgba(0,0,0,.4);display:block;text-align:center';
      box.appendChild(code);
    }
  }

  private friendRow(f: FriendView): HTMLElement {
    const row = h('div', 'mrow');
    const text = h('span');
    text.appendChild(h('b', undefined, f.name));
    text.appendChild(h('span', 'mnote', ' · ' + (f.online ? 'conectado' : 'fora') + ' · ele deixa você: ' + PERMISSION_NAME[f.theyAllow].toLowerCase()));
    row.appendChild(text);
    const ctl = h('span', 'mbs');
    const sel = h('select', 'mini');
    sel.setAttribute('aria-label', 'O que ' + f.name + ' pode fazer na sua fazenda');
    ([0, 1, 2] as Permission[]).forEach((lv) => {
      const o = h('option', undefined, 'Na minha: ' + PERMISSION_NAME[lv].toLowerCase());
      o.value = String(lv);
      o.selected = f.iAllow === lv;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => this.act({ t: 'friendPerm', name: f.name, level: Number(sel.value) as Permission }));
    ctl.appendChild(sel);
    const go = this.btn('Visitar', () => { this.close(); this.act({ t: 'visit', name: f.name }); });
    go.disabled = !f.canVisit;
    go.title = f.canVisit ? '' : 'Ele precisa estar conectado, em casa, ter deixado você assistir e ter vaga.';
    ctl.appendChild(go);
    ctl.appendChild(this.btn('Remover', () => this.act({ t: 'friendRemove', name: f.name }), true));
    ctl.appendChild(this.btn('Bloquear', () => this.act({ t: 'friendBlock', name: f.name }), true));
    row.appendChild(ctl);
    return row;
  }

  private friendsPanel(box: HTMLElement): void {
    box.appendChild(h('p', 'mnote', 'Você escolhe o que cada amigo pode fazer na SUA fazenda: nada, só assistir, ou assistir e ajudar (regar e colher; a colheita vai para o seu armazém). Para visitar, o amigo precisa estar conectado e ter deixado. Enquanto você visita, o seu próprio jogo fica parado.'));
    const add = h('div', 'mrow');
    add.appendChild(h('span', undefined, 'Pedir amizade pelo nome'));
    const ctl = h('span', 'mbs');
    const inp = h('input', 'mini');
    inp.type = 'text';
    inp.maxLength = 20;
    inp.placeholder = 'nome do jogador';
    inp.value = this.friendName;
    inp.setAttribute('aria-label', 'Nome do jogador');
    inp.addEventListener('input', () => { this.friendName = inp.value; });
    const send = () => {
      const name = this.friendName.trim();
      if (!name) return;
      this.friendName = '';
      this.act({ t: 'friendRequest', name });
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    ctl.append(inp, this.btn('Pedir', send));
    add.appendChild(ctl);
    box.appendChild(add);

    const s = this.social;
    if (!s) {
      box.appendChild(h('p', 'mnote', 'Carregando…'));
      return;
    }
    if (s.visiting) box.appendChild(h('p', 'mnote', 'Você está visitando ' + s.visiting + '.'));
    if (s.visitors.length) box.appendChild(h('p', 'mnote', 'Visitando você agora: ' + s.visitors.join(', ') + '.'));
    if (s.incoming.length) {
      box.appendChild(h('h4', undefined, 'Pedidos recebidos'));
      for (const n of s.incoming) {
        const row = h('div', 'mrow');
        row.appendChild(h('span', undefined, n + ' quer ser seu amigo'));
        const c = h('span', 'mbs');
        c.append(this.btn('Aceitar', () => this.act({ t: 'friendAnswer', name: n, accept: true })), this.btn('Recusar', () => this.act({ t: 'friendAnswer', name: n, accept: false }), true));
        row.appendChild(c);
        box.appendChild(row);
      }
    }
    if (s.outgoing.length) box.appendChild(h('p', 'mnote', 'Aguardando resposta de: ' + s.outgoing.join(', ') + '.'));
    box.appendChild(h('h4', undefined, 'Amigos (' + s.friends.length + ')'));
    if (!s.friends.length) box.appendChild(h('p', 'mnote', 'Nenhum ainda.'));
    for (const f of s.friends) box.appendChild(this.friendRow(f));
    if (s.blocked.length) {
      box.appendChild(h('h4', undefined, 'Bloqueados'));
      for (const n of s.blocked) {
        const row = h('div', 'mrow');
        row.appendChild(h('span', undefined, n));
        row.appendChild(this.btn('Desbloquear', () => this.act({ t: 'friendUnblock', name: n }), true));
        box.appendChild(row);
      }
    }
  }

  interact(): void {
    const g = this.game;
    if (this.modal) return this.close();
    if (this.net.visit) return this.act({ t: 'leaveVisit' });
    if (g.mode === 'spec') return this.act({ t: 'exitAuto' });
    const n = g.nearby();
    if (!n) return g.say('Nada para interagir aqui. Chegue perto da casa, do armazém, do mercado ou de um trabalhador.');
    this.open(n.kind, n.worker);
  }

  openCharacter(): void {
    if (!this.modal) this.open('char');
  }

  openInventory(): void {
    if (!this.modal) this.open('inv');
  }

  open(kind: ModalKind, worker?: Worker): void {
    this.onRelease();
    this.modal = { kind, worker };
    this.note = '';
    if (kind === 'history') {
      this.unread = 0;
      this.updateUnread();
    }
    // abrir o menu é um bom momento para salvar: o jogo não está sendo jogado
    if (kind === 'menu') void this.net.send({ t: 'save' }).catch(() => {});
    this.setPaused(true);
    this.renderModal();
    if (kind === 'shop' && this.shopTab === 'jogadores') this.loadMarket();
    this.modalEl.hidden = false;
  }

  close(): void {
    this.resetArmed = false;
    this.newCode = '';
    this.accountPass = '';
    this.modal = null;
    this.boxResult = null;
    this.marketView.data = null;
    this.setPaused(false);
    this.modalEl.hidden = true;
    this.buildHotbar();
  }

  // ---------- HUD ----------

  /** Chamado a cada quadro; os textos só mudam 4 vezes por segundo. */
  update(now: number): void {
    if (now - this.lastText < 250) return;
    this.lastText = now;
    const g = this.game;
    const p = g.player;
    const vg = this.net.visit;
    const shown = vg ?? g;
    this.drawClock(shown.clock, shown.day);
    const info: string[] = [];
    if (vg) info.push('Visitando ' + this.net.visitHost);
    else if (g.mode === 'spec') info.push('automático ×' + g.speed);
    if (!vg && g.visitors.length) info.push('visitas: ' + g.visitors.join(', '));
    $('hudinfo').textContent = info.join(' · ');
    $('hudinfo').hidden = info.length === 0;
    this.bar($('bEn'), (p.energy / g.stats.maxEnergy) * 100, p.energy / g.stats.maxEnergy > 0.25 ? '#4fd067' : '#e6a93a');
    this.bar($('bHp'), (p.hp / g.stats.maxHp) * 100, '#e5574f');
    const spec = g.mode === 'spec' || vg !== null;
    document.body.classList.toggle('spec', spec);
    $('btnExit').hidden = g.mode !== 'spec' || vg !== null;
    $('speedWrap').hidden = g.mode !== 'spec' || vg !== null;
    $('speeds').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === g.speed)));

    const prompt = $('prompt');
    const near = !spec && !this.modal ? g.nearby() : null;
    if (vg) {
      prompt.hidden = false;
      prompt.textContent = this.helpMode ? 'Clique num solo para ' + (this.helpMode === 'water' ? 'regar' : 'colher') + ' · E · voltar para casa' : 'E · voltar para casa';
    } else if (spec) {
      prompt.hidden = false;
      prompt.textContent = 'E · sair do modo automático';
    } else if (near) {
      prompt.hidden = false;
      prompt.textContent = 'E · ' + near.label;
    } else prompt.hidden = true;
    $('hint').hidden = !(g.mode === 'fp' && !this.locked() && !this.modal && !this.lockFailed());
    this.updateHotbar();
  }

  /** Monta os risquinhos do relógio de ponteiros. */
  private buildClock(): void {
    const ticks = $('clockTicks');
    const ns = 'http://www.w3.org/2000/svg';
    for (let i = 0; i < 12; i++) {
      const line = document.createElementNS(ns, 'line');
      const a = (i * Math.PI) / 6;
      const long = i % 3 === 0;
      const r1 = long ? 21 : 24;
      line.setAttribute('x1', String(32 + Math.sin(a) * r1));
      line.setAttribute('y1', String(32 - Math.cos(a) * r1));
      line.setAttribute('x2', String(32 + Math.sin(a) * 26));
      line.setAttribute('y2', String(32 - Math.cos(a) * 26));
      line.setAttribute('class', 'tick');
      ticks.appendChild(line);
    }
  }

  /** Ponteiros e calendário. `clock` são os minutos do dia (06:00 = 360). */
  private drawClock(clock: number, day: number): void {
    const hour = ((clock / 60) % 12) * 30;
    const minute = (clock % 60) * 6;
    $('hHour').setAttribute('transform', 'rotate(' + hour.toFixed(1) + ' 32 32)');
    $('hMin').setAttribute('transform', 'rotate(' + minute.toFixed(1) + ' 32 32)');
    $('clock').classList.toggle('night', clock < 360 || clock >= 1080);
    $('clockText').textContent = hhmm(clock);
    $('calDay').textContent = String(day);
  }

  private bar(el: HTMLElement, v: number, color: string): void {
    el.style.setProperty('--v', Math.max(0, Math.min(100, v)) + '%');
    el.style.setProperty('--c', color);
  }

  buildHotbar(): void {
    const g = this.game;
    this.hotbarEl.innerHTML = '';
    this.hotbarRefs = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const key = g.hotbar[i];
      const btn = h('button', 'hb');
      btn.type = 'button';
      btn.tabIndex = -1;
      btn.innerHTML = (key ? iconSvg(key) : '') + '<i>' + (i + 1) + '</i><em></em>';
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.selectSlot(i);
      });
      this.hotbarEl.appendChild(btn);
      this.hotbarRefs.push({ btn, em: btn.querySelector('em')! });
    }
    this.hotbarSig = g.hotbar.join(',');
    this.updateHotbar();
  }

  private updateHotbar(): void {
    const g = this.game;
    if (g.hotbar.join(',') !== this.hotbarSig) return this.buildHotbar();
    g.hotbar.forEach((key, i) => {
      const r = this.hotbarRefs[i];
      const q = key ? g.player.inv[key] : 0;
      r.btn.setAttribute('aria-pressed', String(i === g.selected));
      r.btn.setAttribute('aria-label', key ? ITEMS[key].name + ', ' + q : 'Slot vazio ' + (i + 1));
      r.btn.style.opacity = key && q < 1 ? '0.45' : '1';
      r.em.hidden = !(key && ITEMS[key].stack);
      r.em.textContent = String(q);
    });
  }

  // ---------- janelas ----------

  private btn(text: string, fn: () => void, alt = false): HTMLButtonElement {
    const b = h('button', 'mb' + (alt ? ' alt' : ''), text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  private weightBar(w: number, cap: number): HTMLElement {
    const d = h('div', 'mbar');
    d.appendChild(h('span', undefined, kg(w) + ' / ' + kg(cap) + ' kg'));
    const i = h('i');
    i.style.setProperty('--v', Math.min(100, (w / cap) * 100) + '%');
    if (w / cap > 0.9) i.style.setProperty('--c', '#ef7b70');
    d.appendChild(i);
    return d;
  }

  private statBar(label: string, v: number, color: string, max = 100): HTMLElement {
    const d = h('div', 'mbar');
    d.appendChild(h('span', undefined, label + ' ' + Math.round(v) + (max !== 100 ? ' / ' + Math.round(max) : '')));
    const i = h('i');
    i.style.setProperty('--v', Math.min(100, (v / max) * 100) + '%');
    i.style.setProperty('--c', color);
    d.appendChild(i);
    return d;
  }

  private itemGrid(inv: Inventory, pick: (k: ItemKey) => void): HTMLElement {
    const grid = h('div', 'mgrid');
    let any = false;
    for (const k of ITEM_KEYS) {
      const q = inv[k];
      if (q < 1) continue;
      any = true;
      const b = h('button', 'mi');
      b.type = 'button';
      b.innerHTML = iconSvg(k);
      b.appendChild(h('b', undefined, ITEMS[k].name));
      b.appendChild(h('span', undefined, q + ' · ' + kg(ITEMS[k].weight) + ' kg'));
      b.addEventListener('click', () => pick(k));
      grid.appendChild(b);
    }
    if (!any) grid.appendChild(h('p', 'mnote', 'Vazia.'));
    return grid;
  }

  private stepRow(): HTMLElement {
    const row = h('div', 'mrow');
    row.appendChild(h('span', undefined, 'Quantidade por clique'));
    const box = h('span', 'mbs');
    for (const [n, label] of [[1, '1'], [10, '10'], [9999, 'Tudo']] as const) {
      box.appendChild(this.btn(label, () => { this.step = n; this.renderModal(); }, this.step !== n));
    }
    row.appendChild(box);
    return row;
  }

  private prioEditor(w: Worker): HTMLElement {
    const env = this.game.env;
    const ol = h('ol', 'mprio');
    w.prios.forEach((p, idx) => {
      const li = h('li');
      const cb = h('input');
      cb.type = 'checkbox';
      cb.checked = p.on;
      cb.setAttribute('aria-label', 'Permitir ' + p.k);
      cb.addEventListener('change', () => { p.on = cb.checked; this.sendPrios(w); this.renderModal(); });
      li.appendChild(cb);
      li.appendChild(h('span', undefined, idx + 1 + '. ' + p.k + (p.on ? '' : ' (desativado)')));
      let ok: boolean;
      let why: string;
      if (!p.on) { ok = false; why = 'desativado'; }
      else if (p.k === 'Plantar') { ok = w.inv.semente > 0 || env.store.semente > 0; why = 'sem sementes'; }
      else { const need = TASK_NEEDS[p.k]; ok = w.inv[need] > 0; why = 'falta ' + NEED_LABEL[need]; }
      li.appendChild(h('em', ok ? 'ok' : 'no', ok ? 'pronto' : why));
      const arrows = h('span', 'mbs');
      const up = this.btn('▲', () => { [w.prios[idx - 1], w.prios[idx]] = [w.prios[idx], w.prios[idx - 1]]; this.sendPrios(w); this.renderModal(); }, true);
      up.disabled = idx === 0;
      up.setAttribute('aria-label', 'Subir ' + p.k);
      const down = this.btn('▼', () => { [w.prios[idx + 1], w.prios[idx]] = [w.prios[idx], w.prios[idx + 1]]; this.sendPrios(w); this.renderModal(); }, true);
      down.disabled = idx === w.prios.length - 1;
      down.setAttribute('aria-label', 'Descer ' + p.k);
      arrows.append(up, down);
      li.appendChild(arrows);
      ol.appendChild(li);
    });
    return ol;
  }

  /** As cinco peças vestidas, com o bônus de cada uma. */
  private gearSlots(gear: Record<Slot, string | null>): HTMLElement {
    const eq = h('div', 'eq');
    for (const slot of SLOTS) {
      const id = gear[slot];
      const d = h('div');
      d.appendChild(h('b', undefined, SLOT_NAME[slot]));
      d.appendChild(h('span', undefined, id ? EQUIPMENT[id].name : '—'));
      if (id) d.appendChild(h('small', undefined, describeMods(EQUIPMENT[id].mods)));
      eq.appendChild(d);
    }
    return eq;
  }

  /** Trocar peças com um trabalhador: só com ele por perto. */
  private gearControls(w: Worker): HTMLElement {
    const g = this.game;
    const near = g.workerIsNear(w);
    const box = h('div', 'gearctl');
    const worn = SLOTS.filter((s) => w.gear[s]);
    if (worn.length) {
      const row = h('div', 'mbs');
      row.appendChild(h('span', 'mnote', 'Pegar de volta:'));
      for (const slot of worn) {
        const b = this.btn(SLOT_NAME[slot], () => this.act({ t: 'take', worker: w.name, slot }), true);
        b.disabled = !near;
        row.appendChild(b);
      }
      box.appendChild(row);
    }
    if (g.player.gearInv.length) {
      const row = h('div', 'mbs');
      row.appendChild(h('span', 'mnote', 'Dar a ' + w.name + ':'));
      g.player.gearInv.forEach((id) => {
        const b = this.btn(EQUIPMENT[id].name, () => this.act({ t: 'give', worker: w.name, id }), true);
        b.title = describeMods(EQUIPMENT[id].mods);
        b.disabled = !near;
        row.appendChild(b);
      });
      box.appendChild(row);
    }
    if (!near) box.appendChild(h('p', 'mnote', 'Chegue perto de ' + w.name + ' para trocar peças.'));
    return box;
  }

  private shopTabs(box: HTMLElement): void {
    const row = h('div', 'mbs');
    row.appendChild(this.btn('Loja', () => { this.shopTab = 'loja'; this.renderModal(); }, this.shopTab !== 'loja'));
    row.appendChild(this.btn('Caixas e ouro', () => { this.shopTab = 'caixas'; this.renderModal(); }, this.shopTab !== 'caixas'));
    row.appendChild(this.btn('Jogadores', () => { this.shopTab = 'jogadores'; this.marketView.data = null; this.renderModal(); this.loadMarket(); }, this.shopTab !== 'jogadores'));
    box.appendChild(row);
  }

  private resultCard(res: BoxResult): HTMLElement {
    const card = h('div', 'prize r-' + res.rarity);
    if (res.type === 'equip') {
      const def = EQUIPMENT[res.id];
      card.appendChild(h('b', undefined, 'Prêmio: ' + def.name));
      card.appendChild(h('span', 'mnote', SLOT_NAME[def.slot] + ' · ' + RARITY_NAME[def.rarity] + ' · ' + describeMods(def.mods)));
      card.appendChild(h('span', 'mnote', 'Está na sua mochila. Vista em Personagem (C).'));
    } else {
      const c = res.cfg;
      card.appendChild(h('b', undefined, 'Novo trabalhador: ' + c.name + ' (' + RARITY_NAME[res.rarity] + ')'));
      card.appendChild(h('span', 'mnote', 'Vida ' + c.hp + ' · Enxada ' + c.lv.enxada + ' · Regador ' + c.lv.regador + ' · Foice ' + c.lv.foice + ' · Plantio ' + c.lv.plantio));
      const ab = c.abilities.map((id) => ABILITIES[id].name + ' (' + ABILITIES[id].desc + ')');
      card.appendChild(h('span', 'mnote', ab.length ? 'Habilidades: ' + ab.join('; ') : 'Sem habilidade especial.'));
      card.appendChild(h('span', 'mnote', 'Ele chega às 08:00. Dê ferramentas e sementes na tela de troca (E perto dele).'));
    }
    return card;
  }

  private boxesPanel(box: HTMLElement): void {
    const g = this.game;
    const p = g.player;
    box.appendChild(h('p', 'mnote', 'Prata ' + p.silver + ' · Ouro ' + p.gold + '. As chances abaixo são as reais.'));
    const ex = h('div', 'mrow');
    ex.appendChild(h('span', undefined, 'Câmbio: 1 de ouro custa ' + GOLD_PRICE_IN_SILVER + ' de prata (preço provisório; entre jogadores será livre).'));
    const eb = h('span', 'mbs');
    for (const n of [1, 5]) eb.appendChild(this.btn('Comprar ' + n + ' de ouro', () => this.act({ t: 'buyGold', n })));
    ex.appendChild(eb);
    box.appendChild(ex);
    for (const kind of ['prata', 'ouro'] as BoxKind[]) {
      const def = BOXES[kind];
      const card = h('div', 'boxcard');
      const top = h('div', 'mtop');
      top.appendChild(h('h4', undefined, def.name + ' · ' + def.price + (def.currency === 'silver' ? ' de prata' : ' de ouro')));
      const afford = def.currency === 'silver' ? p.silver >= def.price : p.gold >= def.price;
      const open = this.btn('Abrir', () => this.act({ t: 'openBox', kind }, (r) => { this.boxResult = r.box ?? null; }));
      open.disabled = !afford;
      top.appendChild(open);
      card.appendChild(top);
      const odds = RARITIES.map((r) => RARITY_NAME[r] + ' ' + String(+(def.odds[r] * 100).toFixed(1)).replace('.', ',') + '%').join(' · ');
      card.appendChild(h('p', 'mnote', 'Raridade: ' + odds));
      card.appendChild(h('p', 'mnote', 'Prêmio: ' + Math.round(def.workerChance * 100) + '% trabalhador, ' + Math.round((1 - def.workerChance) * 100) + '% peça de equipamento.'));
      box.appendChild(card);
    }
    if (this.boxResult) box.appendChild(this.resultCard(this.boxResult));
  }

  private landsPanel(box: HTMLElement): void {
    const g = this.game;
    const p = g.player;
    box.appendChild(h('p', 'mnote', 'Prata ' + p.silver + ' · Aluguel que será cobrado ao dormir: ' + g.dailyRent() + '. Sem prata para o aluguel, o terreno fica bloqueado (as plantas ficam paradas, sem crescer nem morrer) até você pagar a dívida. A cerca cresce com cada terreno comprado.'));
    const next = g.nextLand();
    LANDS.forEach((l, i) => {
      const s = g.lands[i];
      const row = h('div', 'mrow');
      let text = l.name + ' · ' + landSize(l) + ' solos · ';
      if (i === 0) text += 'seu, sem aluguel';
      else if (s.owned && s.locked) text += 'BLOQUEADO · dívida ' + s.debt + ' · aluguel ' + l.rent + '/dia';
      else if (s.owned) text += 'em dia · aluguel ' + l.rent + '/dia';
      else if (next && next.index === i) text += 'à venda por ' + l.price + ' · aluguel ' + l.rent + '/dia';
      else text += 'compre o anterior primeiro (' + l.price + ' · aluguel ' + l.rent + '/dia)';
      row.appendChild(h('span', undefined, text));
      if (s.owned && s.locked) {
        const b = this.btn('Pagar dívida', () => this.act({ t: 'payDebt', index: i }));
        b.disabled = p.silver < s.debt;
        row.appendChild(b);
      } else if (!s.owned && next && next.index === i) {
        const b = this.btn('Comprar', () => this.act({ t: 'buyLand' }));
        b.disabled = p.silver < l.price;
        row.appendChild(b);
      }
      box.appendChild(row);
    });
  }

  private characterPanel(box: HTMLElement): void {
    const g = this.game;
    const p = g.player;
    const st = g.stats;
    box.appendChild(h('p', 'mnote', 'Seus atributos somam a base, o equipamento vestido e (para os trabalhadores) as habilidades especiais. Andar nunca gasta energia.'));
    const kv = h('div', 'kv');
    kv.appendChild(h('span', undefined, 'Velocidade ' + Math.round(st.speed)));
    kv.appendChild(h('span', undefined, 'Custo de ação ' + (st.costMod > 0 ? '+' : '') + Math.round(st.costMod * 100) + '%'));
    kv.appendChild(h('span', undefined, 'Capacidade ' + kg(invWeight(p.inv)) + ' / ' + kg(st.carry) + ' kg'));
    kv.appendChild(h('span', undefined, 'Prata ' + p.silver));
    box.appendChild(kv);
    box.appendChild(this.statBar('Vida', p.hp, '#e5574f', st.maxHp));
    box.appendChild(this.statBar('Energia', p.energy, '#4fd067', st.maxEnergy));

    box.appendChild(h('h4', undefined, 'Níveis de ferramenta (sobem com o uso)'));
    const lv = h('div', 'kv');
    for (const [k, label] of [['enxada', 'Enxada'], ['regador', 'Regador'], ['foice', 'Foice'], ['plantio', 'Plantio']] as const) {
      lv.appendChild(this.statBar(label, p.levels[k], '#6aa8ff'));
    }
    box.appendChild(lv);
    box.appendChild(h('p', 'mnote', 'Cada nível reduz a energia gasta com a ferramenta, até metade no nível 100.'));

    box.appendChild(h('h4', undefined, 'Equipamento vestido'));
    box.appendChild(this.gearSlots(p.gear));
    const off = h('div', 'mbs');
    for (const slot of SLOTS) {
      if (!p.gear[slot]) continue;
      off.appendChild(this.btn('Tirar ' + SLOT_NAME[slot].toLowerCase(), () => this.act({ t: 'unequip', slot }), true));
    }
    box.appendChild(off);

    box.appendChild(h('h4', undefined, 'Peças na mochila'));
    if (!p.gearInv.length) box.appendChild(h('p', 'mnote', 'Nenhuma peça guardada.'));
    for (const id of p.gearInv) {
      const def = EQUIPMENT[id];
      const row = h('div', 'mrow');
      row.appendChild(h('span', undefined, def.name + ' (' + SLOT_NAME[def.slot].toLowerCase() + ', ' + RARITY_NAME[def.rarity].toLowerCase() + '): ' + describeMods(def.mods)));
      row.appendChild(this.btn('Vestir', () => this.act({ t: 'equip', id })));
      box.appendChild(row);
    }
  }

  private workerCard(w: Worker): HTMLElement {
    const g = this.game;
    const card = h('div', 'wc2');
    const head = h('div', 'mtop');
    head.appendChild(h('h4', undefined, w.name));
    const rent = w.rental ? ' · alugado de ' + w.rental.owner + ' (' + w.rental.daysLeft + ' dia(s) restantes)' : '';
    head.appendChild(h('span', 'mnote', (w.pres === 'in' ? 'na fazenda' : 'fora (volta às 08:00)') + ' · ' + w.status + rent));
    card.appendChild(head);
    const kv = h('div', 'kv');
    const st = w.stats;
    kv.appendChild(h('span', undefined, 'Vida ' + Math.round(w.hp) + ' / ' + Math.round(st.maxHp)));
    kv.appendChild(h('span', undefined, 'Velocidade ' + Math.round(st.speed)));
    kv.appendChild(h('span', undefined, 'Custo de ação ' + (st.costMod > 0 ? '+' : '') + Math.round(st.costMod * 100) + '%'));
    kv.appendChild(h('span', undefined, 'Capacidade ' + kg(w.cap) + ' kg'));
    card.appendChild(kv);
    card.appendChild(this.statBar('Energia', w.energy, w.energy / w.maxEnergy > 0.3 ? '#4fd067' : '#e6a93a', w.maxEnergy));
    const abil = h('div', 'abil');
    for (const id of w.abilities) {
      const a = ABILITIES[id];
      const chip = h('span', 'chip');
      chip.textContent = a.name + ' · ' + a.desc;
      abil.appendChild(chip);
    }
    card.appendChild(abil);
    const lv = h('div', 'kv');
    for (const [k, label] of [['enxada', 'Enxada'], ['regador', 'Regador'], ['foice', 'Foice'], ['plantio', 'Plantio']] as const) {
      lv.appendChild(this.statBar(label, w.lv[k], '#6aa8ff'));
    }
    card.appendChild(lv);
    card.appendChild(this.gearSlots(w.gear));
    card.appendChild(this.gearControls(w));
    const items = ITEM_KEYS.filter((k) => w.inv[k] > 0).map((k) => w.inv[k] + ' × ' + ITEMS[k].name);
    card.appendChild(h('p', 'mnote', 'Mochila (' + kg(invWeight(w.inv)) + ' / ' + kg(w.cap) + ' kg): ' + (items.length ? items.join(', ') : 'vazia')));
    card.appendChild(this.prioEditor(w));
    const near = g.workerIsNear(w);
    const trade = this.btn(near ? 'Trocar itens' : 'Trocar itens (chegue perto)', () => this.open('trade', w));
    trade.disabled = !near;
    card.appendChild(trade);
    return card;
  }

  private transfer(from: Where, to: Where, key: ItemKey): void {
    this.act({ t: 'move', from, to, key, n: this.step });
  }

  private renderModal(): void {
    const m = this.modal;
    if (!m) return;
    const g = this.game;
    const p = g.player;
    const box = h('div', 'mbox');
    this.modalEl.innerHTML = '';
    this.modalEl.appendChild(box);
    const top = h('div', 'mtop');
    top.appendChild(h('h3', undefined, m.kind === 'trade' ? 'Trocar com ' + m.worker!.name : TITLES[m.kind]));
    const tb = h('span', 'mbs');
    if (m.kind !== 'menu') tb.appendChild(this.btn('Menu (Tab)', () => this.open('menu'), true));
    tb.appendChild(this.btn('Fechar (E)', () => this.close(), true));
    top.appendChild(tb);
    box.appendChild(top);

    if (m.kind === 'house') {
      box.appendChild(h('p', 'mnote', 'Escolha o que fazer em casa.'));
      const r1 = h('div', 'mrow');
      r1.appendChild(h('span', undefined, 'Dormir: passa para o próximo dia e você acorda às 06:00.'));
      r1.appendChild(this.btn('Dormir', () => { this.close(); this.act({ t: 'sleep' }); }));
      box.appendChild(r1);
      const r2 = h('div', 'mrow');
      r2.appendChild(h('span', undefined, 'Modo automático: você entra em casa e assiste. Acorda às 07:00 e dorme às 18:00, sem penalidade.'));
      r2.appendChild(this.btn('Modo automático', () => { this.close(); this.act({ t: 'auto' }); }));
      box.appendChild(r2);
      const r3 = h('div', 'mrow');
      r3.appendChild(h('span', undefined, 'Cozinha: batata assada (2 batatas), com a quantidade que você quiser. O resultado vai para o armazém.'));
      r3.appendChild(this.btn('Abrir a cozinha', () => this.open('kitchen')));
      box.appendChild(r3);
    } else if (m.kind === 'shop' && this.shopTab === 'jogadores') {
      this.shopTabs(box);
      this.marketView.render(box);
    } else if (m.kind === 'shop' && this.shopTab === 'caixas') {
      this.shopTabs(box);
      this.boxesPanel(box);
    } else if (m.kind === 'shop') {
      this.shopTabs(box);
      box.appendChild(h('p', 'mnote', 'Prata: ' + p.silver + ' · Peso ' + kg(invWeight(p.inv)) + ' / ' + kg(g.carryCap) + ' kg'));
      const s1 = h('div', 'mrow');
      s1.appendChild(h('span', undefined, 'Batata (14 de prata): mochila ' + p.inv.batata + ' · armazém ' + g.store.batata));
      const sb = h('span', 'mbs');
      sb.append(
        this.btn('Vender 1', () => this.act({ t: 'sellPotatoes', n: 1 })),
        this.btn('Vender mochila', () => this.act({ t: 'sellPotatoes', n: Math.max(1, p.inv.batata) })),
        this.btn('Vender armazém', () => this.act({ t: 'sellStore' })),
      );
      s1.appendChild(sb);
      box.appendChild(s1);
      box.appendChild(h('p', 'mnote', 'O que você compra vai para o armazém; se ele encher, o resto vai para a sua mochila.'));
      this.buyRow(box, 'semente', 'Semente de batata (' + BUY_PRICE.semente + ' de prata)');
      this.buyRow(box, 'pao', 'Pão (' + BUY_PRICE.pao + ' de prata): +30 energia, +10 vida');
      box.appendChild(h('h4', undefined, 'Roupas e equipamentos'));
      for (const id of EQUIPMENT_IDS) {
        const def = EQUIPMENT[id];
        if (def.price === undefined) continue;
        const r = h('div', 'mrow');
        r.appendChild(h('span', undefined, def.name + ' (' + SLOT_NAME[def.slot].toLowerCase() + '): ' + describeMods(def.mods) + ' · ' + def.price + ' de prata'));
        r.appendChild(this.btn('Comprar', () => this.act({ t: 'buyGear', id })));
        box.appendChild(r);
      }
    } else if (m.kind === 'menu') {
      this.menuPanel(box);
    } else if (m.kind === 'kitchen') {
      this.kitchenPanel(box);
    } else if (m.kind === 'history') {
      this.historyPanel(box);
    } else if (m.kind === 'account') {
      this.accountPanel(box);
    } else if (m.kind === 'friends') {
      this.friendsPanel(box);
    } else if (m.kind === 'lands') {
      this.landsPanel(box);
    } else if (m.kind === 'char') {
      this.characterPanel(box);
    } else if (m.kind === 'inv') {
      box.appendChild(h('p', 'mnote', 'Clique num item para colocá-lo no slot selecionado da hotbar (' + (g.selected + 1) + '). Os 9 slots abaixo mostram a hotbar.'));
      const hot = h('div', 'mgrid mhot');
      g.hotbar.forEach((k, idx) => {
        const b = h('button', 'mi' + (idx === g.selected ? ' on' : ''));
        b.type = 'button';
        b.innerHTML = k ? iconSvg(k) : EMPTY_ICON;
        b.appendChild(h('span', undefined, idx + 1 + (k ? ' · ' + ITEMS[k].name : ' · vazio')));
        b.addEventListener('click', () => { this.selectSlot(idx); this.renderModal(); });
        hot.appendChild(b);
      });
      box.appendChild(hot);
      box.appendChild(h('h4', undefined, 'Mochila'));
      box.appendChild(this.itemGrid(p.inv, (k) => { g.assignSlot(k); this.note = ITEMS[k].name + ' no slot ' + (g.selected + 1) + '.'; this.act({ t: 'assign', key: k }); }));
      box.appendChild(this.weightBar(invWeight(p.inv), g.carryCap));
      box.appendChild(h('p', 'mnote', 'Equipamento e níveis: veja em Personagem (C).'));
      box.appendChild(this.btn('Limpar slot ' + (g.selected + 1), () => { g.assignSlot(null); this.act({ t: 'assign', key: null }); }, true));
    } else if (m.kind === 'store') {
      box.appendChild(h('p', 'mnote', 'Tudo que está no armazém. O limite é muito grande (' + kg(STORE_CAP) + ' kg). Os trabalhadores pegam sementes daqui e guardam a colheita aqui. Eles comem só comida pronta (pão e batata assada).'));
      box.appendChild(this.stepRow());
      const cols = h('div', 'mcols');
      const c1 = h('div', 'mcol');
      c1.append(h('h4', undefined, 'Sua mochila'), this.itemGrid(p.inv, (k) => this.transfer({ at: 'bag' }, { at: 'store' }, k)), this.weightBar(invWeight(p.inv), g.carryCap));
      const c2 = h('div', 'mcol');
      c2.append(h('h4', undefined, 'Armazém'), this.itemGrid(g.store, (k) => this.transfer({ at: 'store' }, { at: 'bag' }, k)), this.weightBar(invWeight(g.store), STORE_CAP));
      cols.append(c1, c2);
      box.appendChild(cols);
      this.orderPanel(box);
    } else if (m.kind === 'workers') {
      box.appendChild(h('p', 'mnote', 'Status, equipamento e prioridades de cada trabalhador. Marque a caixa para permitir ou impedir uma tarefa. Todos sabem fazer todas as tarefas.'));
      for (const w of g.workers) box.appendChild(this.workerCard(w));
    } else if (m.kind === 'trade') {
      const w = m.worker!;
      box.appendChild(h('p', 'mnote', 'Energia ' + Math.round(w.energy) + '% · ' + w.status));
      box.appendChild(this.stepRow());
      const cols = h('div', 'mcols');
      const c1 = h('div', 'mcol');
      c1.append(h('h4', undefined, 'Sua mochila'), this.itemGrid(p.inv, (k) => this.transfer({ at: 'bag' }, { at: 'worker', name: w.name }, k)), this.weightBar(invWeight(p.inv), g.carryCap));
      const c2 = h('div', 'mcol');
      c2.append(h('h4', undefined, 'Mochila de ' + w.name), this.itemGrid(w.inv, (k) => this.transfer({ at: 'worker', name: w.name }, { at: 'bag' }, k)), this.weightBar(invWeight(w.inv), w.cap));
      cols.append(c1, c2);
      box.appendChild(cols);
      box.appendChild(h('h4', undefined, 'Equipamento de ' + w.name));
      box.appendChild(this.gearSlots(w.gear));
      box.appendChild(this.gearControls(w));
      box.appendChild(h('h4', undefined, 'Prioridades (a primeira que ele consegue fazer vale)'));
      box.appendChild(this.prioEditor(w));
      box.appendChild(h('p', 'mnote', 'Plantar já inclui preparar o solo quando não há solo pronto: ele ara, planta, ara, planta. Rega só quando não dá para colher.'));
    }
    if (this.note) box.appendChild(h('p', 'mmsg', this.note));
  }
}
