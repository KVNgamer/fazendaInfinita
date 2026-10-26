import { login, recover, register, setToken } from '../net/account';
import type { AuthResult } from '../net/account';

function $(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error('Elemento #' + id + ' não encontrado');
  return e;
}

/** Tela de entrada (entrar, criar conta, recuperar a senha) e aviso de conexão. */
export class Gate {
  private mode: 'login' | 'register' | 'recover' = 'login';
  private busy = false;

  constructor(private readonly onAuth: (token: string, user: string) => void) {
    $('tabLogin').addEventListener('click', () => this.setMode('login'));
    $('tabRegister').addEventListener('click', () => this.setMode('register'));
    $('tabRecover').addEventListener('click', () => this.setMode('recover'));
    $('authForm').addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit();
    });
  }

  get authVisible(): boolean {
    return !$('auth').hidden;
  }

  private setMode(m: 'login' | 'register' | 'recover'): void {
    this.mode = m;
    $('tabLogin').setAttribute('aria-pressed', String(m === 'login'));
    $('tabRegister').setAttribute('aria-pressed', String(m === 'register'));
    $('tabRecover').setAttribute('aria-pressed', String(m === 'recover'));
    $('authSubmit').textContent = m === 'login' ? 'Entrar' : m === 'register' ? 'Criar conta e entrar' : 'Trocar a senha e entrar';
    ($('authPass') as HTMLInputElement).autocomplete = m === 'login' ? 'current-password' : 'new-password';
    $('authPassLabel').textContent = m === 'recover' ? 'Senha nova' : 'Senha';
    $('authCode').hidden = m !== 'recover';
    $('authCodeLabel').hidden = m !== 'recover';
    $('authHint').hidden = m !== 'register';
    $('recoverHint').hidden = m !== 'recover';
    $('authError').textContent = '';
  }

  showAuth(message = ''): void {
    $('auth').hidden = false;
    $('authError').textContent = message;
    $('authUser').focus();
  }

  hideAuth(): void {
    $('auth').hidden = true;
    ($('authPass') as HTMLInputElement).value = '';
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const user = ($('authUser') as HTMLInputElement).value.trim();
    const pass = ($('authPass') as HTMLInputElement).value;
    this.busy = true;
    ($('authSubmit') as HTMLButtonElement).disabled = true;
    $('authError').textContent = '';
    const code = ($('authCode') as HTMLInputElement).value;
    const r: AuthResult = this.mode === 'login' ? await login(user, pass) : this.mode === 'register' ? await register(user, pass) : await recover(user, code, pass);
    this.busy = false;
    ($('authSubmit') as HTMLButtonElement).disabled = false;
    if (!r.ok || !r.token) {
      $('authError').textContent = r.error ?? 'Não foi possível entrar.';
      return;
    }
    const token = r.token;
    const enter = () => {
      setToken(token);
      this.onAuth(token, r.user ?? user);
    };
    // conta nova ou senha trocada: o código novo aparece uma vez, e só entra no jogo quando a pessoa confirma
    if (r.recovery) {
      this.hideAuth();
      this.showRecovery(r.recovery, enter);
    } else {
      enter();
    }
  }

  /** Mostra o código de recuperação (uma vez só) e espera a pessoa confirmar que anotou. */
  showRecovery(code: string, onDone: () => void): void {
    $('recoveryCode').textContent = code;
    $('recoveryBox').hidden = false;
    $('recoveryCopy').onclick = () => {
      void navigator.clipboard?.writeText(code).then(() => { $('recoveryCopy').textContent = 'Copiado'; }, () => {});
    };
    $('recoveryDone').onclick = () => {
      $('recoveryBox').hidden = true;
      $('recoveryCode').textContent = '';
      $('recoveryCopy').textContent = 'Copiar';
      onDone();
    };
  }

  showConn(text: string): void {
    const el = $('conn');
    el.textContent = text;
    el.hidden = false;
  }

  hideConn(): void {
    $('conn').hidden = true;
  }
}
