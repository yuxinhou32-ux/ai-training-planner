#!/usr/bin/env node
/**
 * TypeScript 编译器启动器（T1）。
 *
 * 背景：本项目运行时零第三方依赖（数据库用 Node 内置 node:sqlite），
 * 唯一的工具链依赖是 TypeScript（纯 JS 包）。按团队约定，包统一安装在共享
 * workspace（%USERPROFILE%/.workbuddy/binaries/node/workspace），项目内通过
 * node_modules 目录联结（junction）引用；本脚本按以下顺序解析 typescript：
 *   1) <项目>/node_modules/typescript（junction 或本地安装）
 *   2) NODE_PATH 环境变量中的各目录
 *   3) 默认共享 workspace 路径（%USERPROFILE%\.workbuddy\binaries\node\workspace）
 *
 * 用法与 tsc 完全一致：node scripts/tsc.mjs -p tsconfig.build.json
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = path.join('typescript', 'lib', 'tsc.js');

const candidates = [path.join(projectRoot, 'node_modules', rel)];

const nodePath = process.env.NODE_PATH ?? '';
const sep = process.platform === 'win32' ? ';' : ':';
for (const dir of nodePath.split(sep).filter(Boolean)) {
  candidates.push(path.join(dir, rel));
}
if (process.env.USERPROFILE) {
  candidates.push(
    path.join(process.env.USERPROFILE, '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', rel),
  );
}

const tscPath = candidates.find((p) => existsSync(p));
if (!tscPath) {
  console.error(
    '[tsc.mjs] 未找到 typescript。请任选其一：\n' +
      '  1) 在项目 node_modules 下建立指向共享 workspace 的 junction：\n' +
      '     New-Item -ItemType Junction -Path node_modules\\typescript -Target "%USERPROFILE%\\.workbuddy\\binaries\\node\\workspace\\node_modules\\typescript"\n' +
      '     New-Item -ItemType Junction -Path node_modules\\@types -Target "%USERPROFILE%\\.workbuddy\\binaries\\node\\workspace\\node_modules\\@types"\n' +
      '  2) 设置 NODE_PATH 指向含 typescript 的 node_modules；\n' +
      '  3) 在项目内本地安装：npm install -D typescript@^5.9 @types/node@^22',
  );
  process.exit(127);
}

const result = spawnSync(process.execPath, [tscPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
