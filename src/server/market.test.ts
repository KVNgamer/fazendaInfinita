import { describe, expect, it } from 'vitest';
import { Game, MAX_WORKERS } from '../core/game';
import { LISTING_DAYS, MAX_OPEN_LISTINGS, marketFee, sellerGets } from '../core/market';
import { testDb } from './testdb';
import { Market } from './market';
import type { MarketSession } from './market';

const DAY = 86_400_000;

interface P extends MarketSession {
  notes: string[];
}

async function world() {
  const db = await testDb();
  let t = 1_000_000;
  const sessions = new Map<number, P>();
  const market = new Market(db, (id) => sessions.get(id), () => t);
  const join = async (name: string): Promise<P> => {
    let id = (await db.findUser(name))?.id ?? (await db.createUser(name, 'h'))!;
    const saved = await db.loadSave(id);
    const game = new Game(() => 0.5);
    if (saved) void 0; // os testes reentram com o mesmo jogo (ver `rejoin`)
    const notes: string[] = [];
    const s: P = { userId: id, username: name, game, notes, notify: (x) => notes.push(x) };
    game.onMessage = (x) => notes.push(x);
    sessions.set(id, s);
    id = s.userId;
    return s;
  };
  const leave = async (s: P) => {
    await db.writeSave(s.userId, 'x', t);
    sessions.delete(s.userId);
  };
  const back = (s: P) => sessions.set(s.userId, s);
  return { db, market, join, leave, back, advance: (ms: number) => { t += ms; }, now: () => t };
}

const lastNote = (s: P) => s.notes[s.notes.length - 1] ?? '';

describe('taxa', () => {
  it('5%, mas nunca menos de 1 (preço 1 não paga)', async () => {
    expect([1, 2, 19, 20, 100, 200, 999].map(marketFee)).toEqual([0, 1, 1, 1, 5, 10, 49]);
    expect(sellerGets(3)).toBe(2);
    expect(sellerGets(1)).toBe(1);
  });

  it('vender em pedacinhos não escapa da taxa', async () => {
    // 10 anúncios de 3 pagam 10 de taxa, em vez de zero
    expect(marketFee(3) * 10).toBe(10);
  });
});

describe('anunciar', () => {
  it('o item sai da mochila e vai para o anúncio', async () => {
    const w = await world();
    const a = await w.join('ana');
    const r = await w.market.sell(a, { what: 'item', key: 'semente', qty: 10 }, 80, 'silver');
    expect(r.ok).toBe(true);
    expect(a.game.player.inv.semente).toBe(20);
    const view = (await w.market.data(a)).listings[0];
    expect(view).toMatchObject({ kind: 'item', key: 'semente', qty: 10, price: 80, currency: 'silver', mine: true, status: 'open', seller: 'ana' });
  });

  it('recusa preço inválido, quantidade que você não tem e item que não existe', async () => {
    const w = await world();
    const a = await w.join('ana');
    const sell = (spec: any, price = 10, cur: any = 'silver') => w.market.sell(a, spec, price, cur);
    expect((await sell({ what: 'item', key: 'semente', qty: 1 }, 0)).ok).toBe(false);
    expect((await sell({ what: 'item', key: 'semente', qty: 1 }, 1.5)).ok).toBe(false);
    expect((await sell({ what: 'item', key: 'semente', qty: 1 }, 99_999_999)).ok).toBe(false);
    expect((await sell({ what: 'item', key: 'semente', qty: 1 }, 10, 'ouro')).ok).toBe(false);
    expect((await sell({ what: 'item', key: 'semente', qty: 31 })).ok).toBe(false);
    expect((await sell({ what: 'item', key: 'diamante', qty: 1 })).ok).toBe(false);
    expect((await sell({ what: 'item', key: 'semente', qty: 0 })).ok).toBe(false);
    expect((await sell({ what: 'item', key: 'semente', qty: -3 })).ok).toBe(false);
    expect(a.game.player.inv.semente).toBe(30);
    expect((await w.market.data(a)).listings).toHaveLength(0);
  });

  it('não dá para anunciar o mesmo item duas vezes', async () => {
    const w = await world();
    const a = await w.join('ana');
    expect((await w.market.sell(a, { what: 'item', key: 'semente', qty: 30 }, 100, 'silver')).ok).toBe(true);
    expect((await w.market.sell(a, { what: 'item', key: 'semente', qty: 1 }, 100, 'silver')).ok).toBe(false);
  });

  it('peça de equipamento: só a que está guardada, não a vestida', async () => {
    const w = await world();
    const a = await w.join('ana');
    expect((await w.market.sell(a, { what: 'gear', id: 'chapeu_palha' }, 50, 'silver')).ok).toBe(false); // vestida
    expect((await w.market.sell(a, { what: 'gear', id: 'bota_corrida' }, 500, 'gold')).ok).toBe(true);
    expect(a.game.player.gearInv).not.toContain('bota_corrida');
  });

  it('ouro só se vende por prata', async () => {
    const w = await world();
    const a = await w.join('ana');
    a.game.player.gold = 10;
    expect((await w.market.sell(a, { what: 'gold', qty: 5 }, 5, 'gold')).ok).toBe(false);
    expect((await w.market.sell(a, { what: 'gold', qty: 11 }, 900, 'silver')).ok).toBe(false);
    expect((await w.market.sell(a, { what: 'gold', qty: 5 }, 900, 'silver')).ok).toBe(true);
    expect(a.game.player.gold).toBe(5);
  });

  it(`no máximo ${MAX_OPEN_LISTINGS} anúncios abertos por pessoa`, async () => {
    const w = await world();
    const a = await w.join('ana');
    a.game.player.inv.semente = 100;
    for (let i = 0; i < MAX_OPEN_LISTINGS; i++) expect((await w.market.sell(a, { what: 'item', key: 'semente', qty: 1 }, 5, 'silver')).ok).toBe(true);
    expect((await w.market.sell(a, { what: 'item', key: 'semente', qty: 1 }, 5, 'silver')).ok).toBe(false);
  });
});

describe('comprar', () => {
  it('com prata suficiente, tudo muda de mãos', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    b.game.player.silver = 1000;
    await w.market.sell(a, { what: 'item', key: 'semente', qty: 10 }, 200, 'silver');
    const id = (await w.market.data(b)).listings[0].id;
    expect((await w.market.buy(b, id)).ok).toBe(true);
    expect(b.game.player.silver).toBe(800);
    expect(b.game.store.semente).toBe(30); // comprado vai para o armazém
    expect(b.game.player.inv.semente).toBe(30);
    expect(a.game.player.silver).toBe(100 + sellerGets(200));
    expect(marketFee(200)).toBe(10);
    expect(lastNote(a)).toContain('vendeu');
    expect((await w.market.data(b)).listings).toHaveLength(0);
  });

  it('o mesmo anúncio não vende duas vezes', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    const c = await w.join('caio');
    b.game.player.silver = 1000;
    c.game.player.silver = 1000;
    await w.market.sell(a, { what: 'item', key: 'semente', qty: 5 }, 100, 'silver');
    const id = (await w.market.data(b)).listings[0].id;
    expect((await w.market.buy(b, id)).ok).toBe(true);
    const second = await w.market.buy(c, id);
    expect(second.ok).toBe(false);
    expect(c.game.player.silver).toBe(1000);
    expect(c.game.player.inv.semente).toBe(30);
  });

  it('não compra o próprio anúncio, nem sem dinheiro, nem anúncio que não existe', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.market.sell(a, { what: 'item', key: 'semente', qty: 5 }, 100, 'silver');
    const id = (await w.market.data(a)).listings[0].id;
    expect((await w.market.buy(a, id)).ok).toBe(false);
    b.game.player.silver = 99;
    const r = await w.market.buy(b, id);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('insuficiente');
    expect(b.game.player.silver).toBe(99);
    expect((await w.market.buy(b, 99999)).ok).toBe(false);
  });

  it('mochila cheia: o item comprado vai para o armazém', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    b.game.player.silver = 1000;
    b.game.player.inv.batata = 40; // 16 kg de 20
    a.game.player.inv.batata = 20;
    await w.market.sell(a, { what: 'item', key: 'batata', qty: 20 }, 100, 'silver'); // 8 kg: não cabe
    const id = (await w.market.data(b)).listings[0].id;
    expect((await w.market.buy(b, id)).ok).toBe(true);
    expect(b.game.player.inv.batata).toBe(40);
    expect(b.game.store.batata).toBe(20);
  });

  it('peça de equipamento vai para a mochila do comprador', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    b.game.player.gold = 5;
    await w.market.sell(a, { what: 'gear', id: 'bota_corrida' }, 4, 'gold');
    const id = (await w.market.data(b)).listings[0].id;
    expect((await w.market.buy(b, id)).ok).toBe(true);
    expect(b.game.player.gearInv).toContain('bota_corrida');
    expect(b.game.player.gold).toBe(1);
    expect(a.game.player.gold).toBe(sellerGets(4));
  });

  it('ouro por prata: o vendedor recebe prata, o comprador recebe ouro', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    a.game.player.gold = 10;
    b.game.player.silver = 5000;
    await w.market.sell(a, { what: 'gold', qty: 4 }, 1000, 'silver');
    const id = (await w.market.data(b)).listings[0].id;
    expect((await w.market.buy(b, id)).ok).toBe(true);
    expect(b.game.player.gold).toBe(4);
    expect(b.game.player.silver).toBe(4000);
    expect(a.game.player.silver).toBe(100 + 950);
    expect(a.game.player.gold).toBe(6);
  });

  it('preço médio das últimas vendas aparece nos anúncios seguintes', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    b.game.player.silver = 10_000;
    a.game.player.inv.semente = 100;
    expect((await w.market.sell(a, { what: 'item', key: 'semente', qty: 10 }, 100, 'silver')).ok).toBe(true);
    expect((await w.market.sell(a, { what: 'item', key: 'semente', qty: 10 }, 300, 'silver')).ok).toBe(true);
    expect((await w.market.sell(a, { what: 'item', key: 'semente', qty: 10 }, 50, 'silver')).ok).toBe(true);
    const ids = (await w.market.data(b)).listings.map((l) => l.id);
    expect((await w.market.data(b)).listings[0].avg).toBeNull();
    await w.market.buy(b, ids[2]); // 100 por 10
    await w.market.buy(b, ids[1]); // 300 por 10
    const left = (await w.market.data(b)).listings[0];
    expect(left.avg).toBe(20); // 400 por 20 unidades
  });

  it('vendedor desconectado recebe pelo correio ao voltar', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    b.game.player.silver = 1000;
    await w.market.sell(a, { what: 'item', key: 'semente', qty: 5 }, 100, 'silver');
    await w.leave(a);
    const id = (await w.market.data(b)).listings[0].id;
    expect((await w.market.buy(b, id)).ok).toBe(true);
    expect(a.game.player.silver).toBe(100); // ainda não chegou
    expect(await w.db.pendingMail(a.userId)).toHaveLength(1);
    w.back(a);
    await w.market.deliver(a.userId);
    expect(a.game.player.silver).toBe(100 + sellerGets(100));
    expect(await w.db.pendingMail(a.userId)).toHaveLength(0);
  });

  it('falha no meio: nada muda para ninguém (comprador, vendedor e anúncio)', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    b.game.player.silver = 1000;
    await w.market.sell(a, { what: 'item', key: 'semente', qty: 5 }, 100, 'silver');
    const id = (await w.market.data(b)).listings[0].id;
    // a transação usa a sua própria conexão: a falha precisa ser plantada nela
    const real = w.db.transaction.bind(w.db);
    w.db.transaction = (fn) => real((tx) => {
      tx.insertSale = async () => {
        throw new Error('disco cheio');
      };
      return fn(tx);
    });
    const r = await w.market.buy(b, id);
    expect(r.ok).toBe(false);
    expect(b.game.player.silver).toBe(1000);
    expect(b.game.player.inv.semente).toBe(30);
    expect((await w.db.getListing(id))!.status).toBe('open');
    expect(await w.db.pendingMail(a.userId)).toHaveLength(0);
  });
});

describe('trabalhadores à venda', () => {
  it('o trabalhador sai da fazenda com os itens guardados, e chega sem nada ao comprador', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    b.game.player.silver = 5000;
    const tiao = a.game.workers[0];
    const seeds = tiao.inv.semente;
    expect(tiao.gear.sapato).toBe('bota_couro');
    expect((await w.market.sell(a, { what: 'worker', name: 'Tião' }, 2000, 'silver')).ok).toBe(true);
    expect(a.game.workers.map((x) => x.name)).not.toContain('Tião');
    expect(a.game.store.semente).toBe(20 + seeds);
    expect(a.game.player.gearInv).toContain('bota_couro');

    const id = (await w.market.data(b)).listings[0].id;
    expect((await w.market.data(b)).listings[0].worker?.name).toBe('Tião');
    expect((await w.market.buy(b, id)).ok).toBe(true);
    const got = b.game.workers.find((x) => x.name === 'Tião 2')!;
    expect(got).toBeTruthy();
    expect(got.inv.semente).toBe(0);
    expect(got.gear.sapato).toBeNull();
    expect(got.abilities).toEqual(['mao_leve']);
    expect(a.game.player.silver).toBe(100 + sellerGets(2000));
  });

  it('nome repetido na fazenda do comprador ganha um número', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    b.game.player.silver = 5000;
    await w.market.sell(a, { what: 'worker', name: 'Zeca' }, 100, 'silver');
    await w.market.buy(b, (await w.market.data(b)).listings[0].id);
    const names = b.game.workers.map((x) => x.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('Zeca 2');
  });

  it('fazenda cheia não compra trabalhador', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    b.game.player.silver = 5000;
    while (b.game.workers.length < MAX_WORKERS) b.game.addWorker({ ...b.game.workers[0].cfg, name: 'X' + b.game.workers.length });
    await w.market.sell(a, { what: 'worker', name: 'Cida' }, 100, 'silver');
    const r = await w.market.buy(b, (await w.market.data(b)).listings[0].id);
    expect(r.ok).toBe(false);
    expect(b.game.player.silver).toBe(5000);
  });

  it('cancelar traz o trabalhador de volta', async () => {
    const w = await world();
    const a = await w.join('ana');
    await w.market.sell(a, { what: 'worker', name: 'Cida' }, 100, 'silver');
    expect(a.game.workers).toHaveLength(2);
    const id = (await w.market.data(a)).listings[0].id;
    expect((await w.market.cancel(a, id)).ok).toBe(true);
    expect(a.game.workers.map((x) => x.name)).toContain('Cida');
    expect((await w.market.data(a)).listings.filter((l) => l.status === 'open')).toHaveLength(0);
  });
});

describe('cancelar e vencer', () => {
  it('só o dono cancela, e o item volta', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    await w.market.sell(a, { what: 'item', key: 'semente', qty: 10 }, 100, 'silver');
    const id = (await w.market.data(a)).listings[0].id;
    expect((await w.market.cancel(b, id)).ok).toBe(false);
    expect((await w.market.cancel(a, id)).ok).toBe(true);
    expect(a.game.store.semente).toBe(30);
    expect(a.game.player.inv.semente).toBe(20);
    expect((await w.market.cancel(a, id)).ok).toBe(false);
    expect((await w.market.buy(b, id)).ok).toBe(false);
  });

  it('anúncio vencido volta para o dono pelo correio', async () => {
    const w = await world();
    const a = await w.join('ana');
    a.game.player.gold = 5;
    await w.market.sell(a, { what: 'item', key: 'semente', qty: 10 }, 100, 'silver');
    await w.market.sell(a, { what: 'gold', qty: 3 }, 500, 'silver');
    await w.market.sell(a, { what: 'gear', id: 'bota_corrida' }, 100, 'silver');
    await w.leave(a);
    w.advance((LISTING_DAYS + 1) * DAY);
    expect(await w.market.expire()).toBe(3);
    w.back(a);
    await w.market.deliver(a.userId);
    expect(a.game.store.semente).toBe(30);
    expect(a.game.player.gold).toBe(5);
    expect(a.game.player.gearInv).toContain('bota_corrida');
    expect(await w.market.expire()).toBe(0);
  });

  it('anúncio vencido não pode mais ser comprado', async () => {
    const w = await world();
    const a = await w.join('ana');
    const b = await w.join('beto');
    b.game.player.silver = 1000;
    await w.market.sell(a, { what: 'item', key: 'semente', qty: 1 }, 10, 'silver');
    const id = (await w.market.data(b)).listings[0].id;
    w.advance((LISTING_DAYS + 1) * DAY);
    expect((await w.market.buy(b, id)).ok).toBe(false);
    expect((await w.market.data(b)).listings).toHaveLength(0);
  });
});

describe('aluguel de trabalhador', () => {
  async function rented() {
    const w = await world();
    const owner = await w.join('dono');
    const renter = await w.join('locatario');
    renter.game.player.silver = 5000;
    await w.market.sell(owner, { what: 'rent', name: 'Cida', days: 3 }, 100, 'silver');
    const id = (await w.market.data(renter)).listings[0].id;
    const r = await w.market.buy(renter, id);
    return { w, owner, renter, id, r };
  }

  it('o locatário paga tudo antes e o trabalhador chega com os dias contados', async () => {
    const { r, renter, owner } = await rented();
    expect(r.ok).toBe(true);
    expect(renter.game.player.silver).toBe(4700);
    const c = renter.game.workers.find((x) => x.rental)!;
    expect(c.rental).toMatchObject({ owner: 'dono', daysLeft: 3, pricePerDay: 100 });
    expect(owner.game.workers.map((x) => x.name)).not.toContain('Cida');
    expect(owner.game.player.silver).toBe(100); // ainda nada: paga por dia trabalhado
  });

  it('cada dia do locatário paga o dono menos a taxa; no último, o trabalhador volta', async () => {
    const { w, owner, renter } = await rented();
    const cida = () => renter.game.workers.find((x) => x.rental);
    cida()!.inv.foice = 1;
    await w.market.rentalDay(renter);
    expect(owner.game.player.silver).toBe(100 + sellerGets(100));
    expect(cida()!.rental!.daysLeft).toBe(2);
    await w.market.rentalDay(renter);
    expect(cida()!.rental!.daysLeft).toBe(1);
    await w.market.rentalDay(renter);
    expect(cida()).toBeUndefined();
    expect(owner.game.player.silver).toBe(100 + 3 * sellerGets(100));
    expect(owner.game.workers.map((x) => x.name)).toContain('Cida');
    expect(renter.game.store.foice).toBe(1); // os itens dele ficam com quem alugou
    expect(await w.db.rentalsByOwner(owner.userId)).toHaveLength(0);
    expect(owner.game.workers.find((x) => x.name === 'Cida')!.inv.foice).toBe(0);
  });

  it('o dono chama de volta: o locatário recebe os dias que sobraram e o trabalhador some da fazenda dele', async () => {
    const { w, owner, renter, id } = await rented();
    await w.market.rentalDay(renter); // 1 dia usado
    const r = await w.market.recall(owner, id);
    expect(r.ok).toBe(true);
    expect(renter.game.workers.find((x) => x.rental)).toBeUndefined();
    expect(renter.game.player.silver).toBe(4700 + 200);
    expect(owner.game.workers.map((x) => x.name)).toContain('Cida');
    expect((await w.market.data(owner)).lent).toHaveLength(0);
    expect((await w.market.recall(owner, id)).ok).toBe(false);
  });

  it('chamar de volta com o locatário desconectado vale quando ele voltar', async () => {
    const { w, owner, renter, id } = await rented();
    await w.leave(renter);
    expect((await w.market.recall(owner, id)).ok).toBe(true);
    expect(renter.game.workers.find((x) => x.rental)).toBeTruthy(); // ainda lá, sem saber
    w.back(renter);
    await w.market.reconcile(renter);
    await w.market.deliver(renter.userId);
    expect(renter.game.workers.find((x) => x.rental)).toBeUndefined();
    expect(renter.game.player.silver).toBe(4700 + 300);
  });

  it('só o dono chama de volta, e o aluguel não se aluga nem se vende de novo', async () => {
    const { w, renter, id } = await rented();
    expect((await w.market.recall(renter, id)).ok).toBe(false);
    const c = renter.game.workers.find((x) => x.rental)!;
    expect((await w.market.sell(renter, { what: 'worker', name: c.name }, 100, 'silver')).ok).toBe(false);
    expect((await w.market.sell(renter, { what: 'rent', name: c.name, days: 2 }, 100, 'silver')).ok).toBe(false);
  });

  it('prazo de 1 a 14 dias', async () => {
    const w = await world();
    const a = await w.join('ana');
    expect((await w.market.sell(a, { what: 'rent', name: 'Cida', days: 0 }, 10, 'silver')).ok).toBe(false);
    expect((await w.market.sell(a, { what: 'rent', name: 'Cida', days: 15 }, 10, 'silver')).ok).toBe(false);
    expect((await w.market.sell(a, { what: 'rent', name: 'Cida', days: 14 }, 10, 'silver')).ok).toBe(true);
  });

  it('recomeçar o jogo devolve o trabalhador alugado e os dias que sobraram', async () => {
    const { w, owner, renter } = await rented();
    await w.market.endRentals(renter);
    renter.game.reset(false);
    await w.market.deliver(renter.userId);
    expect(owner.game.workers.map((x) => x.name)).toContain('Cida');
    expect(renter.game.player.silver).toBe(100 + 300);
  });

  it('ao entrar, trabalhador alugado cujo aluguel acabou sai da fazenda', async () => {
    const { w, owner, renter, id } = await rented();
    await w.db.updateRental(id, 0, 'ended');
    await w.market.reconcile(renter);
    expect(renter.game.workers.find((x) => x.rental)).toBeUndefined();
    void owner;
  });

  it('o dono vê quem alugou e o locatário vê de quem alugou', async () => {
    const { w, owner, renter } = await rented();
    expect((await w.market.data(owner)).lent[0]).toMatchObject({ worker: 'Cida', other: 'locatario', daysLeft: 3, daysTotal: 3 });
    expect((await w.market.data(renter)).rented[0]).toMatchObject({ worker: 'Cida', other: 'dono', daysLeft: 3 });
  });
});
