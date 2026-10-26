import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const SCRYPT = { N: 16384, r: 8, p: 1 };

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Senha nunca é guardada: só um resumo com sal, difícil de reverter (scrypt). Formato: scrypt$sal$resumo. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return 'scrypt$' + salt.toString('base64') + '$' + key.toString('base64');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, saltB64, keyB64] = stored.split('$');
  if (kind !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await derive(password, Buffer.from(saltB64, 'base64'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Um resumo falso, para gastar o mesmo tempo quando o usuário não existe (não revela quais nomes existem). */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword('senha-que-ninguem-usa');
  return dummy;
}

export const SESSION_DAYS = 30;

/** O navegador guarda o token; o banco guarda só o resumo dele. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('hex');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Sem 0/O, 1/I/L e U: o código é digitado à mão. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** Código de recuperação: 16 caracteres sorteados (uns 78 bits), em quatro grupos, como XXXX-XXXX-XXXX-XXXX. */
export function newRecoveryCode(): string {
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
  }
  return out;
}

/** Aceita minúsculas, espaços e traços a mais; devolve null se não parece um código. */
export function normalizeRecovery(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.length === 16 ? clean : null;
}

/** O banco guarda só o resumo do código (ele já é aleatório e longo, então o resumo simples basta). */
export function hashRecovery(normalized: string): string {
  return createHash('sha256').update('recuperar:' + normalized).digest('hex');
}

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

export function validUsername(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9_]{3,20}$/.test(name);
}

export function validPassword(pw: unknown): pw is string {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 128;
}

/** Limite de tentativas por janela de tempo (por endereço), para segurar quem tenta senhas em sequência. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly max: number, private readonly windowMs: number) {}

  allow(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    }
    return true;
  }
}
