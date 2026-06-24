// 用 esbuild 把 src/ 多模块打包成单个用户脚本，产物写到仓库根 biliHoyoFairy.user.js，
// 头部 prepend UserScript banner（含 @version）。保持产物在仓库根是为了不破坏 Tampermonkey
// 的 @updateURL / @downloadURL 自动更新链路。
import esbuild from 'esbuild';
import { banner } from '../src/meta.js';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  outfile: 'biliHoyoFairy.user.js',
  banner: { js: banner },
  target: ['chrome105', 'firefox100', 'edge105'],
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[build] watching src/ ...');
} else {
  await esbuild.build(options);
  console.log('[build] -> biliHoyoFairy.user.js');
}
