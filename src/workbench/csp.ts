/** 追加到 workbench CSP 的源，允许直接播放 B 站 CDN 视频并访问本地 API。 */
export const CSP_ADDITIONS: Record<string, string[]> = {
  'media-src': ['https:', 'blob:', 'data:', 'http://127.0.0.1:*'],
  'connect-src': ['http://127.0.0.1:*', 'http://localhost:*', 'vscode-file:'],
  'frame-src': ['https://player.bilibili.com'],
};

const CSP_META = /<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i;
const CONTENT_ATTR = /content="([^"]*)"/i;

export function addCspSources(content: string, additions: Record<string, string[]>): string {
  const directives = new Map<string, string[]>();

  for (const part of content.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      continue;
    }
    const [name, ...values] = tokens;
    directives.set(name.toLowerCase(), values);
  }

  for (const [name, sources] of Object.entries(additions)) {
    const values = directives.get(name) ?? [];
    for (const source of sources) {
      if (!values.includes(source)) {
        values.push(source);
      }
    }
    directives.set(name, values);
  }

  return [...directives.entries()]
    .map(([name, values]) => (values.length > 0 ? `${name} ${values.join(' ')}` : name))
    .join('; ');
}

/** 修改 workbench.html 里的 CSP meta，使其允许 B 站媒体与本地 API。 */
export function patchWorkbenchCsp(html: string): string {
  const content = readCsp(html);
  if (content === undefined) {
    throw new Error('未在 workbench.html 中找到 Content-Security-Policy meta');
  }
  return replaceCsp(html, addCspSources(content, CSP_ADDITIONS));
}

/** 用给定内容替换 CSP meta 的 content 属性，保留其余格式。 */
export function replaceCsp(html: string, content: string): string {
  const tagMatch = CSP_META.exec(html);
  if (!tagMatch) {
    throw new Error('未在 workbench.html 中找到 Content-Security-Policy meta');
  }

  const tag = tagMatch[0];
  const contentMatch = CONTENT_ATTR.exec(tag);
  if (!contentMatch) {
    throw new Error('无法解析 workbench.html 的 CSP content 属性');
  }

  const nextTag = tag.replace(contentMatch[0], `content="${content}"`);
  return html.slice(0, tagMatch.index) + nextTag + html.slice(tagMatch.index + tag.length);
}

export function readCsp(html: string): string | undefined {
  const tagMatch = CSP_META.exec(html);
  if (!tagMatch) {
    return undefined;
  }
  return CONTENT_ATTR.exec(tagMatch[0])?.[1];
}
