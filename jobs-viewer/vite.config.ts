import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5031,
    proxy: {
      '/decensor': {
        target: 'http://localhost:5030',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
