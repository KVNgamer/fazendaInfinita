import { ABILITIES } from '../core/abilities';
import { EQUIPMENT, RARITY_NAME, SLOT_NAME, describeMods } from '../core/equipment';
import type { Game } from '../core/game';
import { ITEMS, ITEM_KEYS } from '../core/items';
import { FEE_RATE, LISTING_DAYS, RENT_MAX_DAYS, marketFee, sellerGets } from '../core/market';
import type { Currency, ListingKind, ListingView, MarketData, RentalView, SellSpec } from '../core/market';
import type { Command, CommandResult } from '../net/protocol';
import { iconSvg } from './icons';

type Sub = 'comprar' | 'vender' | 'meus' | 'alugueis';

interface Draft {
  /** Amigo que recebe o empréstimo (vazio: anúncio aberto a todos). */
  to: string;
  price: string;
  qty: string;
  days: string;
  currency: Currency;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const KIND_FILTERS: Array<[ListingKind | 'all', string]> = [
  ['all', 'Tudo'], ['item', 'Itens'], ['gear', 'Peças'], ['worker', 'Trabalhadores'], ['rent', 'Aluguéis'], ['gold', 'Ouro'],
];

const money = (n: number, c: Currency) => n + (c === 'silver' ? ' de prata' : ' de ouro');

export interface MarketDeps {
  act(c: Command, done?: (r: CommandResult) => void): void;
  /** Redesenha a janela. */
  render(): void;
  /** Busca os anúncios de novo no servidor. */
  load(): void;
}

/** A aba "Jogadores" do mercado. Só desenha e pede ao servidor; quem confere tudo é o servidor. */
export class MarketView {
  data: MarketData | null = null;
  private sub: Sub = 'comprar';
  private filter: ListingKind | 'all' = 'all';
  private readonly drafts = new Map<string, Draft>();

  constructor(private readonly game: Game, private readonly deps: MarketDeps) {}

  private draft(id: string, price = ''): Draft {
    let d = this.drafts.get(id);
    if (!d) {
      d = { to: '', price, qty: '', days: '3', currency: 'silver' };
      this.drafts.set(id, d);
    }
    return d;
  }

  private btn(text: string, fn: () => void, alt = false): HTMLButtonElement {
    const b = h('button', 'mb' + (alt ? ' alt' : ''), text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  render(box: HTMLElement): void {
    box.appendChild(h('p', 'mnote', 'Compre e venda com outros jogadores. A taxa é de ' + FEE_RATE * 100 + '% e sai de quem vende. Anúncios vencem em ' + LISTING_DAYS + ' dias e o item volta para o dono. O que você anuncia fica guardado no anúncio até vender ou cancelar.'));
    const p = this.game.player;
    box.appendChild(h('p', 'mnote', 'Prata ' + p.silver + ' · Ouro ' + p.gold));
    const tabs = h('div', 'mbs');
    const d = this.data;
    const labels: Array<[Sub, string]> = [
      ['comprar', 'Comprar' + (d ? ' (' + d.listings.filter((l) => !l.mine).length + ')' : '')],
      ['vender', 'Vender'],
      ['meus', 'Meus anúncios' + (d ? ' (' + d.mine.filter((l) => l.status === 'open').length + ')' : '')],
      ['alugueis', 'Aluguéis' + (d ? ' (' + (d.lent.length + d.rented.length) + ')' : '')],
    ];
    for (const [k, label] of labels) tabs.appendChild(this.btn(label, () => { this.sub = k; this.deps.render(); }, this.sub !== k));
    tabs.appendChild(this.btn('Atualizar', () => this.deps.load(), true));
    box.appendChild(tabs);
    if (!d) {
      box.appendChild(h('p', 'mnote', 'Carregando os anúncios…'));
      return;
    }
    if (this.sub === 'comprar') this.buyPanel(box, d);
    else if (this.sub === 'vender') this.sellPanel(box);
    else if (this.sub === 'meus') this.minePanel(box, d);
    else this.rentalsPanel(box, d);
  }

  // ---------- comprar ----------

  private describe(l: ListingView): string {
    switch (l.kind) {
      case 'item': return l.qty + ' × ' + (ITEMS[l.key as keyof typeof ITEMS]?.name ?? l.key);
      case 'gear': {
        const e = EQUIPMENT[l.key];
        return e ? e.name + ' (' + SLOT_NAME[e.slot].toLowerCase() + ', ' + RARITY_NAME[e.rarity].toLowerCase() + '): ' + describeMods(e.mods) : l.key;
      }
      case 'gold': return l.qty + ' de ouro';
      case 'worker':
      case 'rent': {
        const w = l.worker;
        const stats = w ? ' · vida ' + w.hp + ' · enxada ' + w.lv.enxada + ' · regador ' + w.lv.regador + ' · foice ' + w.lv.foice + ' · plantio ' + w.lv.plantio : '';
        const ab = w && w.abilities.length ? ' · ' + w.abilities.map((id) => ABILITIES[id]?.name ?? id).join(', ') : ' · sem habilidade especial';
        return (l.kind === 'rent' ? 'ALUGUEL de ' : 'Trabalhador ') + l.key + stats + ab;
      }
    }
  }

  private priceText(l: ListingView): string {
    if (l.kind === 'rent' && l.rent && l.price === 0) return l.rent.days + ' dia(s) de graça';
    if (l.kind === 'rent' && l.rent) return l.rent.days + ' dia(s) a ' + money(l.rent.pricePerDay, l.currency) + ' por dia = ' + money(l.rent.total, l.currency);
    return money(l.price, l.currency);
  }

  private listingRow(l: ListingView, action?: { label: string; fn: () => void; disabled?: boolean }): HTMLElement {
    const row = h('div', 'mrow');
    const text = h('span');
    text.appendChild(h('b', undefined, this.describe(l)));
    const meta = h('span', 'mnote');
    meta.textContent = ' · ' + this.priceText(l) + ' · de ' + l.seller + (l.target ? ' · privado para ' + l.target : '') + (l.avg !== null ? ' · média recente: ' + l.avg + ' por unidade' : '') + (l.status === 'open' ? ' · vence em ' + l.expiresInDays + ' dia(s)' : '');
    text.appendChild(meta);
    if (l.kind === 'item') {
      const icon = h('span', 'micon');
      icon.innerHTML = iconSvg(l.key as never);
      text.prepend(icon);
    }
    row.appendChild(text);
    if (action) {
      const b = this.btn(action.label, action.fn);
      b.disabled = !!action.disabled;
      row.appendChild(b);
    }
    return row;
  }

  private buyPanel(box: HTMLElement, d: MarketData): void {
    const filters = h('div', 'mbs');
    for (const [k, label] of KIND_FILTERS) filters.appendChild(this.btn(label, () => { this.filter = k; this.deps.render(); }, this.filter !== k));
    box.appendChild(filters);
    const p = this.game.player;
    const list = d.listings.filter((l) => !l.mine && (this.filter === 'all' || l.kind === this.filter));
    if (!list.length) box.appendChild(h('p', 'mnote', 'Nenhum anúncio de outros jogadores nesta categoria.'));
    for (const l of list) {
      const total = l.kind === 'rent' && l.rent ? l.rent.total : l.price;
      const wallet = l.currency === 'silver' ? p.silver : p.gold;
      box.appendChild(this.listingRow(l, {
        label: l.kind === 'rent' ? 'Alugar' : 'Comprar',
        disabled: wallet < total,
        fn: () => this.deps.act({ t: 'marketBuy', id: l.id }),
      }));
    }
  }

  // ---------- vender ----------

  private input(draftId: string, field: 'price' | 'qty' | 'days', placeholder: string, width = 78, min = 1): HTMLInputElement {
    const d = this.draft(draftId);
    const i = h('input', 'mini');
    i.type = 'number';
    i.min = String(min);
    i.step = '1';
    i.placeholder = placeholder;
    i.value = d[field];
    i.style.width = width + 'px';
    i.setAttribute('aria-label', placeholder);
    i.addEventListener('input', () => { d[field] = i.value; });
    return i;
  }

  private currencySelect(draftId: string, onlySilver = false): HTMLElement {
    const d = this.draft(draftId);
    if (onlySilver) return h('span', 'mnote', 'em prata');
    const s = h('select', 'mini');
    for (const [v, label] of [['silver', 'prata'], ['gold', 'ouro']] as const) {
      const o = h('option', undefined, label);
      o.value = v;
      o.selected = d.currency === v;
      s.appendChild(o);
    }
    s.setAttribute('aria-label', 'Moeda');
    s.addEventListener('change', () => { d.currency = s.value as Currency; });
    return s;
  }

  private submit(draftId: string, spec: SellSpec, forceSilver = false): void {
    const d = this.draft(draftId);
    const price = Math.floor(Number(d.price));
    const free = spec.what === 'rent' && !!spec.to;
    if (!Number.isFinite(price) || price < (free ? 0 : 1)) {
      this.game.say(free ? 'Escreva um preço por dia de 0 para cima (0 empresta de graça).' : 'Escreva um preço de 1 para cima.');
      return;
    }
    this.deps.act({ t: 'marketSell', spec, price, currency: forceSilver ? 'silver' : d.currency });
  }

  private sellRow(draftId: string, label: string, controls: HTMLElement[], button: HTMLButtonElement): HTMLElement {
    const row = h('div', 'mrow');
    row.appendChild(h('span', undefined, label));
    const c = h('span', 'mbs');
    c.append(...controls, button);
    row.appendChild(c);
    void draftId;
    return row;
  }

  private sellPanel(box: HTMLElement): void {
    const p = this.game.player;
    box.appendChild(h('p', 'mnote', 'Escolha o preço total do anúncio. Você recebe o preço menos ' + FEE_RATE * 100 + '%: por exemplo, um anúncio de 200 rende ' + sellerGets(200) + ' (taxa ' + marketFee(200) + ').'));

    box.appendChild(h('h4', undefined, 'Itens da mochila'));
    let any = false;
    for (const k of ITEM_KEYS) {
      const have = p.inv[k];
      if (have < 1) continue;
      any = true;
      const id = 'item:' + k;
      const d = this.draft(id);
      if (!d.qty) d.qty = String(have);
      const qtyIn = this.input(id, 'qty', 'quantidade', 64);
      const priceIn = this.input(id, 'price', 'preço total');
      const b = this.btn('Anunciar', () => {
        const qty = Math.floor(Number(d.qty));
        if (!Number.isFinite(qty) || qty < 1 || qty > have) { this.game.say('Quantidade de 1 a ' + have + '.'); return; }
        this.submit(id, { what: 'item', key: k, qty });
      });
      box.appendChild(this.sellRow(id, ITEMS[k].name + ' (você tem ' + have + ')', [qtyIn, priceIn, this.currencySelect(id)], b));
    }
    if (!any) box.appendChild(h('p', 'mnote', 'Mochila vazia.'));

    box.appendChild(h('h4', undefined, 'Peças de equipamento guardadas'));
    if (!p.gearInv.length) box.appendChild(h('p', 'mnote', 'Nenhuma peça guardada (tire do corpo em Personagem, C).'));
    p.gearInv.forEach((gid, idx) => {
      const id = 'gear:' + gid + ':' + idx;
      const e = EQUIPMENT[gid];
      const b = this.btn('Anunciar', () => this.submit(id, { what: 'gear', id: gid }));
      box.appendChild(this.sellRow(id, e.name + ' (' + RARITY_NAME[e.rarity].toLowerCase() + '): ' + describeMods(e.mods), [this.input(id, 'price', 'preço total'), this.currencySelect(id)], b));
    });

    if (p.gold > 0) {
      box.appendChild(h('h4', undefined, 'Ouro (vendido por prata)'));
      const id = 'gold';
      const d = this.draft(id);
      if (!d.qty) d.qty = String(p.gold);
      const b = this.btn('Anunciar', () => {
        const qty = Math.floor(Number(d.qty));
        if (!Number.isFinite(qty) || qty < 1 || qty > p.gold) { this.game.say('Quantidade de 1 a ' + p.gold + '.'); return; }
        this.submit(id, { what: 'gold', qty }, true);
      });
      box.appendChild(this.sellRow(id, 'Você tem ' + p.gold + ' de ouro', [this.input(id, 'qty', 'ouro', 64), this.input(id, 'price', 'prata pedida'), this.currencySelect(id, true)], b));
    }

    box.appendChild(h('h4', undefined, 'Trabalhadores'));
    box.appendChild(h('p', 'mnote', 'Ao vender ou alugar, os itens e as peças do trabalhador voltam para o seu armazém e a sua mochila. Quem recebe ele recebe sem nada.'));
    for (const w of this.game.workers) {
      if (w.rental) {
        box.appendChild(h('p', 'mnote', w.name + ' é alugado de ' + w.rental.owner + ': não dá para vender nem alugar de novo.'));
        continue;
      }
      const sid = 'sell:' + w.name;
      const sell = this.btn('Vender', () => this.submit(sid, { what: 'worker', name: w.name }));
      box.appendChild(this.sellRow(sid, w.name + ': vender', [this.input(sid, 'price', 'preço total'), this.currencySelect(sid)], sell));
      const rid = 'rent:' + w.name;
      const dr = this.draft(rid);
      const rent = this.btn('Alugar', () => {
        const days = Math.floor(Number(dr.days));
        if (!Number.isFinite(days) || days < 1 || days > RENT_MAX_DAYS) { this.game.say('O aluguel vai de 1 a ' + RENT_MAX_DAYS + ' dias.'); return; }
        this.submit(rid, { what: 'rent', name: w.name, days, ...(dr.to ? { to: dr.to } : {}) });
      });
      const friends = this.data?.friends ?? [];
      const who = h('select', 'mini');
      who.setAttribute('aria-label', 'Para quem');
      const everyone = h('option', undefined, 'qualquer jogador');
      everyone.value = '';
      who.appendChild(everyone);
      for (const f of friends) {
        const o = h('option', undefined, 'só ' + f + ' (amigo)');
        o.value = f;
        o.selected = dr.to === f;
        who.appendChild(o);
      }
      who.addEventListener('change', () => { dr.to = who.value; });
      box.appendChild(this.sellRow(rid, w.name + ': alugar (preço por dia; 0 só para amigo)', [this.input(rid, 'days', 'dias', 56), this.input(rid, 'price', 'preço por dia', 78, 0), who, this.currencySelect(rid)], rent));
    }
  }

  // ---------- meus anúncios e aluguéis ----------

  private minePanel(box: HTMLElement, d: MarketData): void {
    if (!d.mine.length) box.appendChild(h('p', 'mnote', 'Você ainda não anunciou nada.'));
    const names: Record<ListingView['status'], string> = { open: 'aberto', sold: 'vendido', cancelled: 'cancelado', expired: 'vencido' };
    for (const l of d.mine) {
      const row = h('div', 'mrow');
      const text = h('span');
      text.appendChild(h('b', undefined, this.describe(l)));
      text.appendChild(h('span', 'mnote', ' · ' + this.priceText(l) + ' · ' + names[l.status]));
      row.appendChild(text);
      if (l.status === 'open') row.appendChild(this.btn('Cancelar', () => this.deps.act({ t: 'marketCancel', id: l.id }), true));
      box.appendChild(row);
    }
  }

  private rentalRow(r: RentalView, mine: 'lent' | 'rented'): HTMLElement {
    const row = h('div', 'mrow');
    const who = mine === 'lent' ? 'alugado por ' + r.other : 'alugado de ' + r.other;
    row.appendChild(h('span', undefined, r.worker + ' · ' + who + ' · ' + r.daysLeft + ' de ' + r.daysTotal + ' dia(s) restantes · ' + money(r.pricePerDay, r.currency) + ' por dia'));
    if (mine === 'lent') row.appendChild(this.btn('Chamar de volta', () => this.deps.act({ t: 'rentRecall', id: r.id }), true));
    return row;
  }

  private rentalsPanel(box: HTMLElement, d: MarketData): void {
    box.appendChild(h('p', 'mnote', 'O aluguel conta os dias do jogo de quem alugou: a cada dia que ele dorme, o dono recebe um dia (menos a taxa). Se o dono chamar de volta, quem alugou recebe os dias que sobraram.'));
    box.appendChild(h('h4', undefined, 'Meus trabalhadores alugados por outros'));
    if (!d.lent.length) box.appendChild(h('p', 'mnote', 'Nenhum.'));
    for (const r of d.lent) box.appendChild(this.rentalRow(r, 'lent'));
    box.appendChild(h('h4', undefined, 'Trabalhadores que eu aluguei'));
    if (!d.rented.length) box.appendChild(h('p', 'mnote', 'Nenhum.'));
    for (const r of d.rented) box.appendChild(this.rentalRow(r, 'rented'));
  }
}
