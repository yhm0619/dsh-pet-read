// 进度条配色档位（气泡展开态的那根进度条）：阈值只此一份，两端共用，不各写一套。
//
// 单独一个文件是为了避开循环依赖：handlers/* 需要 quotaTone，而 view.ts 又要 import
// handlers 的分发表。把这个叶子模块抽出来后，handlers → tone 是单向的。

/** 进度条配色档位：<70 正常 / 70–90 预警 / ≥90 危急 */
export type QuotaTone = 'ok' | 'warn' | 'crit';

export const QUOTA_WARN_PERCENT = 70;
export const QUOTA_CRIT_PERCENT = 90;

export function quotaTone(percent: number): QuotaTone {
  if (percent >= QUOTA_CRIT_PERCENT) return 'crit';
  if (percent >= QUOTA_WARN_PERCENT) return 'warn';
  return 'ok';
}
