import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { Currency, ListingKind } from '../core/market';
import type { Permission } from '../core/social';

// carregado por require: as ferramentas de teste do Vite ainda não conhecem o módulo node:sqlite
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface UserRow {
  id: number;
  username: string;
  passHash: string;
  /** Resumo do código de recuperação (null: a conta ainda não tem um). */
  recoveryHash: string | null;
}

export type ListingStatus = 'open' | 'sold' | 'cancelled' | 'expired';

export interface ListingRow {
  id: number;
  sellerId: number;
  sellerName: string;
  kind: ListingKind;
  key: string;
  qty: number;
  /** Conteúdo guardado em JSON (para trabalhador: a ficha). */
  payload: string;
  currency: Currency;
  price: number;
  status: ListingStatus;
  createdAt: number;
  expiresAt: number;
  buyerId: number | null;
  soldAt: number | null;
  /** Anúncio privado: só essa pessoa vê e pode aceitar (empréstimo a amigo). */
  targetId: number | null;
  targetName: string | null;
}

export type NewListing = Omit<ListingRow, 'id' | 'status' | 'buyerId' | 'soldAt'>;

export interface MailRow {
  id: number;
  userId: number;
  kind: string;
  payload: string;
  createdAt: number;
}

export type RentalStatus = 'active' | 'ended' | 'recalled';

export interface RentalRow {
  /** Igual ao id do anúncio que gerou o aluguel. */
  id: number;
  ownerId: number;
  ownerName: string;
  renterId: number;
  renterName: string;
  workerName: string;
  payload: string;
  pricePerDay: number;
  currency: Currency;
  daysTotal: number;
  daysLeft: number;
  status: RentalStatus;
  createdAt: number;
}

export type FriendStatus = 'pending' | 'accepted';

export interface FriendRow {
  otherId: number;
  otherName: string;
  status: FriendStatus;
  /** Quem pediu a amizade. */
  requestedBy: number;
}

export interface SaleRow {
  qty: number;
  total: number;
}

/**
 * Tudo que o servidor guarda. Tem duas implementações com o mesmo SQL: um arquivo SQLite
 * (não precisa instalar nada) e o PostgreSQL (`openPg`). Todas as chamadas são assíncronas.
 */
export interface Db {
  /**
   * Roda tudo ou nada: se `fn` lançar erro, nada do que ela gravou fica. Dentro dela, use o `tx` recebido
   * (no PostgreSQL ele é outra conexão). Não pode ser aninhada.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;

  /** Devolve o id, ou null se o nome já existe (sem diferenciar maiúsculas). */
  createUser(username: string, passHash: string, recoveryHash?: string | null): Promise<number | null>;
  findUser(username: string): Promise<UserRow | null>;
  findUserById(id: number): Promise<UserRow | null>;
  /** Troca a senha e o código de recuperação de uma conta. */
  resetCredentials(userId: number, passHash: string, recoveryHash: string): Promise<void>;
  setRecovery(userId: number, recoveryHash: string): Promise<void>;
  createSession(userId: number, tokenHash: string, expiresAt: number): Promise<void>;
  findSession(tokenHash: string, now: number): Promise<{ userId: number; username: string } | null>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteSessionsOf(userId: number): Promise<void>;
  purgeSessions(now: number): Promise<void>;
  loadSave(userId: number): Promise<string | null>;
  writeSave(userId: number, json: string, now: number): Promise<void>;

  insertListing(l: NewListing): Promise<number>;
  getListing(id: number): Promise<ListingRow | null>;
  /** Muda o estado de um anúncio que ainda está aberto. Devolve false se já não estava (alguém chegou antes). */
  closeListing(id: number, status: Exclude<ListingStatus, 'open'>, buyerId: number | null, now: number): Promise<boolean>;
  /** Anúncios abertos que `viewerId` pode ver (os públicos, os privados para ele e os dele). */
  openListings(kind: ListingKind | null, now: number, limit: number, viewerId: number): Promise<ListingRow[]>;
  userListings(userId: number, limit: number): Promise<ListingRow[]>;
  countOpen(userId: number, now: number): Promise<number>;
  expiredOpen(now: number): Promise<ListingRow[]>;

  insertMail(userId: number, kind: string, payload: unknown, now: number): Promise<number>;
  pendingMail(userId: number): Promise<MailRow[]>;
  deleteMail(id: number): Promise<void>;

  insertRental(r: Omit<RentalRow, 'status'>): Promise<void>;
  getRental(id: number): Promise<RentalRow | null>;
  updateRental(id: number, daysLeft: number, status: RentalStatus): Promise<void>;
  rentalsByOwner(userId: number): Promise<RentalRow[]>;
  rentalsByRenter(userId: number): Promise<RentalRow[]>;

  getFriendship(a: number, b: number): Promise<{ status: FriendStatus; requestedBy: number } | null>;
  insertFriendRequest(from: number, to: number, now: number): Promise<void>;
  acceptFriendship(a: number, b: number): Promise<void>;
  /** Apaga a amizade (ou o pedido) e as permissões dos dois lados. */
  deleteFriendship(a: number, b: number): Promise<void>;
  friendsOf(userId: number): Promise<FriendRow[]>;
  setPermission(owner: number, friend: number, level: Permission): Promise<void>;
  getPermission(owner: number, friend: number): Promise<Permission>;
  /** Permissões que `owner` deu, por id do amigo. */
  permissionsBy(owner: number): Promise<Map<number, Permission>>;
  block(blocker: number, blocked: number): Promise<void>;
  unblock(blocker: number, blocked: number): Promise<void>;
  isBlocked(blocker: number, blocked: number): Promise<boolean>;
  blockedBy(blocker: number): Promise<Array<{ id: number; name: string }>>;

  insertSale(key: string, qty: number, total: number, currency: Currency, now: number): Promise<void>;
  recentSales(key: string, currency: Currency, limit: number): Promise<SaleRow[]>;

  close(): Promise<void>;
}

// ---------- o mesmo SQL para os dois bancos ----------

export type Row = Record<string, unknown>;

/** O que cada banco precisa saber fazer; o SQL usa `?` e o adaptador troca pelo que o banco quer. */
export interface Exec {
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  /** Roda e devolve quantas linhas mudaram. */
  run(sql: string, params?: unknown[]): Promise<number>;
  isUnique(e: unknown): boolean;
  /** Roda `fn` com uma conexão só e tudo ou nada. */
  transaction<T>(fn: (tx: Exec) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const tableSql = (pk: string, big: string) => `
  CREATE TABLE IF NOT EXISTS users (
    id ${pk},
    username TEXT NOT NULL,
    username_lower TEXT NOT NULL UNIQUE,
    pass_hash TEXT NOT NULL,
    recovery_hash TEXT,
    created_at ${big} NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id ${big} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at ${big} NOT NULL
  );
  CREATE TABLE IF NOT EXISTS saves (
    user_id ${big} PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    updated_at ${big} NOT NULL
  );
  CREATE TABLE IF NOT EXISTS listings (
    id ${pk},
    seller_id ${big} NOT NULL REFERENCES users(id),
    seller_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    qty ${big} NOT NULL,
    payload TEXT NOT NULL,
    currency TEXT NOT NULL,
    price ${big} NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at ${big} NOT NULL,
    expires_at ${big} NOT NULL,
    buyer_id ${big},
    sold_at ${big},
    target_id ${big},
    target_name TEXT
  );
  CREATE INDEX IF NOT EXISTS listings_open ON listings(status, kind, id);
  CREATE INDEX IF NOT EXISTS listings_seller ON listings(seller_id, status);
  CREATE TABLE IF NOT EXISTS mail (
    id ${pk},
    user_id ${big} NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at ${big} NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mail_user ON mail(user_id, id);
  CREATE TABLE IF NOT EXISTS rentals (
    id ${big} PRIMARY KEY,
    owner_id ${big} NOT NULL REFERENCES users(id),
    owner_name TEXT NOT NULL,
    renter_id ${big} NOT NULL REFERENCES users(id),
    renter_name TEXT NOT NULL,
    worker_name TEXT NOT NULL,
    payload TEXT NOT NULL,
    price_per_day ${big} NOT NULL,
    currency TEXT NOT NULL,
    days_total ${big} NOT NULL,
    days_left ${big} NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at ${big} NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rentals_owner ON rentals(owner_id, status);
  CREATE INDEX IF NOT EXISTS rentals_renter ON rentals(renter_id, status);
  CREATE TABLE IF NOT EXISTS sales (
    id ${pk},
    key TEXT NOT NULL,
    qty ${big} NOT NULL,
    total ${big} NOT NULL,
    currency TEXT NOT NULL,
    sold_at ${big} NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sales_key ON sales(key, currency, id);
  CREATE TABLE IF NOT EXISTS friendships (
    user_a ${big} NOT NULL REFERENCES users(id),
    user_b ${big} NOT NULL REFERENCES users(id),
    requested_by ${big} NOT NULL,
    status TEXT NOT NULL,
    created_at ${big} NOT NULL,
    PRIMARY KEY (user_a, user_b)
  );
  CREATE INDEX IF NOT EXISTS friendships_b ON friendships(user_b);
  CREATE TABLE IF NOT EXISTS friend_perms (
    owner_id ${big} NOT NULL REFERENCES users(id),
    friend_id ${big} NOT NULL REFERENCES users(id),
    level INTEGER NOT NULL,
    PRIMARY KEY (owner_id, friend_id)
  );
  CREATE TABLE IF NOT EXISTS blocks (
    blocker_id ${big} NOT NULL REFERENCES users(id),
    blocked_id ${big} NOT NULL REFERENCES users(id),
    PRIMARY KEY (blocker_id, blocked_id)
  );
`;

export const SQLITE_SCHEMA = tableSql('INTEGER PRIMARY KEY AUTOINCREMENT', 'INTEGER');
export const PG_SCHEMA = tableSql('BIGSERIAL PRIMARY KEY', 'BIGINT');

const listing = (r: Row): ListingRow => ({
  id: Number(r.id),
  sellerId: Number(r.seller_id),
  sellerName: String(r.seller_name),
  kind: r.kind as ListingKind,
  key: String(r.key),
  qty: Number(r.qty),
  payload: String(r.payload),
  currency: r.currency as Currency,
  price: Number(r.price),
  status: r.status as ListingStatus,
  createdAt: Number(r.created_at),
  expiresAt: Number(r.expires_at),
  buyerId: r.buyer_id === null ? null : Number(r.buyer_id),
  soldAt: r.sold_at === null ? null : Number(r.sold_at),
  targetId: r.target_id === null || r.target_id === undefined ? null : Number(r.target_id),
  targetName: r.target_name === null || r.target_name === undefined ? null : String(r.target_name),
});

const rental = (r: Row): RentalRow => ({
  id: Number(r.id),
  ownerId: Number(r.owner_id),
  ownerName: String(r.owner_name),
  renterId: Number(r.renter_id),
  renterName: String(r.renter_name),
  workerName: String(r.worker_name),
  payload: String(r.payload),
  pricePerDay: Number(r.price_per_day),
  currency: r.currency as Currency,
  daysTotal: Number(r.days_total),
  daysLeft: Number(r.days_left),
  status: r.status as RentalStatus,
  createdAt: Number(r.created_at),
});

const user = (r: Row): UserRow => ({
  id: Number(r.id),
  username: String(r.username),
  passHash: String(r.pass_hash),
  recoveryHash: r.recovery_hash === null || r.recovery_hash === undefined ? null : String(r.recovery_hash),
});

const pair = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);
const VISIBLE = '(target_id IS NULL OR target_id = ? OR seller_id = ?)';

/** Todas as consultas do jogo, escritas uma vez só para SQLite e PostgreSQL. */
export class SqlDb implements Db {
  constructor(private readonly x: Exec) {}

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.x.transaction((tx) => fn(new SqlDb(tx)));
  }

  async createUser(username: string, passHash: string, recoveryHash: string | null = null): Promise<number | null> {
    try {
      const rows = await this.x.all(
        'INSERT INTO users (username, username_lower, pass_hash, recovery_hash, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
        [username, username.toLowerCase(), passHash, recoveryHash, Date.now()],
      );
      return Number(rows[0].id);
    } catch (e) {
      if (this.x.isUnique(e)) return null;
      throw e;
    }
  }

  async findUser(username: string): Promise<UserRow | null> {
    const r = (await this.x.all('SELECT id, username, pass_hash, recovery_hash FROM users WHERE username_lower = ?', [username.toLowerCase()]))[0];
    return r ? user(r) : null;
  }

  async findUserById(id: number): Promise<UserRow | null> {
    const r = (await this.x.all('SELECT id, username, pass_hash, recovery_hash FROM users WHERE id = ?', [id]))[0];
    return r ? user(r) : null;
  }

  async resetCredentials(userId: number, passHash: string, recoveryHash: string): Promise<void> {
    await this.x.run('UPDATE users SET pass_hash = ?, recovery_hash = ? WHERE id = ?', [passHash, recoveryHash, userId]);
  }

  async setRecovery(userId: number, recoveryHash: string): Promise<void> {
    await this.x.run('UPDATE users SET recovery_hash = ? WHERE id = ?', [recoveryHash, userId]);
  }

  async createSession(userId: number, tokenHash: string, expiresAt: number): Promise<void> {
    await this.x.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [tokenHash, userId, expiresAt]);
  }

  async findSession(tokenHash: string, now: number): Promise<{ userId: number; username: string } | null> {
    const r = (await this.x.all(
      'SELECT s.user_id AS user_id, u.username AS username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
      [tokenHash, now],
    ))[0];
    return r ? { userId: Number(r.user_id), username: String(r.username) } : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.x.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
  }

  async deleteSessionsOf(userId: number): Promise<void> {
    await this.x.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }

  async purgeSessions(now: number): Promise<void> {
    await this.x.run('DELETE FROM sessions WHERE expires_at <= ?', [now]);
  }

  async loadSave(userId: number): Promise<string | null> {
    const r = (await this.x.all('SELECT data FROM saves WHERE user_id = ?', [userId]))[0];
    return r ? String(r.data) : null;
  }

  async writeSave(userId: number, json: string, now: number): Promise<void> {
    await this.x.run(
      // o WHERE garante que um salvamento lento e antigo não escreva por cima de um mais novo que chegou antes
      'INSERT INTO saves (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at WHERE saves.updated_at <= excluded.updated_at',
      [userId, json, now],
    );
  }

  async insertListing(l: NewListing): Promise<number> {
    const rows = await this.x.all(
      'INSERT INTO listings (seller_id, seller_name, kind, key, qty, payload, currency, price, created_at, expires_at, target_id, target_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [l.sellerId, l.sellerName, l.kind, l.key, l.qty, l.payload, l.currency, l.price, l.createdAt, l.expiresAt, l.targetId, l.targetName],
    );
    return Number(rows[0].id);
  }

  async getListing(id: number): Promise<ListingRow | null> {
    const r = (await this.x.all('SELECT * FROM listings WHERE id = ?', [id]))[0];
    return r ? listing(r) : null;
  }

  async closeListing(id: number, status: Exclude<ListingStatus, 'open'>, buyerId: number | null, now: number): Promise<boolean> {
    return (await this.x.run("UPDATE listings SET status = ?, buyer_id = ?, sold_at = ? WHERE id = ? AND status = 'open'", [status, buyerId, now, id])) === 1;
  }

  async openListings(kind: ListingKind | null, now: number, limit: number, viewerId: number): Promise<ListingRow[]> {
    const rows = kind
      ? await this.x.all(`SELECT * FROM listings WHERE status = 'open' AND expires_at > ? AND kind = ? AND ${VISIBLE} ORDER BY id DESC LIMIT ?`, [now, kind, viewerId, viewerId, limit])
      : await this.x.all(`SELECT * FROM listings WHERE status = 'open' AND expires_at > ? AND ${VISIBLE} ORDER BY id DESC LIMIT ?`, [now, viewerId, viewerId, limit]);
    return rows.map(listing);
  }

  async userListings(userId: number, limit: number): Promise<ListingRow[]> {
    return (await this.x.all('SELECT * FROM listings WHERE seller_id = ? ORDER BY id DESC LIMIT ?', [userId, limit])).map(listing);
  }

  async countOpen(userId: number, now: number): Promise<number> {
    const r = await this.x.all("SELECT COUNT(*) AS n FROM listings WHERE seller_id = ? AND status = 'open' AND expires_at > ?", [userId, now]);
    return Number(r[0].n);
  }

  async expiredOpen(now: number): Promise<ListingRow[]> {
    return (await this.x.all("SELECT * FROM listings WHERE status = 'open' AND expires_at <= ?", [now])).map(listing);
  }

  async insertMail(userId: number, kind: string, payload: unknown, now: number): Promise<number> {
    const rows = await this.x.all('INSERT INTO mail (user_id, kind, payload, created_at) VALUES (?, ?, ?, ?) RETURNING id', [userId, kind, JSON.stringify(payload), now]);
    return Number(rows[0].id);
  }

  async pendingMail(userId: number): Promise<MailRow[]> {
    return (await this.x.all('SELECT * FROM mail WHERE user_id = ? ORDER BY id', [userId])).map((r) => ({
      id: Number(r.id), userId: Number(r.user_id), kind: String(r.kind), payload: String(r.payload), createdAt: Number(r.created_at),
    }));
  }

  async deleteMail(id: number): Promise<void> {
    await this.x.run('DELETE FROM mail WHERE id = ?', [id]);
  }

  async insertRental(r: Omit<RentalRow, 'status'>): Promise<void> {
    await this.x.run(
      'INSERT INTO rentals (id, owner_id, owner_name, renter_id, renter_name, worker_name, payload, price_per_day, currency, days_total, days_left, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [r.id, r.ownerId, r.ownerName, r.renterId, r.renterName, r.workerName, r.payload, r.pricePerDay, r.currency, r.daysTotal, r.daysLeft, r.createdAt],
    );
  }

  async getRental(id: number): Promise<RentalRow | null> {
    const r = (await this.x.all('SELECT * FROM rentals WHERE id = ?', [id]))[0];
    return r ? rental(r) : null;
  }

  async updateRental(id: number, daysLeft: number, status: RentalStatus): Promise<void> {
    await this.x.run('UPDATE rentals SET days_left = ?, status = ? WHERE id = ?', [daysLeft, status, id]);
  }

  async rentalsByOwner(userId: number): Promise<RentalRow[]> {
    return (await this.x.all("SELECT * FROM rentals WHERE owner_id = ? AND status = 'active' ORDER BY id", [userId])).map(rental);
  }

  async rentalsByRenter(userId: number): Promise<RentalRow[]> {
    return (await this.x.all("SELECT * FROM rentals WHERE renter_id = ? AND status = 'active' ORDER BY id", [userId])).map(rental);
  }

  async getFriendship(a: number, b: number): Promise<{ status: FriendStatus; requestedBy: number } | null> {
    const [x, y] = pair(a, b);
    const r = (await this.x.all('SELECT status, requested_by FROM friendships WHERE user_a = ? AND user_b = ?', [x, y]))[0];
    return r ? { status: r.status as FriendStatus, requestedBy: Number(r.requested_by) } : null;
  }

  async insertFriendRequest(from: number, to: number, now: number): Promise<void> {
    const [x, y] = pair(from, to);
    await this.x.run("INSERT INTO friendships (user_a, user_b, requested_by, status, created_at) VALUES (?, ?, ?, 'pending', ?)", [x, y, from, now]);
  }

  async acceptFriendship(a: number, b: number): Promise<void> {
    const [x, y] = pair(a, b);
    await this.x.run("UPDATE friendships SET status = 'accepted' WHERE user_a = ? AND user_b = ?", [x, y]);
  }

  async deleteFriendship(a: number, b: number): Promise<void> {
    const [x, y] = pair(a, b);
    await this.x.run('DELETE FROM friendships WHERE user_a = ? AND user_b = ?', [x, y]);
    await this.x.run('DELETE FROM friend_perms WHERE (owner_id = ? AND friend_id = ?) OR (owner_id = ? AND friend_id = ?)', [a, b, b, a]);
  }

  async friendsOf(userId: number): Promise<FriendRow[]> {
    const rows = await this.x.all(
      'SELECT f.status AS status, f.requested_by AS requested_by, u.id AS other_id, u.username AS other_name FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END WHERE f.user_a = ? OR f.user_b = ? ORDER BY u.username_lower',
      [userId, userId, userId],
    );
    return rows.map((r) => ({ otherId: Number(r.other_id), otherName: String(r.other_name), status: r.status as FriendStatus, requestedBy: Number(r.requested_by) }));
  }

  async setPermission(owner: number, friend: number, level: Permission): Promise<void> {
    await this.x.run('INSERT INTO friend_perms (owner_id, friend_id, level) VALUES (?, ?, ?) ON CONFLICT(owner_id, friend_id) DO UPDATE SET level = excluded.level', [owner, friend, level]);
  }

  async getPermission(owner: number, friend: number): Promise<Permission> {
    const r = (await this.x.all('SELECT level FROM friend_perms WHERE owner_id = ? AND friend_id = ?', [owner, friend]))[0];
    return (r ? Number(r.level) : 0) as Permission;
  }

  async permissionsBy(owner: number): Promise<Map<number, Permission>> {
    const m = new Map<number, Permission>();
    for (const r of await this.x.all('SELECT friend_id, level FROM friend_perms WHERE owner_id = ?', [owner])) m.set(Number(r.friend_id), Number(r.level) as Permission);
    return m;
  }

  async block(blocker: number, blocked: number): Promise<void> {
    await this.x.run('INSERT INTO blocks (blocker_id, blocked_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [blocker, blocked]);
  }

  async unblock(blocker: number, blocked: number): Promise<void> {
    await this.x.run('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [blocker, blocked]);
  }

  async isBlocked(blocker: number, blocked: number): Promise<boolean> {
    return (await this.x.all('SELECT 1 AS x FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [blocker, blocked])).length > 0;
  }

  async blockedBy(blocker: number): Promise<Array<{ id: number; name: string }>> {
    const rows = await this.x.all('SELECT u.id AS id, u.username AS name FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY u.username_lower', [blocker]);
    return rows.map((r) => ({ id: Number(r.id), name: String(r.name) }));
  }

  async insertSale(key: string, qty: number, total: number, currency: Currency, now: number): Promise<void> {
    await this.x.run('INSERT INTO sales (key, qty, total, currency, sold_at) VALUES (?, ?, ?, ?, ?)', [key, qty, total, currency, now]);
  }

  async recentSales(key: string, currency: Currency, limit: number): Promise<SaleRow[]> {
    return (await this.x.all('SELECT qty, total FROM sales WHERE key = ? AND currency = ? ORDER BY id DESC LIMIT ?', [key, currency, limit])).map((r) => ({ qty: Number(r.qty), total: Number(r.total) }));
  }

  close(): Promise<void> {
    return this.x.close();
  }
}

// ---------- SQLite ----------

type Stmt = ReturnType<InstanceType<typeof DatabaseSync>['prepare']>;
type SqliteValue = string | number | bigint | null | Uint8Array;

class SqliteExec implements Exec {
  private readonly cache = new Map<string, Stmt>();

  constructor(private readonly db: InstanceType<typeof DatabaseSync>) {}

  private stmt(sql: string): Stmt {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  async all(sql: string, params: unknown[] = []): Promise<Row[]> {
    return this.stmt(sql).all(...(params as SqliteValue[])) as Row[];
  }

  async run(sql: string, params: unknown[] = []): Promise<number> {
    return Number(this.stmt(sql).run(...(params as SqliteValue[])).changes);
  }

  isUnique(e: unknown): boolean {
    return String((e as Error).message).includes('UNIQUE');
  }

  // uma conexão só: como o SQLite é síncrono, ninguém entra no meio da transação (as esperas aqui já estão resolvidas)
  async transaction<T>(fn: (tx: Exec) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** Abre (ou cria) o arquivo SQLite. É síncrono para facilitar os testes (`:memory:`). */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SQLITE_SCHEMA);
  // bancos criados antes de uma coluna nova ganham a coluna
  const has = (table: string, column: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
  if (!has('listings', 'target_id')) db.exec('ALTER TABLE listings ADD COLUMN target_id INTEGER');
  if (!has('listings', 'target_name')) db.exec('ALTER TABLE listings ADD COLUMN target_name TEXT');
  if (!has('users', 'recovery_hash')) db.exec('ALTER TABLE users ADD COLUMN recovery_hash TEXT');
  return new SqlDb(new SqliteExec(db));
}
