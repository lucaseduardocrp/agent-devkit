import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/auth': 'http://localhost:3000',
      '/integrations': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
      '/TestPlan': 'http://localhost:3000',
      '/agents': 'http://localhost:3000',
      '/workspaces': 'http://localhost:3000',
    },
  },
});
