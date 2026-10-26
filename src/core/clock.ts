/** Tempo do jogo em minutos desde 00:00. O dia do jogador vai das 06:00 às 02:00 (26:00). */
export const DAY_START = 360;
export const AUTO_WAKE = 420;
export const AUTO_SLEEP = 1080;
export const FAINT_AT = 1560;
export const WORK_START = 480;
export const WORK_END = 1020;

/** Uma hora de jogo dura 45 segundos reais. */
export const MIN_PER_SEC = 60 / 45;

export function hhmm(minutes: number): string {
  const t = Math.floor(minutes) % 1440;
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}
