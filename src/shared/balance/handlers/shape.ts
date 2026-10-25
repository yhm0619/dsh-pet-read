// 一种展示形态需要提供的展示规则（handlers/index.ts 用它组成 `Record<BalanceShape, …>`）。
//
// 分成 percent / rows / detail 三件事，是为了让「一个形态的全部展示知识」待在一个文件里：
// 加形态只写一个新的 handler，不在主流程里插分支。

import type { BalanceBubbleRow, BalanceView } from '../types';

export interface ShapeHandler {
  /** 已用百分比（0-100，驱动宠物档位动画）；undefined = 该形态给不出百分比语义 */
  percent(v: BalanceView): number | undefined;
  /** 收起态气泡行 */
  rows(v: BalanceView): BalanceBubbleRow[];
  /** 展开态气泡行；缺省 = 该形态没有额外读数，由调用方回落 rows() */
  detail?(v: BalanceView): BalanceBubbleRow[];
}
