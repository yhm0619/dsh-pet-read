// 余额层的类型：wire 入参（RawBalanceResult）、已解析视图（BalanceView）、气泡行数据（BalanceBubbleRow）。
//
// 纯类型文件（唯一的运行时导入是 `import type`，编译后消失），不依赖任何逻辑模块。

import type { QuotaTone } from './tone';

/**
 * 展示形态 —— 三种，且**不含任何服务商信息**：
 * - `windows`：三窗口用量（百分比 + 重置倒计时）→ 气泡「X额度已用 N%」
 * - `money`：账户金额 → 气泡「余额（峰/谷）¥x.xx」
 * - `points`：积分/点数余额（非货币）→ 气泡「余额 800 积分」
 *
 * 这里是 `Record<BalanceShape, …>`（handlers/index.ts）的键类型：加形态时漏改会被编译拦住。
 */
export type BalanceShape = 'windows' | 'money' | 'points';

/** 余额叶子里的原始响应（与 host/balance/ 的 BalanceResult 同构；两端按此结构校验） */
export interface RawBalanceResult {
  ok: boolean;
  provider?: string;
  /** 展示形态（host 写叶子时带上）：windows = 三窗口用量，money = 账户金额，points = 积分 */
  shape?: BalanceShape;
  reason?: string;
  message?: string;
  data?: {
    rolling?: unknown;
    weekly?: unknown;
    monthly?: unknown;
    rollingResetsAt?: unknown;
    weeklyResetsAt?: unknown;
    monthlyResetsAt?: unknown;
    rollingCapUsd?: unknown;
    weeklyCapUsd?: unknown;
    monthlyCapUsd?: unknown;
    rollingLabel?: unknown;
    /** money：多币种钱包数组（每项 `{currency,total,granted,toppedUp,fullBalance?}`） */
    wallets?: unknown;
    tier?: unknown;
    /** points：展示单位（「积分」「点数」…）—— 只拼在数字后面，不参与任何计算 */
    unit?: unknown;
    /** points：当前余额（字符串，与接口一致，不做换算） */
    total?: unknown;
    /** points：档位基准；缺省 = 不参与百分比折算、不播档位动画 */
    full?: unknown;
  };
}

/** 计价档位装饰（气泡上的「峰/谷」）：由服务商算好后随数据带出，展示层原样渲染 */
export type PricingTier = 'peak' | 'idle';

/** 已解析的余额视图（展示 + 档位计算用） */
export interface BalanceView {
  provider: string;
  shape: BalanceShape;
  ok: true;
  /**
   * 三窗口已用百分比（0-100 数字）+ 各自的重置时间。
   * `monthly` 必有（月度窗口是数据的底线）；`rolling` / `weekly` 可缺省 = 该服务商没有这个窗口。
   */
  rolling?: number;
  weekly?: number;
  monthly?: number;
  rollingResetsAt?: string;
  weeklyResetsAt?: string;
  monthlyResetsAt?: string;
  /**
   * 各窗口满额度（USD），由服务商随数据带出（opencode 是业务常量、commandcode 是接口回报）。
   * 用于「最紧迫窗口」的绝对口径；缺省 → 退化为百分比口径。展示层不再写死任何服务商的额度。
   */
  rollingCapUsd?: number;
  weeklyCapUsd?: number;
  monthlyCapUsd?: number;
  /** 滚动窗展示名（服务商自报，如 `5h`）；缺省回落 DEFAULT_ROLLING_LABEL */
  rollingLabel?: string;
  /** money：多币种钱包（每项一个币种）。展示层据此选符号、过滤为 0 的币种、拼气泡 */
  wallets?: MoneyWalletView[];
  /** money：计价档位装饰；缺省 = 渲染成不带峰谷的「余额 ¥x.xx」 */
  tier?: PricingTier;
  /** points：积分/点数余额（非货币，`unit` 只用于展示） */
  points?: PointsView;
}

/** 积分/点数余额（points 形态的已解析数据）。`full` 缺省 = 没有基准，不参与档位折算 */
export interface PointsView {
  unit: string;
  total: string;
  full?: string;
}

/** 一个币种的余额（money 形态）。`fullBalance` 缺省 = 该币种没有基准，不参与档位折算 */
export interface MoneyWalletView {
  currency: string;
  total: string;
  granted: string;
  toppedUp: string;
  fullBalance?: string;
}

/** 无效（不支持/缺凭证/抓取失败）：显式标记，不静默 */
export interface BalanceUnavailable {
  provider: string;
  ok: false;
  reason: 'unsupported' | 'credential-missing' | 'fetch-error';
  message?: string;
}

export type BalanceState = BalanceView | BalanceUnavailable;

/** 窗口键（三种窗口类别，与服务商无关） */
export type WindowKey = 'rolling' | 'weekly' | 'monthly';

/** 一个窗口的额度概况（用于联想框一句话判定） */
export interface WindowUsage {
  label: string;
  percent: number;
  /** 满额度（USD），由服务商随数据带出；算不出时缺省 */
  quotaUsd?: number;
  /** 剩余额度（USD）= 满额度 × (100 − percent) / 100；满额度未知时缺省 */
  remainingUsd?: number;
  resetsAt?: string;
}

/** 气泡行数据：role 决定两端的样式类（浏览器 React span；桌面 DOM div）；tier 用于峰谷着色 */
export type BalanceBubbleRow =
  | { role: 'label'; text: string }
  | { role: 'sub'; text: string }
  | { role: 'error'; text: string }
  | { role: 'tier'; tier: PricingTier; text: string }
  | {
      /** 展开态一行 = 一个窗口：窗口名 + 进度条 + 已用百分比 + 重置倒计时 */
      role: 'quota';
      /** 纯文本兜底（不认识本 role 的消费方也能原样显示这一行） */
      text: string;
      label: string;
      /** 进度条长度 = 已用百分比（0-100） */
      percent: number;
      tone: QuotaTone;
      usedText: string;
      resetText: string;
    };

/** 非 ok 状态「弹不弹文字说明气泡」的判定结果 */
export interface BalanceNoticeDecision {
  /** true = 本次应弹气泡（文字说明）；false = 静默（同一原因已提示过，且非显式请求） */
  show: boolean;
  /** 本次提示的原因标识（形如 `unsupported:unregistered-provider`；ok 状态为 null）：调用方存下，供下次比较 */
  key: string | null;
}
