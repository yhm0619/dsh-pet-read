// 档位百分比与档位索引：宠物动画的驱动依据。
//
// 百分比本身按形态分派到各自的 handler（windows 取三窗口最大；money / points 按基准折算），
// 这里只保留「入口 + 与服务商无关的档位切分」。

import { HANDLERS } from './handlers';
import type { BalanceView } from './types';

/**
 * 事件档位百分比（已用百分比语义：0 = 未消耗，100 = 耗尽）。具体口径见各 handler：
 * - windows：取三窗口最大（风险最高者为准）
 * - money：按各币种自己的 `fullBalance` 折算后叠加（不需要汇率）
 * - points：按 `points.full` 折算（同一单位内的比值）
 * 给不出百分比语义的形态 → undefined（不播档位动画，不替服务商猜一个）。
 */
export function balancePercent(v: BalanceView): number | undefined {
  return HANDLERS[v.shape].percent(v);
}

/**
 * 余额事件档位索引（与 assets/config.jsonc 注释一致）：
 * index = p === 100 ? 5 : Math.floor(p / 20)
 */
export function balanceEventIndex(p: number): number {
  if (p === 100) return 5;
  const i = Math.floor(p / 20);
  return i < 5 ? i : 4;
}
