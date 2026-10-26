import pg from 'pg';
import { PG_SCHEMA, SqlDb } from './db';
import type { Db, Exec, Row } from './db';

/** O SQL do jogo usa `?`; o PostgreSQL quer `$1`, `$2`... */
function numbered(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => '$' + ++n);
}

const TABLES = ['users', 'sessions', 'saves', 'listings', 'mail', 'rentals', 'sales', 'friendships', 'friend_perms', 'blocks'];

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

class PgExec implements Exec {
  constructor(
    private readonly q: Queryable,
    private readonly pool: pg.Pool,
    private readonly inTransaction: boolean,
  ) {}

  async all(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.q.query(numbered(sql), params)).rows as Row[];
  }

  async run(sql: string, params: unknown[] = []): Promise<number> {
    return (await this.q.query(numbered(sql), params)).rowCount ?? 0;
  }

  isUnique(e: unknown): boolean {
    return (e as { code?: string }).code === '23505';
  }

  async transaction<T>(fn: (tx: Exec) => Promise<T>): Promise<T> {
    if (this.inTransaction) throw new Error('transação dentro de transação');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PgExec(client, this.pool, true));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // a conexão já caiu: o servidor desfaz sozinho
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Conecta ao PostgreSQL (`postgres://usuario:senha@servidor:5432/banco`) e cria as tabelas que faltarem.
 */
export async function openPg(url: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // uma conexão ociosa que cai não pode derrubar o servidor
  pool.on('error', (e) => console.error('Erro numa conexão ociosa do PostgreSQL:', e.message));
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    await pool.end();
    throw e;
  }
  const exec = new PgExec(pool, pool, false);
  // vários servidores subindo juntos não podem criar as tabelas ao mesmo tempo
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7081945)');
    await client.query(PG_SCHEMA);
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_hash TEXT');
    await client.query('ALTER TABLE listings ADD COLUMN IF NOT EXISTS target_id BIGINT');
    await client.query('ALTER TABLE listings ADD COLUMN IF NOT EXISTS target_name TEXT');
    // no Supabase as tabelas ficam expostas por uma API pública; com a segurança por linha ligada e sem política
    // nenhuma, só a conexão direta (a do jogo) enxerga os dados. Em um PostgreSQL comum não muda nada.
    for (const table of TABLES) await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  } finally {
    await client.query('SELECT pg_advisory_unlock(7081945)').catch(() => {});
    client.release();
  }
  return new SqlDb(exec);
}
