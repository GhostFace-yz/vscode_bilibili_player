const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').BuildOptions}
 */
const shared = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'inline',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': production ? '"production"' : '"development"',
  },
};

const builds = [
  // 扩展宿主（Node.js / CommonJS），vscode 由宿主注入
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  // 注入到工作台渲染进程的皮肤（浏览器 / IIFE）
  {
    ...shared,
    entryPoints: ['src/skin/main.tsx'],
    outfile: 'dist/skin.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    jsx: 'automatic',
    loader: { '.png': 'dataurl' },
  },
];

async function main() {
  if (watch) {
    const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('[esbuild] watching...');
    return;
  }
  await Promise.all(builds.map((options) => esbuild.build(options)));
  console.log('[esbuild] 构建完成：在 VS Code 中按 F5 调试；若皮肤已应用，请重新执行「B站皮肤: 应用皮肤」以更新注入资源。');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
