/** Imgur paths that are pages of the site, not image ids. */
const IMGUR_RESERVED = new Set([
  'a',
  'about',
  'account',
  'apps',
  'blog',
  'gallery',
  'help',
  'jobs',
  'privacy',
  'register',
  'rules',
  'search',
  'signin',
  't',
  'tos',
  'tools',
  'upload',
  'user',
]);

const DIRECT_IMAGE = /\.(?:jpe?g|png|gif|webp)$/i;

/**
 * The address of an image that `rawUrl` points at, or null when it is not one we preview. Always https, and never
 * a URL with a user name or password in it. Imgur and Gyazo page links are turned into their image address;
 * albums are not guessed at.
 */
export function imagePreviewUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    return null;
  }
  const host = url.hostname.toLowerCase();

  if (host === 'imgur.com' || host === 'i.imgur.com' || host === 'm.imgur.com') {
    const m = /^\/(?:i\/)?([A-Za-z0-9]+)(?:\.(jpe?g|png|gif|gifv|webp))?\/?$/.exec(url.pathname);
    if (m && !IMGUR_RESERVED.has(m[1]!.toLowerCase())) {
      const ext = (m[2] ?? 'jpg').toLowerCase();
      return `https://i.imgur.com/${m[1]}.${ext === 'gifv' ? 'gif' : ext}`;
    }
    return null;
  }
  if (host === 'gyazo.com') {
    const m = /^\/([0-9a-f]{32})\/?$/i.exec(url.pathname);
    return m ? `https://i.gyazo.com/${m[1]}.png` : null;
  }
  if (DIRECT_IMAGE.test(url.pathname)) {
    url.protocol = 'https:';
    return url.href;
  }
  return null;
}

export interface UrlSpan {
  url: string;
  start: number;
  /** One past the last character. */
  end: number;
}

/** http(s) addresses in one line of text. Stops at the first character that is not plain ASCII (such as 、or 中文). */
export function urlsInLine(line: string): UrlSpan[] {
  const spans: UrlSpan[] = [];
  for (const m of line.matchAll(/https?:\/\/[\x21-\x7e]+/g)) {
    let url = m[0].split(/[<>"'`]/)[0]!;
    url = url.replace(/[.,;:!?)\]]+$/, '');
    if (url.length > 'https://'.length) {
      spans.push({ url, start: m.index, end: m.index + url.length });
    }
  }
  return spans;
}
