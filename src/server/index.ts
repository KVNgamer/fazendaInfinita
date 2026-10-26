import { join } from 'node:path';
import { createApp } from './app';
import { openDb } from './db';
import type { Db } from './db';
import { openPg } from './pgdb';

/**
 * Configuração por variáveis de ambiente (ou pelo arquivo .env): PORT, HOST, ALLOWED_ORIGINS (separadas por vírgula),
 * DATABASE_URL (PostgreSQL; sem ela, usa o arquivo SQLite de DB_PATH),
 * CLIENT_IP_HEADER (atrás de proxy: cabeçalho com o IP real, como cf-connecting-ip).
 */
const port = Number(process.env.PORT) || 3001;
const host = process.env.HOST || '127.0.0.1';
const dbPath = process.env.DB_PATH || join('data', 'fazenda.sqlite');
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const databaseUrl = process.env.DATABASE_URL;
const db: Db = databaseUrl ? await openPg(databaseUrl) : openDb(dbPath);
// no log, o banco sem a senha
const dbName = databaseUrl ? 'PostgreSQL ' + new URL(databaseUrl).host + new URL(databaseUrl).pathname : dbPath;
const app = await createApp({
  db,
  port,
  host,
  staticDir: join(process.cwd(), 'dist'),
  allowedOrigins,
  clientIpHeader: process.env.CLIENT_IP_HEADER || undefined,
  log: (t) => console.log(new Date().toLocaleTimeString('pt-BR') + ' ' + t),
});
console.log('Servidor da Fazenda Infinita em http://' + host + ':' + app.port + ' (banco: ' + dbName + ')');

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log('Salvando e encerrando...');
  await app.close();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
