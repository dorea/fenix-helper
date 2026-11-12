import { build, context } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  logLevel: 'info',
};

const targets = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    external: ['vscode'],
    format: 'cjs',
    sourcemap: true,
  },
  {
    ...shared,
    entryPoints: ['test/sanity.ts'],
    outfile: 'out/sanity.mjs',
    format: 'esm',
    sourcemap: false,
  },
  {
    ...shared,
    entryPoints: ['test/smoke.ts'],
    outfile: 'out/smoke.mjs',
    format: 'esm',
    sourcemap: false,
  },
];

// --watch 时必须用 context().watch()；build() 是一次性构建
if (process.argv.includes('--watch')) {
  for (const t of targets) {
    const ctx = await context(t);
    await ctx.watch();
  }
  console.log('[esbuild] watching...');
} else {
  for (const t of targets) {
    await build(t);
  }
}
