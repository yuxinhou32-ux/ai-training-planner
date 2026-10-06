import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * .env 加载器（T1，自探针脚本移植）。
 *
 * - 只做「进程内注入」，不写任何文件；
 * - 不覆盖已存在的环境变量（dotenv 惯例）；
 * - 支持 `KEY=VALUE`、引号包裹、`export ` 前缀、`#` 注释、UTF-8（含 BOM）。
 * - 🔴 绝不打印任何变量值（红线 §12.3）。
 */
export function loadEnvFile(cwd: string, filenames: string[] = ['.env', '.env.local']): string[] {
  const loaded: string[] = [];
  for (const name of filenames) {
    const filePath = path.resolve(cwd, name);
    if (!existsSync(filePath)) continue;
    let text = readFileSync(filePath, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip UTF-8 BOM
    let count = 0;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
      const eq = withoutExport.indexOf('=');
      if (eq <= 0) continue;
      const key = withoutExport.slice(0, eq).trim();
      let value = withoutExport.slice(eq + 1).trim();
      const isQuoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"));
      if (isQuoted && value.length >= 2) value = value.slice(1, -1);
      if (process.env[key] === undefined) {
        process.env[key] = value;
        count += 1;
      }
    }
    loaded.push(`${name}(${count})`);
  }
  return loaded;
}
