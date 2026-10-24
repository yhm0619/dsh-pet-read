/**
 * 互动碎碎念（host 半侧）：看屏幕 → 让视觉模型随口吐槽一两句 → 交给客户端显示在宠物头顶气泡。
 *
 * 与碎碎念/对话的区别：
 *  - 输入不是用户文字，而是**一张屏幕截图**；因此不走 ctx.llm（DSH 当前的 DeepSeek 文本模型
 *    看不了图），直接调用配置里的 OpenAI 兼容视觉接口（默认智谱 GLM-4V-Flash）；
 *  - 输出限死 1~2 句、`interactiveMaxChars` 字以内，供头顶气泡展示；
 *  - 不配表情包（用户明确要求互动碎碎念不带图）。
 *
 * 安全：截图由桌面 Helper 落到系统临时目录，host 只接受 `dsh-pet-screen-<ts>.jpg` 形式的临时文件，
 * 读完立即删除；key 只从环境变量 / 本地 .env 读取，绝不返回给客户端，也不写日志。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';

/** 视觉接口单次超时（ms）：GLM-4V-Flash 实测 1~5s，60s 足够且不会拖死窗口 */
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
  const apiKey = first(process.env.ZHIPU_API_KEY, process.env.GLM_API_KEY, env.ZHIPU_API_KEY, env.GLM_API_KEY);
  const model = first(
    typeof conf.interactiveVisionModel === 'string' ? conf.interactiveVisionModel : undefined,
    env.ZHIPU_MODEL,
    'glm-4v-flash',
  );
  const baseUrl = first(
    typeof conf.interactiveVisionBaseUrl === 'string' ? conf.interactiveVisionBaseUrl : undefined,
    env.ZHIPU_BASE_URL,
    'https://open.bigmodel.cn/api/paas/v4',
  );
  const rawInterval = Number(conf.interactiveIntervalSec);
  const rawMaxChars = Number(conf.interactiveMaxChars);
  return {
    model,
    baseUrl,
    apiKey,
    maxChars: Number.isFinite(rawMaxChars) ? Math.min(200, Math.max(10, Math.floor(rawMaxChars))) : 60,
    intervalSec: Number.isFinite(rawInterval) ? Math.min(3600, Math.max(5, Math.floor(rawInterval))) : 30,
    envFile,
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
  | { ok: false; reason: 'vision-missing' | 'generate-error'; message?: string };

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
      message: '未配置视觉模型 API Key（ZHIPU_API_KEY / interactiveVisionEnvFile）',
    };
  }
  const instruction =
    '你会时不时看一眼主人电脑屏幕，然后像随口吐槽/关心一样说一两句话（最多两句，合计不超过 ' +
    settings.maxChars +
    ' 字）。语气自然、贴合人设；不要描述画面，不要说“截图/屏幕/画面/我看到”，不要用表情包或颜文字，不要解释你是 AI。';
  const recentLine =
    opts.recent.length > 0 ? '\n你最近说过：' + opts.recent.map((t) => '“' + t + '”').join('；') + '。不要重复。' : '';
  const payload = {
    model: settings.model,
    messages: [
      { role: 'system', content: opts.system + '\n' + instruction + recentLine },
      {
        role: 'user',
        content: [
          { type: 'text', text: '看看屏幕，随口说一两句。' },
          { type: 'image_url', image_url: { url: opts.imageDataUrl } },
        ],
      },
    ],
    temperature: 0.9,
    max_tokens: 200,
  };
  let res: Response;
  try {
    res = await fetch(settings.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + settings.apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    });
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
