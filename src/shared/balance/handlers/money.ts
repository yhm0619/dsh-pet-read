// money 形态（账户金额）：多币种按各自基准折算已用百分比 + 气泡文案。
//
// 不同币种不能相加金额，但比例是无量纲的 —— 所以不需要汇率，各算各的剩余比例再叠加。

import type { BalanceBubbleRow, BalanceView } from '../types';
import type { ShapeHandler } from './shape';

/**
 * money：各币种按**自己的基准**（`fullBalance`）算「剩余比例」，再相加折算成已用百分比。
 * 没有基准的币种跳过（不参与折算，不替它猜一个）；一个带基准的都没有 → undefined（不播档位）。
 */
function moneyPercent(v: BalanceView): number | undefined {
  let remaining = 0;
  let based = 0;
  for (const w of v.wallets ?? []) {
    const total = Number(w.total);
    const full = Number(w.fullBalance);
    // 金额非法 / 该币种没有基准 → 跳过（不参与折算，不替它猜一个）
    if (!Number.isFinite(total) || !Number.isFinite(full) || full <= 0) continue;
    remaining += total / full; // 负数（透支）会拉低剩余量，最终被夹到「已用完」
    based++;
  }
  if (based === 0) return undefined; // 一个带基准的币种都没有 → 不播档位
  return Math.max(0, Math.min(100, 100 - remaining * 100)); // 折算为已用百分比
}

/**
 * money：一行「余额（峰/谷）¥x.xx」。
 *
 * 只显示 `total !== 0` 的币种（**负数要显示**——透支是真的欠钱；正好 0 的不占地方），
 * CNY 优先，用符号拼、`/` 分隔；全都为 0 时兜底显示主币种 ¥0.00（否则气泡会空一行）。
 * 档位装饰（峰/谷）只有提供该计价规则的服务商才有；没有就不加括号那一段。
 */
function moneyRows(v: BalanceView): BalanceBubbleRow[] {
  const visible = (v.wallets ?? [])
    .filter((w) => Number(w.total) !== 0)
    .sort((a, b) => (a.currency === 'CNY' ? 0 : 1) - (b.currency === 'CNY' ? 0 : 1));
  const amount =
    visible.length > 0 ? visible.map((w) => (w.currency === 'USD' ? '$' : '¥') + w.total).join('/') : '¥0.00';
  if (!v.tier) return [{ role: 'label', text: '余额 ' + amount }];
  return [
    { role: 'label', text: '余额（' },
    { role: 'tier', tier: v.tier, text: v.tier === 'peak' ? '峰' : '谷' },
    { role: 'label', text: '）' + amount },
  ];
}

export const moneyHandler: ShapeHandler = {
  percent: moneyPercent,
  rows: moneyRows,
};
