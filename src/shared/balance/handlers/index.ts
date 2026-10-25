// 形态 → 展示规则的分发表。
//
// 这里刻意写成 `Record<BalanceShape, ShapeHandler>` 而不是三处 if/switch：以后给 BalanceShape
// 加形态却忘了补一个 handler，tsc 会直接报「缺少属性」（而不是静默走进别的分支——那正是
// 「非 money 一律当 windows」那种写法造成的坑）。

import type { BalanceShape } from '../types';
import { moneyHandler } from './money';
import { pointsHandler } from './points';
import type { ShapeHandler } from './shape';
import { windowsHandler } from './windows';

export const HANDLERS: Record<BalanceShape, ShapeHandler> = {
  windows: windowsHandler,
  money: moneyHandler,
  points: pointsHandler,
};
