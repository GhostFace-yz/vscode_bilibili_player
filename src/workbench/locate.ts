import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WorkbenchInstall {
  appRoot: string;
  version: string;
  htmlPath: string;
  /** product.json 的 checksums key，例如 vs/code/electron-browser/workbench/workbench.html */
  checksumKey: string;
  productJsonPath: string;
}

const HTML_CANDIDATES = [
  'out/vs/code/electron-browser/workbench/workbench.html',
  'out/vs/code/electron-sandbox/workbench/workbench.html',
];

/**
 * 探测当前 VS Code 安装中的 workbench.html。
 * 1.147 及以后在 electron-browser 下，旧版本在 electron-sandbox 下。
 */
export function locateWorkbench(appRoot: string, version: string): WorkbenchInstall | undefined {
  for (const relative of HTML_CANDIDATES) {
    const htmlPath = path.join(appRoot, relative);
    if (!fs.existsSync(htmlPath)) {
      continue;
    }

    const outDir = path.join(appRoot, 'out');
    const checksumKey = path.relative(outDir, htmlPath).split(path.sep).join('/');

    return {
      appRoot,
      version,
      htmlPath,
      checksumKey,
      productJsonPath: path.join(appRoot, 'product.json'),
    };
  }

  return undefined;
}
