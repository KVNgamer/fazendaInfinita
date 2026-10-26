import pg from 'pg';
import { openDb } from './db';
import type { Db } from './db';
import { openPg } from './pgdb';

/**
 * Banco dos testes. Por padrão é SQLite na memória; com TEST_DATABASE_URL (um PostgreSQL de teste, que será
 * esvaziado!) os mesmos testes rodam no PostgreSQL. Nesse caso use `--no-file-parallelism`.
 */
export async function testDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return openDb(':memory:');
  const db = await openPg(url);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('TRUNCATE users, sessions, saves, listings, mail, rentals, sales, friendships, friend_perms, blocks RESTART IDENTITY CASCADE');
  } finally {
    await client.end();
  }
  return db;
}
