import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export function sha256Base64(filePath: string): string {
  // VS Code 的 product.json 使用去掉 '=' 填充的标准 base64（sha256）。
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('base64').replace(/=+$/, '');
}

/**
 * 只替换 product.json 中对应 key 的哈希值，保留其余内容与格式。
 * 某些 VS Code 版本的 checksums 不包含 workbench.html，此时返回 false。
 */
export function setChecksum(productJsonPath: string, key: string, value: string): boolean {
  const raw = fs.readFileSync(productJsonPath, 'utf8');
  const escaped = escapeRegExp(key);
  const pattern = new RegExp(`("${escaped}"\\s*:\\s*")[^"]*(")`);

  if (!pattern.test(raw)) {
    return false;
  }

  const next = raw.replace(pattern, (_match, prefix: string, suffix: string) => `${prefix}${value}${suffix}`);
  if (next !== raw) {
    fs.writeFileSync(productJsonPath, next);
  }

  return true;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ChecksumMismatch {
  key: string;
  file: string;
  expected: string;
  actual: string;
}

/** 找出 product.json 中与实际文件哈希不一致的条目。 */
export function findChecksumMismatches(appRoot: string, productJsonPath: string): ChecksumMismatch[] {
  if (!fs.existsSync(productJsonPath)) {
    return [];
  }

  const product = JSON.parse(fs.readFileSync(productJsonPath, 'utf8')) as {
    checksums?: Record<string, string>;
  };
  const checksums = product.checksums ?? {};
  const outDir = path.join(appRoot, 'out');
  const mismatches: ChecksumMismatch[] = [];

  for (const [key, expected] of Object.entries(checksums)) {
    const file = path.join(outDir, ...key.split('/'));
    if (!fs.existsSync(file)) {
      continue;
    }
    const actual = sha256Base64(file);
    if (actual !== expected) {
      mismatches.push({ key, file, expected, actual });
    }
  }

  return mismatches;
}

/**
 * 用当前文件重算所有不匹配的校验和。
 * 适用于 VS Code 被其它工具（如旧的后台视频脚本）修改过、一直提示“安装已损坏”的情况。
 * 只改 product.json，不动任何代码文件。
 */
export function fixChecksums(
  appRoot: string,
  productJsonPath: string,
  log?: (message: string) => void,
): ChecksumMismatch[] {
  const mismatches = findChecksumMismatches(appRoot, productJsonPath);
  if (mismatches.length === 0) {
    return [];
  }

  const backup = `${productJsonPath}.bilibili-backup`;
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(productJsonPath, backup);
    log?.(`已备份 product.json 到 ${backup}`);
  }

  for (const mismatch of mismatches) {
    setChecksum(productJsonPath, mismatch.key, mismatch.actual);
  }

  return mismatches;
}
