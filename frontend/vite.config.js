import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/llm': 'http://localhost:4000',
      '/api/markdown': 'http://localhost:4000',
      '/api/sessions': 'http://localhost:4000', // <-- Updated proxy for sessions
      '/api/prd': 'http://localhost:4000', // <-- Updated proxy for PRD endpoints
    },
  },
})
