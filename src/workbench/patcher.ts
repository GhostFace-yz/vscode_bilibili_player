import * as fs from 'node:fs';
import * as path from 'node:path';
import { patchWorkbenchCsp, readCsp, replaceCsp } from './csp';
import { sha256Base64, setChecksum } from './checksums';
import type { WorkbenchInstall } from './locate';

export const SKIN_JS = 'bilibili-skin.js';
export const SKIN_CSS = 'bilibili-skin.css';
export const SKIN_CONFIG = 'bilibili-skin.config.js';
export const ORIGINAL_CSP = 'bilibili-skin.original-csp.txt';

const HEAD_START = '<!-- bilibili-skin:head:start -->';
const HEAD_END = '<!-- bilibili-skin:head:end -->';
const BODY_START = '<!-- bilibili-skin:body:start -->';
const BODY_END = '<!-- bilibili-skin:body:end -->';

const INJECTED_HEAD = /<!-- bilibili-skin:head:start -->[\s\S]*?<!-- bilibili-skin:head:end -->\s*/g;
const INJECTED_BODY = /<!-- bilibili-skin:body:start -->[\s\S]*?<!-- bilibili-skin:body:end -->\s*/g;

export interface SkinAssets {
  js: string;
  css: string;
  configJs: string;
}

export interface ApplyOptions {
  backupRoot?: string;
  /** 追加到脚本/样式 URL 上，强制浏览器在更新后重新加载资源 */
  cacheKey?: string;
  log?: (message: string) => void;
}

export function isPatched(install: WorkbenchInstall): boolean {
  try {
    const html = fs.readFileSync(install.htmlPath, 'utf8');
    return html.includes(HEAD_START) || html.includes(BODY_START);
  } catch {
    return false;
  }
}

export function stripInjection(html: string): string {
  return html.replace(INJECTED_HEAD, '').replace(INJECTED_BODY, '');
}

export function injectAssets(html: string, cacheKey = Date.now().toString(36)): string {
  if (!html.includes('</head>') || !html.includes('</body>')) {
    throw new Error('workbench.html 结构异常：找不到 </head> 或 </body>');
  }

  const query = `?v=${encodeURIComponent(cacheKey)}`;
  const headBlock = [
    HEAD_START,
    `\t<link rel="stylesheet" href="./${SKIN_CSS}${query}" />`,
    HEAD_END,
  ].join('\n');

  const bodyBlock = [
    BODY_START,
    `\t<script src="./${SKIN_CONFIG}${query}" defer></script>`,
    `\t<script src="./${SKIN_JS}${query}" defer></script>`,
    BODY_END,
  ].join('\n');

  return html
    .replace('</head>', `${headBlock}\n</head>`)
    .replace('</body>', `${bodyBlock}\n</body>`);
}

export function applyPatch(install: WorkbenchInstall, assets: SkinAssets, options: ApplyOptions = {}): string {
  const htmlDir = path.dirname(install.htmlPath);
  fs.accessSync(htmlDir, fs.constants.W_OK);

  if (options.backupRoot) {
    backupWorkbench(install, options.backupRoot);
  }

  const originalHtml = fs.readFileSync(install.htmlPath, 'utf8');
  const cspPath = path.join(htmlDir, ORIGINAL_CSP);
  const wasPatched = originalHtml.includes(HEAD_START) || originalHtml.includes(BODY_START);

  if (!wasPatched || !fs.existsSync(cspPath)) {
    const originalCsp = readCsp(originalHtml);
    if (originalCsp !== undefined) {
      fs.writeFileSync(cspPath, originalCsp);
    }
  }

  try {
    let html = stripInjection(originalHtml);
    html = patchWorkbenchCsp(html);
    html = injectAssets(html, options.cacheKey);

    writeAsset(htmlDir, SKIN_JS, assets.js);
    writeAsset(htmlDir, SKIN_CSS, assets.css);
    writeAsset(htmlDir, SKIN_CONFIG, assets.configJs);
    fs.writeFileSync(install.htmlPath, html);

    updateWorkbenchChecksum(install, options.log);
  } catch (error) {
    try {
      fs.writeFileSync(install.htmlPath, originalHtml);
      updateWorkbenchChecksum(install, options.log);
    } catch {
      // 保留原始错误
    }
    throw error;
  }

  return htmlDir;
}

export function restorePatch(install: WorkbenchInstall, options: ApplyOptions = {}): boolean {
  let html: string;
  try {
    html = fs.readFileSync(install.htmlPath, 'utf8');
  } catch {
    return false;
  }

  if (!html.includes(HEAD_START) && !html.includes(BODY_START)) {
    return false;
  }

  const htmlDir = path.dirname(install.htmlPath);
  const cspPath = path.join(htmlDir, ORIGINAL_CSP);
  let next = stripInjection(html);

  if (fs.existsSync(cspPath)) {
    next = replaceCsp(next, fs.readFileSync(cspPath, 'utf8'));
  }

  fs.writeFileSync(install.htmlPath, next);
  updateWorkbenchChecksum(install, options.log);

  for (const file of [SKIN_JS, SKIN_CSS, SKIN_CONFIG, ORIGINAL_CSP]) {
    fs.rmSync(path.join(htmlDir, file), { force: true });
  }

  return true;
}

export function writeSkinConfig(install: WorkbenchInstall, configJs: string): void {
  const target = path.join(path.dirname(install.htmlPath), SKIN_CONFIG);
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === configJs) {
    return;
  }
  writeAsset(path.dirname(install.htmlPath), SKIN_CONFIG, configJs);
}

export function updateWorkbenchChecksum(install: WorkbenchInstall, log?: (message: string) => void): boolean {
  if (!fs.existsSync(install.productJsonPath)) {
    return false;
  }

  const hash = sha256Base64(install.htmlPath);
  const updated = setChecksum(install.productJsonPath, install.checksumKey, hash);
  if (!updated) {
    log?.(`product.json 未包含 ${install.checksumKey}，跳过校验和更新`);
  }
  return updated;
}

export function backupWorkbench(install: WorkbenchInstall, backupRoot: string): string {
  const dir = path.join(backupRoot, sanitize(install.version));
  fs.mkdirSync(dir, { recursive: true });

  const htmlBackup = path.join(dir, 'workbench.html');
  if (!fs.existsSync(htmlBackup)) {
    fs.copyFileSync(install.htmlPath, htmlBackup);
  }

  const productBackup = path.join(dir, 'product.json');
  if (!fs.existsSync(productBackup)) {
    fs.copyFileSync(install.productJsonPath, productBackup);
  }

  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify(
      {
        version: install.version,
        htmlPath: install.htmlPath,
        checksumKey: install.checksumKey,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  return dir;
}

function writeAsset(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content);
}

function sanitize(value: string): string {
  return value.replace(/[^\w.-]+/g, '_');
}
