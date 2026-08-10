import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
  },
  optimizeDeps: {
    exclude: ['@imgly/background-removal'],
  },
});
