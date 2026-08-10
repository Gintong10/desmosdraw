import { defineConfig } from 'vite';

export default defineConfig({
  base: '/desmosdraw/',
  server: {
    port: 5173,
  },
  optimizeDeps: {
    exclude: ['@imgly/background-removal'],
  },
});
