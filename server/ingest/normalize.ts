/**
 * 动作名归一化（T1）。
 *
 * 口径（DDL 注释 + §3.4）：全角转半角（NFKC 兼容分解）、去首尾空格、折叠连续空白、
 * ASCII 小写。产出 name_norm，供 T2 与 movement_catalog（1187 标准名）比对。
 *
 * 繁→简：需要完整字典，属于 T2「动作目录导入」的范围（目录侧同样做 NFKC 后比对），
 * 本文件不引入字典表。此为有记录的取舍，不是遗漏。
 */
export function normalizeName(raw: string): string {
  let s = raw.normalize('NFKC');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.toLowerCase();
  return s;
}
