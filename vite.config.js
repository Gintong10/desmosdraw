import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  server: {
    port: 5173,
  },
  optimizeDeps: {
    exclude: ['@imgly/background-removal'],
  },
});
