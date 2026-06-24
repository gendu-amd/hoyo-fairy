// 通用工具：Cookie 读取、时长/播放量解析、HTML 转义。纯函数、无依赖（L0 叶子）。

// 读取指定 Cookie（用于拿 bili_jct CSRF token）。
export function getCookie(name: string): string {
  const m = document.cookie.match(new RegExp('(^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[2]) : '';
}

// 时长字符串 "mm:ss" / "hh:mm:ss" → 秒；无法解析返回 null。
export function parseDuration(s: string | null | undefined): number | null {
  if (!s) return null;
  const parts = s.trim().split(':').map((x) => parseInt(x, 10));
  if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// 播放量字符串（含「万 / 亿」单位）→ 数值；无法解析返回 null。
export function parseCount(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = s.trim().replace(/[,\s]/g, '');
  const m = t.match(/^([\d.]+)\s*(万|亿)?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  if (m[2] === '万') n *= 1e4;
  else if (m[2] === '亿') n *= 1e8;
  return Math.round(n);
}

// 有容量上限的 Map 写入：超出 max 时按插入顺序淘汰最旧的键，避免长会话缓存无界增长。
// 注：对缓存语义友好——被淘汰的键下次会重新拉取，结果不变，仅丢一次缓存。
export function capMapSet<K, V>(map: Map<K, V>, key: K, val: V, max: number): void {
  map.set(key, val);
  while (map.size > max) {
    const oldest = map.keys().next().value as K;
    map.delete(oldest);
  }
}

// HTML 转义：所有写入 innerHTML 的动态文本都应先过这里。
export function escapeHtml(s: string | null | undefined): string {
  return (s || '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}
