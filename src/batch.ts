// 名单批量解析（纯逻辑，无 DOM）：把粘贴/文件/URL 来的一批文本解析成 UID 与 UP 名两组。
// 拆分（空格/逗号/换行/分号/顿号）→ 纯数字或 uid: 前缀=UID，up: 前缀或其它=名称；跳过 ! # 注释行首。

export interface ParsedNameList {
  uids: string[];
  names: string[];
}

export function parseNameList(raw: string): ParsedNameList {
  const uids: string[] = [];
  const names: string[] = [];
  const seen = new Set<string>();
  const addUid = (u: string) => {
    if (!seen.has(u)) {
      seen.add(u);
      uids.push(u);
    }
  };
  String(raw || '')
    .split(/[\s,，;；、]+/)
    .forEach((tok) => {
      const t = (tok || '').trim();
      if (!t || t[0] === '!' || t[0] === '#') return;
      let m;
      if ((m = t.match(/^uid:\s*(\d+)$/i))) addUid(m[1]);
      else if ((m = t.match(/^up:\s*(.+)$/i))) {
        const nm = m[1].trim();
        if (nm) names.push(nm);
      } else if (/^\d{3,}$/.test(t)) addUid(t);
      else names.push(t);
    });
  return { uids, names };
}
