import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addCspSources, patchWorkbenchCsp, readCsp } from '../src/workbench/csp';
import { locateWorkbench } from '../src/workbench/locate';
import { applyPatch, isPatched, restorePatch, SKIN_CONFIG, SKIN_CSS, SKIN_JS } from '../src/workbench/patcher';

const REAL_APP = '/Applications/Visual Studio Code.app/Contents/Resources/app';
const RELATIVE_HTML = 'out/vs/code/electron-browser/workbench/workbench.html';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`ASSERT: ${message}`);
  }
}

function sha256Base64(text: string): string {
  return createHash('sha256').update(text).digest('base64').replace(/=+$/, '');
}

function checksumOf(productJsonPath: string, key: string): string {
  const product = JSON.parse(fs.readFileSync(productJsonPath, 'utf8')) as { checksums: Record<string, string> };
  return product.checksums[key];
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-vscode-'));
const htmlPath = path.join(tempRoot, RELATIVE_HTML);
fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
fs.copyFileSync(path.join(REAL_APP, RELATIVE_HTML), htmlPath);
fs.copyFileSync(path.join(REAL_APP, 'product.json'), path.join(tempRoot, 'product.json'));

const originalHtml = fs.readFileSync(htmlPath, 'utf8');
const install = locateWorkbench(tempRoot, '9.9.9-test');
assert(install, 'locateWorkbench 应找到 workbench.html');
assert(install.checksumKey === 'vs/code/electron-browser/workbench/workbench.html', 'checksum key 应正确');

const cspBefore = readCsp(originalHtml);
assert(cspBefore, '应能读取 CSP');
assert(!cspBefore.includes('bilivideo.com'), '原始 CSP 不应包含 B 站域名');

const nextCsp = addCspSources(cspBefore, { 'media-src': ['https://*.bilivideo.com'] });
assert(nextCsp.includes('media-src'), 'CSP 应保留 media-src');
assert(nextCsp.includes('https://*.bilivideo.com'), 'CSP 应追加媒体域名');
assert(nextCsp.includes('require-trusted-types-for'), 'CSP 应保留 Trusted Types 指令');

const patchedCsp = readCsp(patchWorkbenchCsp(originalHtml));
assert(patchedCsp?.includes('https://*.bilivideo.com'), 'workbench CSP 应允许 B 站视频');
assert(patchedCsp?.includes('http://127.0.0.1:*'), 'workbench CSP 应允许本地 API');
assert(patchedCsp?.includes("default-src 'none'"), 'CSP default-src 应保持 none');

applyPatch(
  install,
  {
    js: 'window.__BILI_TEST__ = true;',
    css: '/* test css */',
    configJs: 'window.__BILI_SKIN_CONFIG__ = { port: 17321, token: "t" };',
  },
  { backupRoot: path.join(tempRoot, 'backup') },
);

const patchedHtml = fs.readFileSync(htmlPath, 'utf8');
assert(isPatched(install), '应用后应检测为已注入');
assert(patchedHtml.includes('./bilibili-skin.js'), 'HTML 应引用皮肤脚本');
assert(patchedHtml.includes('./bilibili-skin.css'), 'HTML 应引用皮肤样式');
const scriptDirective = patchedCsp?.split(';').map((part) => part.trim()).find((part) => part.startsWith('script-src'));
assert(scriptDirective !== undefined && !scriptDirective.includes('unsafe-inline'), '不应放宽 script-src');
assert(checksumOf(install.productJsonPath, install.checksumKey) === sha256Base64(patchedHtml), 'product.json 校验和应匹配');

for (const file of [SKIN_JS, SKIN_CSS, SKIN_CONFIG]) {
  assert(fs.existsSync(path.join(path.dirname(htmlPath), file)), `${file} 应写入 workbench 目录`);
}

const restored = restorePatch(install);
assert(restored, '还原应成功');
const restoredHtml = fs.readFileSync(htmlPath, 'utf8');
assert(!isPatched(install), '还原后不应检测为已注入');
assert(checksumOf(install.productJsonPath, install.checksumKey) === sha256Base64(restoredHtml), '还原后校验和应匹配');

// 还原后的 HTML 应与原始文件完全一致（忽略注入标记之外的差异）
const normalizedOriginal = originalHtml.replace(/\r\n/g, '\n');
const normalizedRestored = restoredHtml.replace(/\r\n/g, '\n');
assert(
  normalizedOriginal.replace(/\s+/g, ' ').trim() === normalizedRestored.replace(/\s+/g, ' ').trim(),
  '还原内容应与原始 HTML 等价',
);

console.log('patcher tests passed:', tempRoot);
