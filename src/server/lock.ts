/**
 * Fila única das operações que mexem no banco e no jogo ao mesmo tempo (comandos, mercado, amigos, salvamentos).
 * O jogo de cada pessoa vive na memória e o banco é assíncrono: sem a fila, um passo do relógio poderia
 * mudar o jogo no meio de uma compra e a compra desfeita levaria o passo junto. Enquanto há algo na fila,
 * o relógio dos jogos espera (são milissegundos).
 */
export class Lock {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;

  /** Há operação rodando ou esperando. */
  get busy(): boolean {
    return this.waiting > 0;
  }

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    this.waiting++;
    const result = this.tail.then(async () => {
      try {
        return await fn();
      } finally {
        this.waiting--;
      }
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
