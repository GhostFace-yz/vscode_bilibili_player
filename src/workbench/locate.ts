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

/** 把 appRoot/out/... 的 html 路径包装成 WorkbenchInstall。 */
function toInstall(appRoot: string, htmlPath: string, version: string): WorkbenchInstall {
  const outDir = path.join(appRoot, 'out');
  return {
    appRoot,
    version,
    htmlPath,
    checksumKey: path.relative(outDir, htmlPath).split(path.sep).join('/'),
    productJsonPath: path.join(appRoot, 'product.json'),
  };
}

/**
 * 探测当前 VS Code 安装中的 workbench.html。
 * 1.147 及以后在 electron-browser 下，旧版本在 electron-sandbox 下。
 */
export function locateWorkbench(appRoot: string, version: string): WorkbenchInstall | undefined {
  for (const relative of HTML_CANDIDATES) {
    const htmlPath = path.join(appRoot, relative);
    if (fs.existsSync(htmlPath)) {
      return toInstall(appRoot, htmlPath, version);
    }
  }

  return undefined;
}

/**
 * 找出这次安装里所有可能被加载的 workbench.html。
 *
 * Windows 1.9x 起安装目录会带版本号子目录（...\Microsoft VS Code\<hash>\resources\app），
 * 而且 electron-browser / electron-sandbox 两种布局可能同时存在。
 * 只改 appRoot 指向的那份时，实际加载的可能是另一份，表现就是
 * “注入显示成功，但页面上根本没有我们的 script 标签、HUD 完全不出现”。
 */
export function locateWorkbenchAll(appRoot: string, version: string): WorkbenchInstall[] {
  const out: WorkbenchInstall[] = [];
  const seen = new Set<string>();

  const add = (root: string) => {
    for (const relative of HTML_CANDIDATES) {
      const htmlPath = path.join(root, relative);
      const key = htmlPath.toLowerCase();
      if (seen.has(key) || !fs.existsSync(htmlPath)) {
        continue;
      }
      seen.add(key);
      out.push(toInstall(root, htmlPath, version));
    }
  };

  add(appRoot);

  // resources/app -> resources -> <hash> -> 安装根目录
  const resourcesApp =
    path.basename(appRoot).toLowerCase() === 'app' &&
    path.basename(path.dirname(appRoot)).toLowerCase() === 'resources';
  if (resourcesApp) {
    const installRoot = path.dirname(path.dirname(path.dirname(appRoot)));
    add(path.join(installRoot, 'resources', 'app'));
    try {
      for (const entry of fs.readdirSync(installRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const base = path.join(installRoot, entry.name);
        add(path.join(base, 'resources', 'app'));
        add(base);
      }
    } catch {
      // 读不了安装根目录就只查 appRoot
    }
  }

  return out;
}
