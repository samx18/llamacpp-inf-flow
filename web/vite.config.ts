import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tracerPlugin } from './vite-plugin-tracer';

export default defineConfig({
  plugins: [react(), tracerPlugin()],
  server: { port: 5173, strictPort: true },
});
