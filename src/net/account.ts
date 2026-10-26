const TOKEN_KEY = 'fazenda-infinita:token';

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* sem armazenamento: a pessoa terá de entrar de novo na próxima vez */
  }
}

export interface AuthResult {
  ok: boolean;
  token?: string;
  user?: string;
  /** Código de recuperação novo (só vem ao criar a conta ou recuperar a senha). */
  recovery?: string;
  error?: string;
}

async function call(path: string, body: unknown, token?: string): Promise<AuthResult> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { token?: string; user?: string; recovery?: string; error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? 'Não foi possível entrar.' };
    return { ok: true, token: data.token, user: data.user, recovery: data.recovery };
  } catch {
    return { ok: false, error: 'Não consegui falar com o servidor. Ele está rodando?' };
  }
}

export const register = (username: string, password: string) => call('/api/register', { username, password });
export const login = (username: string, password: string) => call('/api/login', { username, password });
export const logout = (token: string) => call('/api/logout', {}, token);
export const recover = (username: string, code: string, password: string) => call('/api/recover', { username, code, password });
/** Gera um código de recuperação novo para a conta que está logada (pede a senha de novo). */
export const newRecoveryCode = (token: string, password: string) => call('/api/recovery-code', { password }, token);
