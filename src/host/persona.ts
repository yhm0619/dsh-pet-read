/**
 * 人设拼装（host 半侧，纯逻辑）：碎碎念与对话共用的 system 提示词在**这一处**拼好。
 *
 * 拼装 = 三段，顺序固定：
 *   ① 人设正文：`pets[].whisperPrompt`（实例级）优先，没写回落到所属条目顶层的 `whisperPrompt`；
 *   ② 名字声明：「你的名字是“<name>”。」——name 已经是实例级（缺失时 mergePet 已按 id 填好），
 *      所以两只人设相同的宠物也各有自己的名字行；
 *   ③ 时间背景：`time-context.ts` 的 timeContextOf(new Date())——日期/星期/时刻/时段/工作日或周末/节日从句，
 *      每次生成都现算，绝不缓存（碎碎念与对话各调一次，拿到的都是**那一刻**）。
 *
 * 为什么不把 ②③ 做成配置项 / 占位符：拼装点必须唯一。配置里放 `{{name}}` 之类等于开第二个拼装点，
 * 用户写一个占位符就能拼出第二套规则，且以后改名/改时间格式要回填历史配置。
 *
 * 本模块不碰 IO、不读时钟（Date 由调用方传入），故能在 node:test 里直接跑（不必起宿主）；
 * 也正因为它纯，`petSystemPrompt`（index.ts）只剩"取字段 → 调这个函数"。
 */
import { timeContextOf } from './time-context';

/**
 * 某宠物最终生效的人设正文（不含名字与时间）：
 * `pets[].whisperPrompt`（实例级）→ 条目顶层 `whisperPrompt` → 空串。
 *
 * 语义是**替换**而不是拼接：实例写了就完全取代条目那一份。拼接会让两段人设互相打架
 * （条目写「你是蓝发女仆」、实例写「你是黑发猫娘」，模型收到两个身份）。
 *
 * 实例级的值由 host/config.ts 的 mergePet 过滤过（只放行非空字符串），这里仍做一次
 * `trim()` 判空——petPersona 也是导出函数，不能假设调用方一定走了合并器。
 */
export function petPersona(conf: Record<string, unknown>, pet: Record<string, unknown>): string {
  const own = pet.whisperPrompt;
  if (typeof own === 'string' && own.trim() !== '') return own;
  const entry = conf.whisperPrompt;
  return typeof entry === 'string' ? entry : '';
}

/** composeSystemPrompt 的入参 */
export interface SystemPromptParts {
  /** 已回落到生效值的人设正文（petPersona 的结果；空串 = 没有人设，只有名字 + 时间） */
  prompt: string;
  /** 显示名（pets[].name；缺失/空按 id 处理） */
  name: string;
  /** 宠物 id（name 为空时的兜底；两者都空 = 整段名字声明省略） */
  id: string;
  /** 生成这一刻（生产传 new Date()，测试传固定日期） */
  now: Date;
}

/**
 * 拼出最终 system 提示词：人设正文 + 名字声明 + 时间背景。
 *
 * 边界：
 *   - prompt 为空 → 不加前导换行（不会产出以 `\n` 开头的提示词）；
 *   - name 与 id 都为空 → 整段名字声明不加（不可能发生：id 是合并器的必填字段）；
 *   - now 非法（NaN）→ timeContextOf 返回空串，整行时间背景不加（宁缺，也不把 NaN 拼进提示词）。
 */
export function composeSystemPrompt(parts: SystemPromptParts): string {
  const name = String(parts.name || parts.id);
  const nameLine = name ? '你的名字是“' + name + '”。' : '';
  const lines = [parts.prompt, nameLine].filter((line) => line !== '');
  const time = timeContextOf(parts.now);
  if (time) lines.push(time);
  return lines.join('\n');
}
