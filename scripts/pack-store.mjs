import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * 打「VS Code 应用商店」用的 vsix：
 * vsce 只会打包 README.md，所以这里临时把 README.marketplace.md 换上去，
 * 打包完再还原成 GitHub 用的 README.md（finally 保证一定还原）。
 */
const GITHUB_README = 'README.md';
const STORE_README = 'README.marketplace.md';
const BACKUP = 'README.github.backup.md';

if (!existsSync(STORE_README)) {
  console.error(`缺少 ${STORE_README}`);
  process.exit(1);
}

execSync('pnpm run package', { stdio: 'inherit' });

if (existsSync(BACKUP)) {
  // 上次异常退出留下的备份：先恢复，避免覆盖 GitHub README
  renameSync(BACKUP, GITHUB_README);
}

renameSync(GITHUB_README, BACKUP);
try {
  copyFileSync(STORE_README, GITHUB_README);
  execSync('vsce package --no-dependencies', { stdio: 'inherit' });
} finally {
  rmSync(GITHUB_README, { force: true });
  renameSync(BACKUP, GITHUB_README);
}

console.log('已生成商店版 vsix，README.md 已还原为 GitHub 版本。');
