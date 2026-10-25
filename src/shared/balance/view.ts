// 气泡行数据的主出口（浏览器与桌面共用同一份内容/文案）：
// BalanceState → BalanceBubbleRow[]，纯函数，不碰 DOM/React。
//
// 形态相关的文案不在这里：这里只负责「不可用状态」的说明行 + 按形态查分发表。

import { HANDLERS } from './handlers';
import type { BalanceBubbleRow, BalanceState, BalanceUnavailable } from './types';

/** 不可用状态的气泡行（显式说明原因，绝不伪造数字）：
 *  - unsupported：服务商未登记查询接口（配置事实，不是故障）→ 报出 provider id，便于自查"当前到底是谁"
 *  - credential-missing：缺凭证 → 次要行放 host 报的凭证名（不含 message 时不留空行）
 *  - fetch-error：抓取失败 → 次要行放底层错误
 * 次要行为空的会被剔除：空 div 在气泡里会白占一行高度。 */
function unavailableRows(state: BalanceUnavailable): BalanceBubbleRow[] {
  const rows: BalanceBubbleRow[] =
    state.reason === 'unsupported'
      ? [
          { role: 'error', text: '当前服务商暂不支持余额查询' },
          { role: 'sub', text: '当前服务商：' + state.provider },
        ]
      : state.reason === 'credential-missing'
        ? [
            // host 的 message 本身已带「缺少凭证 X」前缀：这里只作次要行原样展示，不再加前缀
            // （曾经的「缺少凭证：缺少凭证 X」双重前缀）
            { role: 'error', text: '缺少余额查询凭证' },
            { role: 'sub', text: state.message ?? '' },
          ]
        : [
            { role: 'error', text: '余额查询失败' },
            { role: 'sub', text: state.message ?? '' },
          ];
  return rows.filter((r) => r.role !== 'quota' && r.text !== '');
}

/**
 * 把 BalanceState 渲染成气泡行数据（纯函数，不碰 DOM/React）：
 * - windows：两行 —— 「X额度已用 N%」+ 重置倒计时
 * - money：一行 —— 「余额（峰/谷）¥x.xx」（峰红/谷绿由 role:'tier' 表达）；
 *   服务商没给档位装饰时退化成「余额 ¥x.xx」，不替它编一个峰谷
 * - points：一行 —— 「余额 800 积分」（单位由数据带出，绝不套货币符号）
 * - 无效：显式展示不可用原因（见 unavailableRows），绝不伪造数字
 */
export function balanceBubbleView(state: BalanceState): BalanceBubbleRow[] {
  if (!state.ok) return unavailableRows(state);
  return HANDLERS[state.shape].rows(state);
}

/**
 * 展开态行数据（点余额气泡后显示）：只有 windows 有三窗口读数可展开，每个存在窗口一行。
 *
 * money / points 形态没有"窗口"这个概念（只有账户余额 / 积分），也没有额外的 handler.detail，
 * 于是回落到收起态视图 —— 展开前后内容一致，不会出现"点了一下却什么都没变"的空交互。
 */
export function balanceDetailView(state: BalanceState): BalanceBubbleRow[] {
  if (!state.ok) return unavailableRows(state);
  const handler = HANDLERS[state.shape];
  return handler.detail ? handler.detail(state) : handler.rows(state);
}
