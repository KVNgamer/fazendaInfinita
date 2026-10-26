import { defineConfig } from 'vite';

// Em desenvolvimento o site roda no Vite e a API e o WebSocket no servidor do jogo (porta 3001).
export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3001',
      '/ws': { target: 'ws://127.0.0.1:3001', ws: true },
    },
  },
});
