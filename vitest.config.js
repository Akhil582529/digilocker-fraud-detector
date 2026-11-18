import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node', // frontend tests switch to jsdom with a "@vitest-environment jsdom" comment
    include: ['server/**/*.test.js', 'src/**/*.test.{js,jsx}'],
  },
})
