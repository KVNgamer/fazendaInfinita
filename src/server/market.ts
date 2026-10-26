import { EQUIPMENT } from '../core/equipment';
import type { Game } from '../core/game';
import { MAX_WORKERS } from '../core/game';
import { ITEMS, ITEM_KEYS } from '../core/items';
import type { ItemKey } from '../core/items';
import {
  LISTING_DAYS, MAX_OPEN_LISTINGS, MAX_PRICE, RENT_MAX_DAYS, sellerGets, marketFee,
} from '../core/market';
import type {
  Currency, ListingKind, ListingView, MarketData, RentalView, SellSpec, WorkerPackage, WorkerSummary,
} from '../core/market';
import { restore, serialize } from '../core/save';
import type { CommandResult } from '../net/protocol';
import type { Db, ListingRow, MailRow, RentalRow } from './db';

/** O que o mercado precisa saber de quem está conectado. */
export interface MarketSession {
  userId: number;
  username: string;
  game: Game;
  /** Mostra um aviso a essa pessoa. */
  notify(text: string): void;
  /** Pede que o relógio do jogo dela espere (devolve a função que libera). Opcional: nos testes simples não existe. */
  freeze?(): () => void;
}

const DAY_MS = 86_400_000;
/** Quantas vendas recentes entram no preço médio. */
const AVG_SALES = 20;

const ok = (message: string, data?: unknown): CommandResult => ({ ok: true, message, data });
const fail = (message: string): CommandResult => ({ ok: false, message });

/** Algo impediu a transação depois de começar (por exemplo, alguém comprou antes). */
class Conflict extends Error {}

function describe(row: Pick<ListingRow, 'kind' | 'key' | 'qty'>): string {
  switch (row.kind) {
    case 'item': return row.qty + ' × ' + (ITEMS[row.key as ItemKey]?.name ?? row.key);
    case 'gear': return EQUIPMENT[row.key]?.name ?? row.key;
    case 'gold': return row.qty + ' de ouro';
    case 'worker': return 'o trabalhador ' + row.key;
    case 'rent': return 'o aluguel de ' + row.key + ' por ' + row.qty + ' dia(s)';
  }
}

function money(n: number, c: Currency): string {
  return n + ' de ' + (c === 'silver' ? 'prata' : 'ouro');
}

function parsePkg(json: string): WorkerPackage | null {
  try {
    const x = JSON.parse(json) as { pkg?: WorkerPackage };
    return x.pkg && x.pkg.cfg && Array.isArray(x.pkg.prios) ? x.pkg : null;
  } catch {
    return null;
  }
}

function summary(pkg: WorkerPackage): WorkerSummary {
  return { name: pkg.cfg.name, hp: pkg.cfg.hp, lv: { ...pkg.cfg.lv }, abilities: [...pkg.cfg.abilities] };
}

/**
 * Mercado entre jogadores. Regras que não podem falhar:
 *  - o item sai do vendedor ao anunciar e fica guardado no anúncio (ninguém fica com dois);
 *  - comprar é tudo ou nada: a prata do comprador, o item, o pagamento do vendedor e o fim do anúncio
 *    entram no banco numa transação só, junto com o save do comprador;
 *  - quem vende com o dono desconectado recebe pelo correio, ao voltar.
 */
export class Market {
  constructor(
    private readonly db: Db,
    private readonly online: (userId: number) => MarketSession | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** Roda `fn` com o relógio do jogo de `s` parado: o jogo e o banco mudam juntos, sem um passo do relógio no meio. */
  private async frozen<T>(s: MarketSession, fn: () => Promise<T>): Promise<T> {
    const release = s.freeze?.();
    try {
      return await fn();
    } finally {
      release?.();
    }
  }

  // ---------- base: mudar o jogo e o banco juntos, ou nada ----------

  /** Muda o jogo de quem fez a ação, grava no banco e salva o jogo dele, tudo numa transação. Se algo falhar, desfaz. */
  private async commit(s: MarketSession, mutate: () => void, persist: (db: Db) => Promise<void>): Promise<void> {
    const backup = serialize(s.game);
    try {
      mutate();
      await this.db.transaction(async (tx) => {
        await persist(tx);
        await tx.writeSave(s.userId, JSON.stringify(serialize(s.game)), this.now());
      });
    } catch (e) {
      restore(s.game, backup);
      throw e;
    }
  }

  private async mail(db: Db, userId: number, kind: string, payload: Record<string, unknown>): Promise<void> {
    await db.insertMail(userId, kind, payload, this.now());
  }

  private payMail(db: Db, userId: number, currency: Currency, n: number, text: string): Promise<void> {
    return this.mail(db, userId, currency, { n, text });
  }

  // ---------- correio ----------

  /** Coloca no jogo de quem está conectado tudo que chegou pelo correio. */
  async deliver(userId: number): Promise<void> {
    const s = this.online(userId);
    if (!s) return;
    return this.frozen(s, () => this.deliverNow(userId, s));
  }

  private async deliverNow(userId: number, s: MarketSession): Promise<void> {
    const mails = await this.db.pendingMail(userId);
    if (!mails.length) return;
    const backup = serialize(s.game);
    const done: number[] = [];
    const texts: string[] = [];
    try {
      for (const m of mails) {
        const r = this.apply(s, m);
        if (r === 'keep') break;
        done.push(m.id);
        if (r) texts.push(r);
      }
      if (!done.length) return;
      await this.db.transaction(async (tx) => {
        for (const id of done) await tx.deleteMail(id);
        await tx.writeSave(userId, JSON.stringify(serialize(s.game)), this.now());
      });
    } catch (e) {
      restore(s.game, backup);
      throw e;
    }
    for (const t of texts) s.notify(t);
  }

  /** Aplica uma carta. Devolve o aviso, '' se não há aviso, ou 'keep' para deixar a carta para depois. */
  private apply(s: MarketSession, mail: MailRow): string | 'keep' {
    const g = s.game;
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(mail.payload) as Record<string, unknown>;
    } catch {
      return ''; // carta ilegível: descarta
    }
    const text = typeof p.text === 'string' ? p.text : '';
    const n = typeof p.n === 'number' && Number.isInteger(p.n) && p.n > 0 && p.n <= 1e9 ? p.n : 0;
    switch (mail.kind) {
      case 'silver': g.player.silver += n; return text;
      case 'gold': g.player.gold += n; return text;
      case 'item': {
        const key = p.key as ItemKey;
        const qty = typeof p.qty === 'number' && Number.isInteger(p.qty) && p.qty > 0 && p.qty <= 1e6 ? p.qty : 0;
        if ((ITEM_KEYS as readonly string[]).includes(key) && qty) g.receiveItem(key, qty);
        return text;
      }
      case 'gear':
        if (typeof p.id === 'string' && EQUIPMENT[p.id]) g.player.gearInv.push(p.id);
        return text;
      case 'worker': {
        const pkg = p.pkg as WorkerPackage | undefined;
        if (!pkg?.cfg) return '';
        // sem lugar na fazenda: a carta espera
        return g.attachWorker(pkg) ? text : 'keep';
      }
      case 'recall': {
        const w = g.workers.find((x) => x.rental?.id === p.rentalId);
        if (w) g.detachWorker(w);
        return text;
      }
      case 'note': return text;
      default: return '';
    }
  }

  // ---------- anunciar ----------

  sell(s: MarketSession, spec: SellSpec, price: number, currency: Currency): Promise<CommandResult> {
    return this.frozen(s, () => this.sellNow(s, spec, price, currency));
  }

  private async sellNow(s: MarketSession, spec: SellSpec, price: number, currency: Currency): Promise<CommandResult> {
    const g = s.game;
    const p = g.player;
    if (currency !== 'silver' && currency !== 'gold') return fail('Moeda inválida.');
    // só o empréstimo a um amigo pode ser de graça
    const minPrice = spec.what === 'rent' && spec.to ? 0 : 1;
    if (!Number.isInteger(price) || price < minPrice || price > MAX_PRICE[currency]) return fail('Preço inválido: de ' + minPrice + ' a ' + MAX_PRICE[currency] + '.');
    if (spec.what === 'gold' && currency !== 'silver') return fail('O ouro só se vende por prata.');
    if ((await this.db.countOpen(s.userId, this.now())) >= MAX_OPEN_LISTINGS) return fail('Você já tem ' + MAX_OPEN_LISTINGS + ' anúncios abertos. Cancele algum antes.');

    let kind: ListingKind;
    let key: string;
    let qty = 1;
    let payload: Record<string, unknown> = {};
    let target: { id: number; name: string } | null = null;
    let mutate: () => void;

    switch (spec.what) {
      case 'item': {
        if (!(ITEM_KEYS as readonly string[]).includes(spec.key) || !Number.isInteger(spec.qty) || spec.qty < 1) return fail('Item inválido.');
        if (p.inv[spec.key] < spec.qty) return fail('Você não tem ' + spec.qty + ' × ' + ITEMS[spec.key].name + ' na mochila.');
        kind = 'item'; key = spec.key; qty = spec.qty;
        mutate = () => { p.inv[spec.key] -= spec.qty; };
        break;
      }
      case 'gear': {
        const i = p.gearInv.indexOf(spec.id);
        if (i < 0) return fail('Você não tem essa peça guardada na mochila (tire-a do corpo antes).');
        kind = 'gear'; key = spec.id;
        mutate = () => { p.gearInv.splice(p.gearInv.indexOf(spec.id), 1); };
        break;
      }
      case 'gold': {
        if (!Number.isInteger(spec.qty) || spec.qty < 1) return fail('Quantidade inválida.');
        if (p.gold < spec.qty) return fail('Você não tem ' + spec.qty + ' de ouro.');
        kind = 'gold'; key = 'gold'; qty = spec.qty;
        mutate = () => { p.gold -= spec.qty; };
        break;
      }
      case 'worker':
      case 'rent': {
        const w = g.workers.find((x) => x.name === spec.name);
        if (!w) return fail('Esse trabalhador não existe.');
        if (w.rental) return fail(w.name + ' é alugado: não dá para vender nem alugar de novo.');
        if (spec.what === 'rent') {
          if (!Number.isInteger(spec.days) || spec.days < 1 || spec.days > RENT_MAX_DAYS) return fail('O aluguel vai de 1 a ' + RENT_MAX_DAYS + ' dias.');
          qty = spec.days;
          if (spec.to) {
            const friend = await this.db.findUser(spec.to);
            if (!friend || friend.id === s.userId) return fail('Esse jogador não existe.');
            if ((await this.db.getFriendship(s.userId, friend.id))?.status !== 'accepted') return fail(friend.username + ' não é seu amigo.');
            target = { id: friend.id, name: friend.username };
          }
        }
        kind = spec.what; key = w.name;
        mutate = () => { payload = { pkg: g.detachWorker(w) }; };
        break;
      }
    }

    let id = 0;
    try {
      await this.commit(s, mutate, async (tx) => {
        id = await tx.insertListing({
          sellerId: s.userId, sellerName: s.username, kind, key, qty, payload: JSON.stringify(payload), currency, price,
          createdAt: this.now(), expiresAt: this.now() + LISTING_DAYS * DAY_MS, targetId: target?.id ?? null, targetName: target?.name ?? null,
        });
      });
    } catch {
      return fail('Não foi possível criar o anúncio agora.');
    }
    const what = describe({ kind, key, qty });
    if (target) {
      return ok('Emprestei' + (price ? ' (' + money(price, currency) + ' por dia)' : ' de graça') + ': ' + what + ' para ' + target.name + '. Só ele vê. Fica aberto por ' + LISTING_DAYS + ' dias.', { id });
    }
    const text = kind === 'rent' ? ' por ' + money(price, currency) + ' ao dia' : ' por ' + money(price, currency);
    return ok('Anúncio criado: ' + what + text + '. Fica aberto por ' + LISTING_DAYS + ' dias; a taxa de ' + marketFee(price) + ' sai de quem vende.', { id });
  }

  // ---------- comprar e alugar ----------

  buy(s: MarketSession, id: number): Promise<CommandResult> {
    return this.frozen(s, () => this.buyNow(s, id));
  }

  private async buyNow(s: MarketSession, id: number): Promise<CommandResult> {
    const g = s.game;
    const p = g.player;
    const now = this.now();
    const row = await this.db.getListing(id);
    if (!row || row.status !== 'open' || row.expiresAt <= now) return fail('Esse anúncio não está mais disponível.');
    if (row.sellerId === s.userId) return fail('Esse anúncio é seu. Para desfazer, cancele.');
    if (row.targetId !== null && row.targetId !== s.userId) return fail('Esse anúncio não está mais disponível.');
    const pkg = row.kind === 'worker' || row.kind === 'rent' ? parsePkg(row.payload) : null;
    if ((row.kind === 'worker' || row.kind === 'rent') && !pkg) return fail('Esse anúncio está com defeito.');
    const total = row.kind === 'rent' ? row.price * row.qty : row.price;
    if ((row.currency === 'silver' ? p.silver : p.gold) < total) return fail((row.currency === 'silver' ? 'Prata' : 'Ouro') + ' insuficiente: custa ' + money(total, row.currency) + '.');
    if (pkg && g.workers.length >= MAX_WORKERS) return fail('Sua fazenda está cheia de trabalhadores (' + MAX_WORKERS + ').');

    const mutate = () => {
      if (row.currency === 'silver') p.silver -= total;
      else p.gold -= total;
      switch (row.kind) {
        case 'item': g.receiveItem(row.key as ItemKey, row.qty); break;
        case 'gear': p.gearInv.push(row.key); break;
        case 'gold': p.gold += row.qty; break;
        case 'worker': g.attachWorker(pkg!); break;
        case 'rent': g.attachWorker(pkg!, { id: row.id, owner: row.sellerName, daysLeft: row.qty, pricePerDay: row.price, currency: row.currency }); break;
      }
    };
    const persist = async (tx: Db) => {
      if (!(await tx.closeListing(row.id, 'sold', s.userId, now))) throw new Conflict('outro comprou antes');
      if (row.kind === 'rent') {
        await tx.insertRental({
          id: row.id, ownerId: row.sellerId, ownerName: row.sellerName, renterId: s.userId, renterName: s.username,
          workerName: row.key, payload: row.payload, pricePerDay: row.price, currency: row.currency,
          daysTotal: row.qty, daysLeft: row.qty, createdAt: now,
        });
        await this.mail(tx, row.sellerId, 'note', { text: row.price === 0
          ? s.username + ' aceitou o empréstimo de ' + row.key + ' por ' + row.qty + ' dia(s).'
          : s.username + ' alugou ' + row.key + ' por ' + row.qty + ' dia(s). Você recebe ' + money(sellerGets(row.price), row.currency) + ' por dia que ele trabalhar.' });
        return;
      }
      // o ouro é vendido por prata: quem vende recebe prata
      const payCurrency: Currency = row.kind === 'gold' ? 'silver' : row.currency;
      const gets = sellerGets(total);
      await this.payMail(tx, row.sellerId, payCurrency, gets, 'Você vendeu ' + describe(row) + ' para ' + s.username + ': +' + money(gets, payCurrency) + ' (taxa ' + marketFee(total) + ').');
      const histKey = row.kind === 'item' ? 'item:' + row.key : row.kind === 'gear' ? 'gear:' + row.key : row.kind;
      await tx.insertSale(histKey, row.qty, total, row.currency, now);
    };

    try {
      await this.commit(s, mutate, persist);
    } catch (e) {
      return fail(e instanceof Conflict ? 'Alguém comprou antes de você.' : 'Não foi possível concluir a compra agora.');
    }
    await this.deliver(row.sellerId);
    const what = describe(row);
    return ok(row.kind === 'rent'
      ? 'Você alugou ' + what.replace('o aluguel de ', '') + ' por ' + money(total, row.currency) + '. Ele chega às 08:00 e vale pelos seus dias de jogo.'
      : 'Você comprou ' + what + ' por ' + money(total, row.currency) + '.');
  }

  // ---------- cancelar e vencer ----------

  /** Devolve ao dono (se estiver conectado) ou deixa no correio. */
  private async returnMail(db: Db, row: ListingRow): Promise<void> {
    const why = 'Seu anúncio de ' + describe(row) + ' venceu e voltou para você.';
    switch (row.kind) {
      case 'item': await this.mail(db, row.sellerId, 'item', { key: row.key, qty: row.qty, text: why }); break;
      case 'gear': await this.mail(db, row.sellerId, 'gear', { id: row.key, text: why }); break;
      case 'gold': await this.mail(db, row.sellerId, 'gold', { n: row.qty, text: why }); break;
      default: {
        const pkg = parsePkg(row.payload);
        if (pkg) await this.mail(db, row.sellerId, 'worker', { pkg, text: why });
      }
    }
  }

  cancel(s: MarketSession, id: number): Promise<CommandResult> {
    return this.frozen(s, () => this.cancelNow(s, id));
  }

  private async cancelNow(s: MarketSession, id: number): Promise<CommandResult> {
    const g = s.game;
    const row = await this.db.getListing(id);
    if (!row || row.status !== 'open') return fail('Esse anúncio não está mais aberto.');
    if (row.sellerId !== s.userId) return fail('Esse anúncio não é seu.');
    const pkg = row.kind === 'worker' || row.kind === 'rent' ? parsePkg(row.payload) : null;
    if (pkg && g.workers.length >= MAX_WORKERS) return fail('Sua fazenda está cheia: não há lugar para ' + row.key + ' voltar.');
    try {
      await this.commit(
        s,
        () => {
          switch (row.kind) {
            case 'item': g.receiveItem(row.key as ItemKey, row.qty); break;
            case 'gear': g.player.gearInv.push(row.key); break;
            case 'gold': g.player.gold += row.qty; break;
            default: if (pkg) g.attachWorker(pkg);
          }
        },
        async (tx) => {
          if (!(await tx.closeListing(row.id, 'cancelled', null, this.now()))) throw new Conflict('já fechado');
        },
      );
    } catch {
      return fail('Não foi possível cancelar agora.');
    }
    return ok('Anúncio cancelado: ' + describe(row) + ' voltou para você.');
  }

  /** Anúncios vencidos voltam para os donos (pelo correio). Chamado de tempos em tempos. */
  async expire(): Promise<number> {
    const rows = await this.db.expiredOpen(this.now());
    for (const row of rows) {
      await this.db.transaction(async (tx) => {
        if (await tx.closeListing(row.id, 'expired', null, this.now())) await this.returnMail(tx, row);
      });
      await this.deliver(row.sellerId);
    }
    return rows.length;
  }

  // ---------- aluguel de trabalhadores ----------

  /** O dono chama o trabalhador de volta. O comprador recebe de volta os dias que sobraram. */
  async recall(s: MarketSession, id: number): Promise<CommandResult> {
    const row = await this.db.getRental(id);
    if (!row || row.status !== 'active') return fail('Esse aluguel não está mais ativo.');
    if (row.ownerId !== s.userId) return fail('Esse aluguel não é seu.');
    const pkg = parsePkg(row.payload);
    if (!pkg) return fail('Esse aluguel está com defeito.');
    const refund = row.pricePerDay * row.daysLeft;
    await this.db.transaction(async (tx) => {
      await tx.updateRental(row.id, row.daysLeft, 'recalled');
      if (refund > 0) await this.payMail(tx, row.renterId, row.currency, refund, row.ownerName + ' chamou ' + row.workerName + ' de volta. Você recebeu de volta ' + money(refund, row.currency) + ' dos dias que sobraram.');
      await this.mail(tx, row.renterId, 'recall', { rentalId: row.id, text: row.workerName + ' foi chamado de volta pelo dono.' });
      await this.mail(tx, row.ownerId, 'worker', { pkg, text: row.workerName + ' voltou para a sua fazenda.' });
    });
    await this.deliver(row.renterId);
    await this.deliver(row.ownerId);
    return ok('Você chamou ' + row.workerName + ' de volta. ' + row.renterName + ' recebeu ' + money(refund, row.currency) + ' dos dias que sobraram.');
  }

  /** Ao fim de cada dia de quem alugou: paga o dia ao dono; se acabou o prazo, o trabalhador volta. */
  rentalDay(s: MarketSession): Promise<void> {
    return this.frozen(s, () => this.rentalDayNow(s));
  }

  private async rentalDayNow(s: MarketSession): Promise<void> {
    const g = s.game;
    const rented = g.workers.filter((w) => w.rental);
    if (!rented.length) return;
    const notes: string[] = [];
    const owners = new Set<number>();
    const ops: Array<(tx: Db) => Promise<void>> = [];
    const mutations: Array<() => void> = [];
    for (const w of rented) {
      const rental = w.rental!;
      const row = await this.db.getRental(rental.id);
      if (!row || row.status !== 'active' || row.renterId !== s.userId) {
        mutations.push(() => g.detachWorker(w));
        notes.push(w.name + ' não está mais alugado e saiu da sua fazenda.');
        continue;
      }
      const pay = sellerGets(row.pricePerDay);
      const left = row.daysLeft - 1;
      owners.add(row.ownerId);
      if (pay > 0) ops.push((tx) => this.payMail(tx, row.ownerId, row.currency, pay, w.name + ' trabalhou mais um dia para ' + s.username + ': +' + money(pay, row.currency) + ' (taxa ' + marketFee(row.pricePerDay) + ').'));
      if (left <= 0) {
        const pkg = parsePkg(row.payload);
        ops.push(async (tx) => {
          await tx.updateRental(row.id, 0, 'ended');
          if (pkg) await this.mail(tx, row.ownerId, 'worker', { pkg, text: row.workerName + ' terminou o aluguel e voltou para a sua fazenda.' });
        });
        mutations.push(() => g.detachWorker(w));
        notes.push('O aluguel de ' + w.name + ' acabou: ele voltou para o dono. Os itens dele estão no armazém.');
      } else {
        ops.push((tx) => tx.updateRental(row.id, left, 'active'));
        mutations.push(() => { rental.daysLeft = left; });
      }
    }
    try {
      await this.commit(s, () => mutations.forEach((m) => m()), async (tx) => {
        for (const o of ops) await o(tx);
      });
    } catch {
      return;
    }
    for (const t of notes) s.notify(t);
    for (const id of owners) await this.deliver(id);
  }

  /** Quem recomeça o jogo devolve os trabalhadores alugados: o dono os recebe e quem alugou recebe os dias que sobraram. */
  endRentals(s: MarketSession): Promise<void> {
    return this.frozen(s, () => this.endRentalsNow(s));
  }

  private async endRentalsNow(s: MarketSession): Promise<void> {
    const rented = s.game.workers.filter((w) => w.rental);
    const owners = new Set<number>();
    await this.db.transaction(async (tx) => {
      for (const w of rented) {
        const row = await tx.getRental(w.rental!.id);
        if (!row || row.status !== 'active' || row.renterId !== s.userId) continue;
        const pkg = parsePkg(row.payload);
        await tx.updateRental(row.id, 0, 'ended');
        const refund = row.pricePerDay * row.daysLeft;
        if (refund > 0) await this.payMail(tx, s.userId, row.currency, refund, 'Você devolveu ' + row.workerName + ' antes do prazo e recebeu ' + money(refund, row.currency) + ' de volta.');
        if (pkg) await this.mail(tx, row.ownerId, 'worker', { pkg, text: s.username + ' devolveu ' + row.workerName + ' antes do prazo.' });
        owners.add(row.ownerId);
      }
    });
    for (const id of owners) await this.deliver(id);
  }

  /** Ao entrar: tira da fazenda os trabalhadores alugados cujo aluguel já acabou ou foi desfeito enquanto você estava fora. */
  reconcile(s: MarketSession): Promise<void> {
    return this.frozen(s, () => this.reconcileNow(s));
  }

  private async reconcileNow(s: MarketSession): Promise<void> {
    const g = s.game;
    let changed = false;
    for (const w of [...g.workers]) {
      if (!w.rental) continue;
      const row = await this.db.getRental(w.rental.id);
      if (!row || row.status !== 'active' || row.renterId !== s.userId) {
        g.detachWorker(w);
        changed = true;
      } else {
        w.rental.daysLeft = row.daysLeft;
      }
    }
    if (changed) await this.db.writeSave(s.userId, JSON.stringify(serialize(g)), this.now());
  }

  // ---------- consultar ----------

  private async avg(key: string, currency: Currency): Promise<number | null> {
    const sales = await this.db.recentSales(key, currency, AVG_SALES);
    const qty = sales.reduce((a, x) => a + x.qty, 0);
    if (!qty) return null;
    return Math.round(sales.reduce((a, x) => a + x.total, 0) / qty);
  }

  private async view(row: ListingRow, viewerId: number): Promise<ListingView> {
    const pkg = row.kind === 'worker' || row.kind === 'rent' ? parsePkg(row.payload) : null;
    const histKey = row.kind === 'item' ? 'item:' + row.key : row.kind === 'gear' ? 'gear:' + row.key : row.kind === 'gold' ? 'gold' : null;
    return {
      id: row.id,
      seller: row.sellerName,
      kind: row.kind,
      key: row.key,
      qty: row.qty,
      price: row.price,
      currency: row.currency,
      status: row.status,
      mine: row.sellerId === viewerId,
      expiresInDays: Math.max(0, Math.ceil((row.expiresAt - this.now()) / DAY_MS)),
      avg: histKey ? await this.avg(histKey, row.currency) : null,
      worker: pkg ? summary(pkg) : undefined,
      target: row.targetName ?? undefined,
      rent: row.kind === 'rent' ? { pricePerDay: row.price, days: row.qty, total: row.price * row.qty } : undefined,
    };
  }

  private rentalView(r: RentalRow, other: string): RentalView {
    return { id: r.id, worker: r.workerName, other, pricePerDay: r.pricePerDay, currency: r.currency, daysLeft: r.daysLeft, daysTotal: r.daysTotal };
  }

  /** Tudo que a tela do mercado mostra: anúncios abertos, os seus, e os aluguéis dos dois lados. */
  async data(s: MarketSession, kind?: ListingKind): Promise<MarketData> {
    const now = this.now();
    const views = (rows: ListingRow[]) => Promise.all(rows.map((r) => this.view(r, s.userId)));
    return {
      listings: await views(await this.db.openListings(kind ?? null, now, 100, s.userId)),
      mine: await views(await this.db.userListings(s.userId, 30)),
      lent: (await this.db.rentalsByOwner(s.userId)).map((r) => this.rentalView(r, r.renterName)),
      rented: (await this.db.rentalsByRenter(s.userId)).map((r) => this.rentalView(r, r.ownerName)),
      friends: (await this.db.friendsOf(s.userId)).filter((f) => f.status === 'accepted').map((f) => f.otherName),
    };
  }
}
