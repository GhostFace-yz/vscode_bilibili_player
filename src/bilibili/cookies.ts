export type CookieJar = Record<string, string>;

/**
 * 解析 Set-Cookie 头。只保留 name=value，忽略 Path/Domain/Expires 等属性。
 * 后续把它作为 Cookie 头原样发给 B 站接口即可。
 */
export function parseSetCookies(setCookies: string[]): CookieJar {
  const jar: CookieJar = {};

  for (const raw of setCookies) {
    const [pair] = raw.split(';', 1);
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      continue;
    }

    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) {
      continue;
    }
    jar[name] = value;
  }

  return jar;
}

export function mergeCookies(base: CookieJar, patch: CookieJar): CookieJar {
  return { ...base, ...patch };
}

export function serializeCookieJar(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}
