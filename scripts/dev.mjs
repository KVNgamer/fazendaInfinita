// Sobe o servidor do jogo (recarrega ao editar) e o site (Vite) juntos. Ctrl-C encerra os dois.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const node = process.execPath;
const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));

const children = [
  spawn(node, ['--env-file-if-exists=.env', '--import', 'tsx', '--disable-warning=ExperimentalWarning', '--watch', 'src/server/index.ts'], { stdio: 'inherit' }),
  spawn(node, [vite], { stdio: 'inherit' }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGINT');
  setTimeout(() => process.exit(code), 800);
}
for (const c of children) c.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
