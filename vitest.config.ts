import { defineConfig } from 'vitest/config'

// Workspace packages resolve to their TypeScript source, not their build. Tests run on the
// server side, whose conditions Vite takes from `ssr.resolve`; its defaults follow.
const conditions = ['@otwdesign/source', 'module', 'node', 'development|production']

export default defineConfig({
  // The CMS's packages are linked from a checkout and bring their own React; components need one.
  resolve: { conditions, dedupe: ['react', 'react-dom'] },
  ssr: { resolve: { conditions } },
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'examples/**'],
    // The plugin's tests each boot a CMS on an embedded database.
    testTimeout: 20_000,
  },
})
