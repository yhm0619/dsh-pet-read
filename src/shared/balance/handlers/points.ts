// points 形态（积分/点数余额，非货币）：按基准折算已用百分比 + 气泡文案。
//
// 与 money 的区别只在语义：单位是数据带出的后缀（「积分」「点数」），**绝不套货币符号**；
// 数学是同一套（单位在比值里被约掉），没有汇率问题。

import type { BalanceBubbleRow, BalanceView } from '../types';
import type { ShapeHandler } from './shape';

/**
 * points：与 money 同一套「按基准折算」的数学，数据来自 `points` 而非 `wallets`。
 * 没有基准 / 基准非法 → undefined（不播档位，不替服务商猜一个）。
 */
function pointsPercent(v: BalanceView): number | undefined {
  const total = Number(v.points?.total);
  const full = Number(v.points?.full);
  if (!Number.isFinite(total) || !Number.isFinite(full) || full <= 0) return undefined;
  return Math.max(0, Math.min(100, 100 - (total / full) * 100));
}

/**
 * points：一行「余额 800 积分」。
 * 单位是数据带出的后缀，**绝不套货币符号**（`currency` 那套 $/¥ 判断只属于 money）。
 * 0 也照常显示：0 积分是真实读数。
 */
function pointsRows(v: BalanceView): BalanceBubbleRow[] {
  const p = v.points;
  if (!p) return [{ role: 'label', text: '积分数据不可用' }];
  return [{ role: 'label', text: '余额 ' + p.total + ' ' + p.unit }];
}

export const pointsHandler: ShapeHandler = {
  percent: pointsPercent,
  rows: pointsRows,
};
