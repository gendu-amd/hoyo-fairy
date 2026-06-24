// 统一日志 + 错误边界。debug 关时 log 零开销；logErr 始终输出，便于线上排查。
import { CONFIG } from './config';

export const BADGE = 'color:#fff;background:#fb7299;padding:0 4px;border-radius:3px'; // 控制台日志的品牌徽标样式

export function log(...args: unknown[]): void {
  if (CONFIG.debug) console.log('%c[biliHoyoFairy]%c', BADGE, 'color:inherit', ...args);
}

export function logErr(where: string, e: unknown): void {
  try {
    console.warn(`%c[biliHoyoFairy]%c ${where}`, BADGE, 'color:#e74c3c', e);
  } catch (_) {
    /* 控制台不可用时静默 */
  }
}

// 错误边界：包装易抛错的回调/逐项处理，单点异常不拖垮整轮（B 站改版/异形 DOM 时尤其重要）。
export function safe<T extends (...args: any[]) => any>(
  where: string,
  fn: T
): (...args: Parameters<T>) => ReturnType<T> | undefined {
  return function (this: unknown, ...args: Parameters<T>) {
    try {
      return fn.apply(this, args);
    } catch (e) {
      logErr(where, e);
      return undefined;
    }
  };
}
