// 余额数据层与展示视图（src/shared 纯逻辑，浏览器 bundle 与桌面 shared-core 共用）：
// 解析 S 的余额叶子（host 的 BalanceResult）→ 客户端视图 → 档位计算 → 气泡行数据。
// 取数不在本模块：余额由 host 定时器刷新并写进 /state（两端共享同一份结果），本模块只做纯解析/展示。
// 不依赖 React/DOM；host/balance/ 的 BalanceResult 与本模块的 RawBalanceResult 同构（HTTP 契约两端
// 各自声明，host 无需 import 本目录——DSH 单文件加载约束）。
//
// **本模块不认识任何服务商**：只认叶子里的 `shape`（展示形态）与数据自带的业务事实
// （各窗口满额度、滚动窗时长、档位基准、峰谷档位）。服务商名字只用于日志与去重键。
// 加一个服务商只要落到 `windows` / `money` / `points` 之一，这里与两端展示层一行都不用改。
//
// 目录按职责分：
//   types.ts     —— 全部类型（wire 入参、已解析视图、气泡行）
//   parse.ts     —— 叶子 → 视图（白名单透传，不认识就返回 null）
//   percent.ts   —— 档位百分比入口 + 档位索引
//   view.ts      —— 气泡行主出口（不可用说明 + 按形态分发）
//   notice.ts    —— 不可用时「弹不弹」的判定
//   tone.ts      —— 进度条配色档位
//   handlers/    —— 每个形态一个文件（windows / money / points），由 handlers/index.ts 组成
//                   `Record<BalanceShape, ShapeHandler>`：加形态漏补 handler 会被 tsc 拦住
//
// 导出面保持与原单文件一致（`src/shared/index.ts` 与两端调用方都不受影响）。

export * from './types';
export * from './tone';
export * from './parse';
export * from './percent';
export * from './view';
export * from './notice';

// 形态各自的展示规则 + 公共的窗口工具（urgentWindow / resetInText / 窗口名表）
export * from './handlers';
export * from './handlers/windows';
