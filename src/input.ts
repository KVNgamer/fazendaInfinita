import type { MoveInput } from './core/player';

export interface InputHooks {
  use(): void;
  interact(): void;
  inventory(): void;
  workers(): void;
  character(): void;
  lands(): void;
  slot(i: number): void;
  toggleLegend(): void;
  closeModal(): void;
  modalOpen(): boolean;
  /** Sem login ou sem conexão: o jogo ignora teclado e mouse. */
  blocked(): boolean;
  spectating(): boolean;
  /** Olhar em primeira pessoa (radianos). */
  look(dyaw: number, dpitch: number): void;
  /** Girar a câmera do modo espectador (pixels arrastados). */
  orbit(dx: number, dy: number): void;
  /** Toque ou clique sem arrastar no modo espectador (para ajudar numa fazenda visitada). */
  tap(x: number, y: number): void;
  /** Ponteiro parado sobre a tela no modo espectador. */
  hover(x: number, y: number): void;
  friends(): void;
  /** Tab: abre ou fecha o menu. */
  menu(): void;
}

const KEYMAP: Record<string, keyof MoveInput> = {
  w: 'f', s: 'b', a: 'l', d: 'r',
  arrowup: 'f', arrowdown: 'b', arrowleft: 'tl', arrowright: 'tr',
};

/** Teclado e mouse. Clique na tela captura o mouse (some o cursor); Esc solta. */
export class Input {
  readonly move: MoveInput = { f: 0, b: 0, l: 0, r: 0, tl: 0, tr: 0 };
  locked = false;
  lockFailed = false;
  private drag: { x: number; y: number; moved: number } | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly hooks: InputHooks) {
    document.addEventListener('keydown', (e) => this.keyDown(e));
    document.addEventListener('keyup', (e) => {
      const m = KEYMAP[e.key.toLowerCase()];
      if (m) this.move[m] = 0;
    });
    window.addEventListener('blur', () => this.clearKeys());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.clearKeys();
    });
    document.addEventListener('pointerlockerror', () => {
      this.lockFailed = true;
    });
    document.addEventListener('mousemove', (e) => {
      if (this.locked && !hooks.blocked() && !hooks.spectating() && !hooks.modalOpen()) hooks.look(-e.movementX * 0.0025, -e.movementY * 0.0025);
    });
    document.addEventListener('mousedown', (e) => {
      if (this.locked && e.button === 0 && !hooks.blocked() && !hooks.spectating() && !hooks.modalOpen()) hooks.use();
    });
    canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.pointerUp(e));
    canvas.addEventListener('pointercancel', () => {
      this.drag = null;
    });
  }

  private clearKeys(): void {
    for (const k of Object.keys(this.move) as Array<keyof MoveInput>) this.move[k] = 0;
  }

  releasePointer(): void {
    if (document.pointerLockElement) document.exitPointerLock();
    this.clearKeys();
  }

  private keyDown(e: KeyboardEvent): void {
    // digitando num campo de texto (login): as teclas do jogo ficam quietas
    if ((e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') || e.target instanceof HTMLSelectElement) return;
    if (this.hooks.blocked()) return;
    const k = e.key.toLowerCase();
    const h = this.hooks;
    if (k === 'tab') {
      h.menu();
      e.preventDefault();
      return;
    }
    if (h.modalOpen()) {
      if (e.target instanceof HTMLInputElement && k === ' ') return;
      if (k === 'escape' || k === 'e' || k === 'i' || k === 't' || k === 'c' || k === 'l' || k === 'f') {
        h.closeModal();
        e.preventDefault();
      }
      return;
    }
    const m = KEYMAP[k];
    if (m) {
      if (!h.spectating()) this.move[m] = 1;
      e.preventDefault();
    } else if (k === ' ') {
      if (!h.spectating()) h.use();
      e.preventDefault();
    } else if (k === 'e') {
      h.interact();
      e.preventDefault();
    } else if (k === 'i') {
      h.inventory();
      e.preventDefault();
    } else if (k === 't') {
      h.workers();
      e.preventDefault();
    } else if (k === 'l') {
      h.lands();
      e.preventDefault();
    } else if (k === 'c') {
      h.character();
      e.preventDefault();
    } else if (k === 'f') {
      h.friends();
      e.preventDefault();
    } else if (k === 'h') {
      h.toggleLegend();
    } else if (k >= '1' && k <= '9') {
      if (!h.spectating()) h.slot(Number(k) - 1);
    }
  }

  private pointerDown(e: PointerEvent): void {
    if (this.hooks.modalOpen() || this.hooks.blocked()) return;
    if (!this.hooks.spectating() && !this.locked && !this.lockFailed) {
      try {
        const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        p?.catch?.(() => {
          this.lockFailed = true;
        });
      } catch {
        this.lockFailed = true;
      }
      return;
    }
    if (this.locked) return;
    this.drag = { x: e.clientX, y: e.clientY, moved: 0 };
    this.canvas.setPointerCapture(e.pointerId);
  }

  private pointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) {
      if (this.hooks.spectating() && !this.hooks.blocked() && !this.hooks.modalOpen()) this.hooks.hover(e.clientX, e.clientY);
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    d.moved += Math.abs(dx) + Math.abs(dy);
    if (this.hooks.spectating()) this.hooks.orbit(dx, dy);
    else this.hooks.look(-dx * 0.005, -dy * 0.005);
  }

  private pointerUp(e: PointerEvent): void {
    if (this.drag && this.drag.moved < 6 && !this.hooks.modalOpen()) {
      if (this.hooks.spectating()) this.hooks.tap(e.clientX, e.clientY);
      else this.hooks.use();
    }
    this.drag = null;
  }
}
