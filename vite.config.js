import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Pages serves the site from /<repo>/, so assets need that prefix. Local
  // dev and preview stay at the root.
  base: process.env.GITHUB_ACTIONS ? '/agentguard/' : '/',
});
