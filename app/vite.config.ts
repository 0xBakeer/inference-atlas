import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          lit: ['lit'],
          uplot: ['uplot'],
        },
      },
    },
  },
  server: { port: 5173, strictPort: false },
});
