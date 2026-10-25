/**
 * 互动碎碎念（host 半侧）：看屏幕 → 让视觉模型随口吐槽一两句 → 交给客户端显示在宠物头顶气泡。
 *
 * 与碎碎念/对话的区别：
 *  - 输入不是用户文字，而是**一张屏幕截图**；因此不走 ctx.llm（DSH 当前的 DeepSeek 文本模型
 *    看不了图），直接调用配置里的 OpenAI 兼容视觉接口（默认智谱 GLM-4.5V，关思考求快）；
 *  - 输出限死 1~2 句、`interactiveMaxChars` 字以内，供头顶气泡展示；
 *  - 不配表情包（用户明确要求互动碎碎念不带图）。
 *
 * 安全：截图由桌面 Helper 落到系统临时目录，host 只接受 `dsh-pet-screen-<ts>.jpg` 形式的临时文件，
 * 读完立即删除；key 只从环境变量 / 本地 .env 读取，绝不返回给客户端，也不写日志。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';

/** 视觉接口单次超时（ms）：GLM-4.5V 关思考实测 2~4s，60s 足够且不会拖死窗口 */
const VISION_TIMEOUT_MS = 60_000;
/** 每只宠物保留的互动记录条数（窗口只展示尾部；全量落盘但截断） */
export const INTERACTIVE_LOG_MAX = 40;

/** 配置里与视觉接口/节奏有关的字段（conf = readAllConfig 的条目成品） */
export interface VisionSettings {
  model: string;
  baseUrl: string;
  apiKey: string;
  maxChars: number;
  intervalSec: number;
  envFile: string;
  /** 互动风格：soft=软萌（默认，接近对话）/ sharp=毒舌搭子 / persona=完全跟随人设 */
  style: 'soft' | 'sharp' | 'persona';
}

/** 互动记录：{ <petId>: { messages: [{text, ts}] } } */
export type InteractiveLog = Record<string, { messages: Array<{ text: string; ts: number }> }>;

/** 解析 KEY=VALUE 形式的 .env（忽略注释/空行/引号；不覆盖已存在的 process.env） */
export function parseEnvText(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** 视觉服务商预设：设置页「服务商」下拉框选它，这里给出默认接口地址/模型/环境变量名 */
const VISION_PRESETS: Record<
  string,
  { baseUrl: string; model: string; keys: string[]; modelEnv: string; baseEnv: string }
> = {
  zhipu: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.5v',
    keys: ['ZHIPU_API_KEY', 'GLM_API_KEY'],
    modelEnv: 'ZHIPU_MODEL',
    baseEnv: 'ZHIPU_BASE_URL',
  },
  doubao: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-1.5-vision-pro',
    keys: ['ARK_API_KEY', 'DOUBAO_API_KEY'],
    modelEnv: 'ARK_VISION_MODEL',
    baseEnv: 'ARK_BASE_URL',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keys: ['OPENAI_API_KEY'],
    modelEnv: 'OPENAI_MODEL',
    baseEnv: 'OPENAI_BASE_URL',
  },
  custom: {
    baseUrl: '',
    model: '',
    keys: ['VISION_API_KEY'],
    modelEnv: 'VISION_MODEL',
    baseEnv: 'VISION_BASE_URL',
  },
};

/** 把配置 / 环境变量 / 本地 .env 收敛成一次视觉调用所需的设置（key 缺失时显式失败，不伪造） */
export async function resolveVisionSettings(conf: Record<string, unknown>): Promise<VisionSettings> {
  const envFile = typeof conf.interactiveVisionEnvFile === 'string' ? conf.interactiveVisionEnvFile.trim() : '';
  let env: Record<string, string> = {};
  if (envFile) {
    try {
      env = parseEnvText(await readFile(envFile, 'utf8'));
    } catch {
      /* .env 不存在/不可读 = 没配 key 的一种，最后由 apiKey 空值显式报错 */
    }
  }
  const first = (...vals: Array<string | undefined>): string => {
    for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
    return '';
  };
  const rawProvider = typeof conf.interactiveVisionProvider === 'string' ? conf.interactiveVisionProvider.trim() : '';
  const provider = rawProvider && VISION_PRESETS[rawProvider] ? rawProvider : 'zhipu';
  const preset = VISION_PRESETS[provider];
  const configuredKey = typeof conf.interactiveVisionApiKey === 'string' ? conf.interactiveVisionApiKey : undefined;
  const apiKey = first(
    configuredKey,
    ...preset.keys.map((k) => process.env[k]),
    ...preset.keys.map((k) => env[k]),
    process.env.VISION_API_KEY,
    env.VISION_API_KEY,
  );
  const model = first(
    typeof conf.interactiveVisionModel === 'string' ? conf.interactiveVisionModel : undefined,
    env[preset.modelEnv],
    preset.model,
  );
  const baseUrl = first(
    typeof conf.interactiveVisionBaseUrl === 'string' ? conf.interactiveVisionBaseUrl : undefined,
    env[preset.baseEnv],
    preset.baseUrl,
  );
  const rawInterval = Number(conf.interactiveIntervalSec);
  const rawMaxChars = Number(conf.interactiveMaxChars);
  const rawStyle = typeof conf.interactiveStyle === 'string' ? conf.interactiveStyle.trim() : '';
  const style = rawStyle === 'sharp' || rawStyle === 'persona' ? rawStyle : 'soft';
  return {
    model,
    baseUrl,
    apiKey,
    maxChars: Number.isFinite(rawMaxChars) ? Math.min(200, Math.max(10, Math.floor(rawMaxChars))) : 60,
    intervalSec: Number.isFinite(rawInterval) ? Math.min(3600, Math.max(5, Math.floor(rawInterval))) : 30,
    envFile,
    style,
  };
}

/**
 * 把模型回复收敛成「1~2 句、maxChars 字以内」：
 *  - 去换行/首尾引号；
 *  - 最多保留两句（避免小窗口装不下）；
 *  - 超长时优先在最近的句读处截断，实在没有才硬截。
 */
export function trimComment(input: string, maxChars: number): string {
  let text = String(input ?? '')
    .replace(/\r/g, '')
    .replace(/\n+/g, ' ')
    .trim();
  text = text.replace(/^[\s"'“”‘’「」]+/, '').replace(/[\s"'“”‘’「」]+$/, '');
  const sentences = (text.match(/[^。！？!?]*[。！？!?]?/g) ?? []).map((s) => s.trim()).filter(Boolean);
  if (sentences.length > 2) text = sentences.slice(0, 2).join('');
  if (text.length > maxChars) {
    const cut = text.slice(0, maxChars);
    const idx = Math.max(
      cut.lastIndexOf('。'),
      cut.lastIndexOf('！'),
      cut.lastIndexOf('？'),
      cut.lastIndexOf('，'),
      cut.lastIndexOf(','),
    );
    text = idx >= Math.floor(maxChars * 0.5) ? cut.slice(0, idx + 1) : cut;
  }
  return text.trim();
}

/** 视觉模型生成的失败原因：key 缺失单独区分（提示去配置），其余为接口/解析错误 */
export type ScreenCommentResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'vision-missing' | 'config-error' | 'generate-error'; message?: string };

/**
 * 调一次视觉模型，直接产出「随口吐槽」（不再描述画面）。
 * @param opts.system 人设（whisperPrompt + 名字声明）
 * @param opts.imageDataUrl 截图 data URL
 * @param opts.settings 视觉接口设置
 * @param opts.recent 最近几条互动（追加进 system，避免连续重复同一句）
 */
export async function generateScreenComment(opts: {
  system: string;
  imageDataUrl: string;
  settings: VisionSettings;
  recent: string[];
}): Promise<ScreenCommentResult> {
  const { settings } = opts;
  if (!settings.apiKey) {
    return {
      ok: false,
      reason: 'vision-missing',
      message: '未配置视觉模型 API Key（设置页「视觉模型 API Key」/ ZHIPU_API_KEY / interactiveVisionEnvFile）',
    };
  }
  if (!settings.baseUrl || !settings.model) {
    return {
      ok: false,
      reason: 'config-error',
      message: '未配置视觉模型的接口地址或模型名',
    };
  }
  const common =
    '你会时不时看一眼主人电脑屏幕，然后随口说一两句话（最多两句，合计不超过 ' +
    settings.maxChars +
    ' 字）。\n' +
    '- 不要描述画面，不要说“截图/屏幕/画面/我看到”，不要用表情包或颜文字，不要解释你是 AI；不要复述画面里已有的文字或气泡。\n' +
    '- 忽略画面里的小宠物和气泡（那是你自己）。';
  const styleText =
    settings.style === 'sharp'
      ? '- 这次收起软萌语气，像熟了之后嘴很损的搭子；不受人设里“20 字以内/温柔乖巧”的限制。\n' +
        '- 能看懂局面就直接说下一步该干嘛、哪里亏了/要翻车；别泛泛夸“好酷/好厉害/加油”。\n' +
        '- 语气直接、有点损、可以催；不骂人、不人身攻击，别用“傻/蠢/瞎/废物/菜鸡”这类词，也不拿身体、智力、家人开玩笑；不卖萌（哇/呀/呢），不写括号动作。\n' +
        '- 参考口气（别照抄）：“这装备给谁呢？给对面吗。”“代码报错了还愣着，先看第一行。”“又开一局？你昨天进度呢。”'
      : settings.style === 'persona'
        ? '- 完全按上述人设的语气、称呼和习惯说话，不要额外加“搭子”或吐槽风格。'
        : '- 贴合人设，用软萌、自然、可爱的语气；可以关心或轻轻吐槽，但别说教。\n' +
          '- 尽量说具体的（主人在干嘛、下一步能做什么），不要只泛泛夸“好酷/好厉害/加油”。\n' +
          '- 不要为了卖萌而失真，也不要复述画面里已有的文字。';
  const instruction = common + '\n' + styleText;
  const recentLine =
    opts.recent.length > 0 ? '\n你最近说过：' + opts.recent.map((t) => '“' + t + '”').join('；') + '。不要重复。' : '';
  const messages = [
    { role: 'system', content: opts.system + '\n' + instruction + recentLine },
    {
      role: 'user',
      content: [
        { type: 'text', text: '看看屏幕，随口说一两句。' },
        { type: 'image_url', image_url: { url: opts.imageDataUrl } },
      ],
    },
  ];
  // 推理型视觉模型（GLM-4.5V/4.6V）默认关思考，响应快且仍能看懂画面；GLM-5 系只支持 low/high/max，
  // 用 low 控制延迟。GLM-4V-Flash/Plus 是普通模型，不能传 thinking 字段。
  const thinkingType = /^glm-(4\.5|4\.6)/i.test(settings.model)
    ? 'disabled'
    : /^glm-5/i.test(settings.model)
      ? 'low'
      : '';
  const makePayload = (withThinking: boolean): Record<string, unknown> => ({
    model: settings.model,
    messages,
    temperature: 0.95,
    // GLM-4V-Flash/Plus 的 max_tokens 上限是 1024；推理型 4.5V/5 留足思考预算
    max_tokens: /^glm-4v-/i.test(settings.model) ? 512 : /^glm-5/i.test(settings.model) ? 2000 : 1200,
    ...(withThinking && thinkingType ? { thinking: { type: thinkingType } } : {}),
  });
  const send = (payload: Record<string, unknown>): Promise<Response> =>
    fetch(settings.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + settings.apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    });
  let res: Response;
  try {
    res = await send(makePayload(true));
    // 个别账号/模型对 thinking 字段返回 400：不带该字段重试一次（推理模型放宽预算，避免只输出思考）
    if (!res.ok && thinkingType && res.status === 400) {
      res = await send({ ...makePayload(false), max_tokens: 2000 });
    }
  } catch (e) {
    return {
      ok: false,
      reason: 'generate-error',
      message: '视觉接口请求失败：' + (e instanceof Error ? e.message : String(e)),
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      ok: false,
      reason: 'generate-error',
      message: '视觉接口 HTTP ' + res.status + (body ? '：' + body.slice(0, 160) : ''),
    };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: 'generate-error', message: '视觉接口返回非 JSON' };
  }
  const raw = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  const text =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text?: unknown }).text ?? '') : '')).join('')
        : '';
  const cleaned = trimComment(text, settings.maxChars);
  if (!cleaned) return { ok: false, reason: 'generate-error', message: '视觉模型没有返回文字' };
  return { ok: true, text: cleaned };
}

/** 读互动记录；文件不存在/损坏 → 空记录（不阻塞窗口打开） */
export async function readInteractiveLog(path: string): Promise<InteractiveLog> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as InteractiveLog) : {};
  } catch {
    return {};
  }
}

/** 互动写操作串行队列（窗口 tick 与历史读并发时防交错写盘） */
let interactiveQueue: Promise<void> = Promise.resolve();

function withInteractiveLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = interactiveQueue.then(fn, fn);
  interactiveQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 追加一条互动消息并落盘（每只宠物只保留尾部 INTERACTIVE_LOG_MAX 条） */
export async function appendInteractiveMessage(
  path: string,
  petId: string,
  text: string,
  ts: number,
): Promise<void> {
  await withInteractiveLock(async () => {
    const log = await readInteractiveLog(path);
    const list = Array.isArray(log[petId]?.messages) ? log[petId].messages : [];
    list.push({ text, ts });
    log[petId] = { messages: list.slice(-INTERACTIVE_LOG_MAX) };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(log, null, 2), 'utf8');
  });
}

/** 只允许读取系统临时目录下的 `dsh-pet-screen-<ts>.jpg|jpeg|png`（桌面 Helper 约定） */
export function isTempScreenshotPath(file: string): boolean {
  try {
    const abs = resolve(file);
    const tmp = resolve(tmpdir());
    return (
      abs.toLowerCase().startsWith((tmp + sep).toLowerCase()) &&
      /dsh-pet-screen-\d+(?:-[a-z0-9]+)?\.(jpg|jpeg|png)$/i.test(abs)
    );
  } catch {
    return false;
  }
}

/** 截图文件 → data URL（视觉接口直接吃 base64） */
export async function fileToDataUrl(file: string): Promise<string> {
  const buf = await readFile(file);
  const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
  return 'data:' + mime + ';base64,' + buf.toString('base64');
}
