// Empacota o servidor (TypeScript) em um único arquivo ESM em dist/server.
import { build } from 'esbuild';

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist/server/index.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});

// CLI do agente para publicar (habblaud-publicar): vai junto do servidor em dist/server/publicar.mjs.
await build({
  entryPoints: ['scripts/habblaud-publicar.mjs'],
  outfile: 'dist/server/publicar.mjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  logLevel: 'info',
});
