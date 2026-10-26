import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import type { App } from './app';
import { openDb } from './db';

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('arquivos do site', () => {
  let root = '';
  let app: App | null = null;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'fazenda-'));
    mkdirSync(join(root, 'dist'));
    mkdirSync(join(root, 'dist-outra'));
    writeFileSync(join(root, 'dist', 'index.html'), '<h1>jogo</h1>');
    writeFileSync(join(root, 'dist', 'a.js'), 'console.log(1)');
    writeFileSync(join(root, 'dist-outra', 'segredo.txt'), 'SEGREDO');
    writeFileSync(join(root, 'segredo.txt'), 'SEGREDO');
    app = await createApp({ db: openDb(':memory:'), port: 0, staticDir: join(root, 'dist') });
  });

  afterEach(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serve a página e os arquivos', async () => {
    expect((await get(app!.port, '/')).body).toContain('jogo');
    const js = await get(app!.port, '/a.js');
    expect(js.status).toBe(200);
    expect(js.body).toContain('console.log');
  });

  it('endereço desconhecido volta para a página do jogo', async () => {
    expect((await get(app!.port, '/qualquer/coisa')).body).toContain('jogo');
  });

  it('não entrega arquivos de fora da pasta do site', async () => {
    for (const p of ['/..%2fsegredo.txt', '/..%2f..%2fsegredo.txt', '/..%2fdist-outra%2fsegredo.txt', '/%2e%2e/segredo.txt', '/..%5csegredo.txt', '/....//segredo.txt']) {
      const r = await get(app!.port, p);
      expect(r.body).not.toContain('SEGREDO');
    }
  });

  it('endereço malformado não derruba o servidor', async () => {
    expect((await get(app!.port, '/%E0%A4%A')).status).toBe(400);
    expect((await get(app!.port, '/%00')).status).toBeLessThan(500);
    expect((await get(app!.port, '/api/health')).status).toBe(200);
  });
});
