/**
 * dsh-pet desktop helper —— 托盘的平台差异（纯判定，不 require('electron')）
 *
 * 为什么单独一份：三平台的托盘行为不一样，而这些差异全是「规则」；规则必须住在可被 node:test
 * 直接加载的纯模块里，main.js 只接线（同 pointer-target.js / topmost-watchdog.js /
 * dpi-linearization.js）。源码守卫见 src/host/dpi-linearization.test.ts
 * 「平台例外只允许住在模块里（main.js 不得出现 darwin 分支）」。
 *
 * 三平台差异：
 *   · macOS：菜单栏有深浅色，图标必须按**模板图**处理（纯黑+透明，系统自动反色），否则深色下
 *            看不见；`setContextMenu` 之后**左键单击**即弹菜单；桌面宠物不该占 Dock（app.dock.hide）。
 *   · Windows：`setContextMenu` 只接管**右键**，左键单击默认什么都不做，必须自己 popUpContextMenu；
 *              通知区域会把第三方图标折叠进「隐藏的图标」溢出面板——代码管不了，只能文档提示。
 *   · Linux：`click` 事件不可靠（Electron 文档明示），交互只能依赖 `setContextMenu`；原生 GNOME
 *            默认不显示任何托盘图标（需 AppIndicator 扩展），代码无法绕过。
 */
'use strict';

/**
 * 托盘的平台开关。
 *
 * @param {string} platform process.platform 的值（'darwin' / 'win32' / 'linux' / ...）
 * @returns {{templateImage:boolean,leftClickPopsMenu:boolean,hideDock:boolean}}
 *   templateImage     图标是否按模板图处理（macOS 深浅色菜单栏）
 *   leftClickPopsMenu 左键单击是否需要手动弹菜单（Windows 不会自动弹）
 *   hideDock          是否隐藏 Dock 图标（macOS 专有；其它平台没有 Dock）
 */
function trayPlatform(platform) {
  const mac = platform === 'darwin';
  return {
    templateImage: mac,
    leftClickPopsMenu: platform === 'win32',
    hideDock: mac,
  };
}

module.exports = { trayPlatform };
