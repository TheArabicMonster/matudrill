import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3230',
      '/crops': 'http://127.0.0.1:3230',
      '/crops-override': 'http://127.0.0.1:3230',
      '/pdf-pages': 'http://127.0.0.1:3230',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
