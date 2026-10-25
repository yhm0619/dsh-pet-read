#!/usr/bin/env node
import { chmodSync, closeSync, constants, createReadStream, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { downloadArtifact } from "@electron/get";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { z } from "zod";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

//#region src/host/config.ts
/** 位置角落白名单 */
const CORNERS = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right"
];
const CORNER_SET = new Set(CORNERS);
/** display 白名单（导出：宿主路由 POST /pet-display 写单只宠物的显示位置时复用同一份枚举，
*  读写两侧必须同一份规则，不在路由里另写一个 Set） */
const PET_DISPLAYS = [
	"web",
	"desktop",
	"both",
	"none"
];
const PET_DISPLAY_SET = new Set(PET_DISPLAYS);
/** font.family 白名单（预设 id）——**必须与 src/shared/fonts.ts 的 FONT_PRESETS 保持一致**：
*  host 不能 import src/shared（见文件头注释的 DSH 单文件加载约束），这里是那份清单的自包含副本，
*  所以加/删字体预设时两边都要改。 */
const FONT_FAMILY_SET = new Set([
	"candy",
	"yahei",
	"youyuan",
	"kaiti",
	"simsun",
	"comic",
	"system"
]);
/** font.size 合法区间（px，含端点）——与 src/shared/fonts.ts 的 FONT_SIZE_MIN / FONT_SIZE_MAX 同一口径 */
const FONT_SIZE_MIN = 4;
const FONT_SIZE_MAX = 200;
const ID_FORBIDDEN = /[\\/:\x00-\x1f]/;
/**
* 「全局默认 + 种类可覆盖」的顶层字段白名单 —— 用户层（main-config.jsonc）里写下的值会成为
* **所有条目**的默认值；种类文件 `pet/<名>-config.json` 仍可在自己顶层覆盖（写了就用自己那份）。
*
* 判据：这几个是**用户级「成本 / 偏好 / 环境 / 节奏」参数**，不是「这个种类长什么样」——
*   - `chatMemoryRounds`：带多少历史进上下文 = token 成本
*   - `whisperModel` / `chatModel`：碎碎念 / 对话用哪个模型 = 成本与能力偏好
*   - `whisperImageEnabled` / `chatImageEnabled`：要不要把表情包清单附进请求 = token 成本
*   - `chatImageLimit`：对话那张清单**最多几张**——同属 token 成本（清单每条消息都附）
*   - `eventsRefreshSec`：多久调一次模型 / 拉一次余额 = 成本与节奏。注意它内部两个键的**消费端**
*     不同：`.whisper` 按宠物所属条目读（种类可覆盖）；`.balance` 只读 main 条目
*     （余额数据一份 + host 只有一个定时器，架构上给不了每种类一个周期）
*   - `physics`：拖拽抛掷手感；`petCollision` 更是**跨宠物**行为（相撞按动量守恒弹开），
*     按种类分在语义上站不住：两只不同种类的宠物相撞时用谁的系数？
*   - `confineToScreen`：多屏是用户环境 / 使用习惯，不是宠物属性
*   - `font`：字体种类 / 字号 / 是否随宠物缩放是**看的人**的偏好，不是某个种类的属性——
*     同一套字体偏好用在所有宠物（含 pet pack）才符合预期
*
* 不在名单里的顶层字段基座仍是**内置默认**：`whisperPrompt`（人设）、`memes`（表情包）、
* `animations` / `animationWeights`（与素材根绑定）、`workStatusTexts`（文案）——一个种类一份
* 动画池 / 一份人设 / 一个表情包目录，各写一份才是 pet pack 的意义。
*
* 例外：**人设有实例级覆盖**。`pets[].whisperPrompt`（可选）写了就取代所属条目顶层那一份，
* 没写则回落条目——回落本身由消费端做（./persona 的 petPersona），合并不填生效值（见 petPersonaField 注释）。
* 其余实例级字段仍是固定白名单（id/name/size/4 个开关/display/position + whisperPrompt）。
*/
const GLOBAL_DEFAULT_KEYS = [
	"physics",
	"font",
	"confineToScreen",
	"whisperImageEnabled",
	"chatImageEnabled",
	"chatImageLimit",
	"chatMemoryRounds",
	"whisperModel",
	"chatModel",
	"eventsRefreshSec"
];
/** 已告警过的 文件:字段（进程内去重：同一问题只告警一次，避免每请求刷屏；重启重置） */
const warnedKeys = new Set();
function warnOnce(key, message) {
	if (warnedKeys.has(key)) return;
	warnedKeys.add(key);
	console.warn("dsh-pet: " + message);
}
/** 剥除 JSONC 注释（行注释 // 与块注释）得到纯 JSON */
function stripJsonc(src) {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^\\:])\/\/.*$/gm, "$1").trim();
}
/** 读取并解析 JSONC 文件；不存在/解析失败 → undefined（调用方决定处理） */
function readJsonc(path) {
	try {
		const raw = JSON.parse(stripJsonc(readFileSync(path, "utf8")));
		return raw && typeof raw === "object" ? raw : void 0;
	} catch {
		return void 0;
	}
}
function readUserConfig(paths) {
	const file = effectiveUserFile(paths);
	return file ? readJsonc(file) : void 0;
}
function userConfigUnparsable(paths) {
	const file = effectiveUserFile(paths);
	return file !== void 0 && readJsonc(file) === void 0;
}
/** 实际生效的用户层文件：优先 .jsonc；不存在则回落到旧的 .json（迁移前的老用户）；
*  两者都不存在 → undefined（首次使用，无用户层）。 */
function effectiveUserFile(paths) {
	if (existsSync(paths.userFile)) return paths.userFile;
	if (paths.legacyUserFile && existsSync(paths.legacyUserFile)) return paths.legacyUserFile;
	return void 0;
}
function migrateUserConfig(paths, log) {
	const legacy = paths.legacyUserFile;
	if (!legacy || !existsSync(legacy) || existsSync(paths.userFile)) return false;
	try {
		renameSync(legacy, paths.userFile);
	} catch {
		return false;
	}
	log?.(`用户配置已迁移到 JSONC：${legacy} → ${paths.userFile}`);
	return true;
}
/** 扫描 pet/ 目录：<名>-config.(json|jsonc) → 条目（按文件名排序） */
function scanPetFiles(petDir) {
	let entries;
	try {
		entries = readdirSync(petDir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter((e) => e.isFile()).map((e) => e.name).filter((name) => /^.+?-config\.(json|jsonc)$/.test(name)).sort().map((name) => ({
		prefix: name.replace(/-config\.(json|jsonc)$/, ""),
		path: join(petDir, name)
	}));
}
function readPetConfigEntry(paths, entry) {
	const hit = scanPetFiles(paths.petDir).find((f) => f.prefix === entry);
	return hit ? {
		path: hit.path,
		raw: readJsonc(hit.path)
	} : void 0;
}
/** animations 段完整性校验（与旧 assertAnimationsHost 同一套规则；不 throw，非法返回 false） */
function animationsValid(a) {
	if (!a || typeof a !== "object") return false;
	const anims = a;
	for (const key of [
		"idle",
		"turn",
		"drag",
		"clicks"
	]) if (!Array.isArray(anims[key])) return false;
	const moves = anims.moves;
	if (!moves || typeof moves !== "object" || typeof moves.default !== "object" || moves.default === null || !Array.isArray(moves.actions)) return false;
	if (!Array.isArray(anims.categories)) return false;
	const ev = anims.events;
	if (!ev || typeof ev !== "object" || Array.isArray(ev)) return false;
	const evEntries = ev;
	for (const pool of Object.values(evEntries)) {
		if (!Array.isArray(pool) || pool.length === 0) return false;
		for (const slot of pool) if (typeof slot === "string") {
			if (slot.length === 0) return false;
		} else if (Array.isArray(slot)) {
			if (slot.length === 0) return false;
			for (const name of slot) if (typeof name !== "string" || name.length === 0) return false;
		} else return false;
	}
	const balance = evEntries.balance;
	return Array.isArray(balance) && balance.length > 0;
}
/** animationWeights 段校验（idle/turn/move 三个非负数字） */
function weightsValid(w) {
	if (!w || typeof w !== "object") return false;
	const weights = w;
	for (const key of [
		"idle",
		"turn",
		"move"
	]) {
		const v = Number(weights[key]);
		if (!Number.isFinite(v) || v < 0) return false;
	}
	return true;
}
/** physics 段校验：gravity ≥ 0（0 = 无重力，合法）、restitution ∈ [0,1]、groundFriction ≥ 0（均为有限数字）、
*  ceilingBounce 为布尔、throwPower > 0（有限数字）、petCollision 为布尔 */
function physicsValid(value) {
	if (!value || typeof value !== "object") return false;
	const p = value;
	const g = Number(p.gravity);
	const r = Number(p.restitution);
	const f = Number(p.groundFriction);
	const tp = Number(p.throwPower);
	return Number.isFinite(g) && g >= 0 && Number.isFinite(r) && r >= 0 && r <= 1 && Number.isFinite(f) && f >= 0 && typeof p.ceilingBounce === "boolean" && Number.isFinite(tp) && tp > 0 && typeof p.petCollision === "boolean";
}
/** font 段校验：family ∈ 预设白名单、size 为区间内的有限数字、followPet 为布尔。
*  与 physics 同口径：**整段校验**——任一子键缺失/非法即整段非法（告警 + 取默认），
*  不做「缺子键逐个补默认」；对象字段一律整段替换（见文件头合并规则）。 */
function fontValid(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const f = value;
	if (typeof f.family !== "string" || !FONT_FAMILY_SET.has(f.family)) return false;
	const size = Number(f.size);
	if (!Number.isFinite(size) || size < FONT_SIZE_MIN || size > FONT_SIZE_MAX) return false;
	return typeof f.followPet === "boolean";
}
/** whisperModel / chatModel 段校验：{ provider, model } 两个字符串，
*  **要么都留空（= 跟随当前对话的模型）要么都非空**——只填一半（选了服务商没选模型，或反之）
*  会拼出"用 A 家的模型名去问 B 家"这种必然失败的组合，按非法处理（告警 + 取默认）。 */
function modelSelectionValid(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const m = value;
	if (typeof m.provider !== "string" || typeof m.model !== "string") return false;
	return m.provider.trim() === "" === (m.model.trim() === "");
}
/** workStatusTexts 段校验：二维数组——外层每项都是非空字符串数组（档位文案，每档可多句随机）；空数组不可用 */
function workStatusTextsValid(value) {
	if (!Array.isArray(value) || value.length === 0) return false;
	for (const group of value) {
		if (!Array.isArray(group) || group.length === 0) return false;
		for (const text of group) if (typeof text !== "string" || text.length === 0) return false;
	}
	return true;
}
/** 顶层标量字段的合法性（非法与缺失同处理：取默认值 + 告警） */
function topFieldValid(key, value) {
	switch (key) {
		case "whisperPrompt": return typeof value === "string" && value.length > 0;
		case "chatMemoryRounds": {
			const n = Number(value);
			return Number.isFinite(n) && n >= 0;
		}
		case "chatImageLimit": {
			const n = Number(value);
			return Number.isFinite(n) && n >= 0;
		}
		case "notificationsEnabled": return typeof value === "boolean";
		case "whisperImageEnabled": return typeof value === "boolean";
		case "chatImageEnabled": return typeof value === "boolean";
		case "interactiveIntervalSec": {
			const n = Number(value);
			return Number.isFinite(n) && n >= 5 && n <= 3600;
		}
		case "interactiveMaxChars": {
			const n = Number(value);
			return Number.isFinite(n) && n >= 10 && n <= 200;
		}
		case "interactiveVisionModel": return typeof value === "string" && value.trim().length > 0;
		case "interactiveVisionBaseUrl": return typeof value === "string" && /^https?:\/\//.test(value.trim());
		case "interactiveVisionEnvFile": return typeof value === "string";
		case "confineToScreen": return typeof value === "boolean";
		case "animations": return animationsValid(value);
		case "animationWeights": return weightsValid(value);
		case "eventsRefreshSec": return eventsRefreshSecValid(value);
		case "physics": return physicsValid(value);
		case "font": return fontValid(value);
		case "whisperModel":
		case "chatModel": return modelSelectionValid(value);
		case "workStatusTexts": return workStatusTextsValid(value);
		default: return true;
	}
}
/**
* eventsRefreshSec 段校验：事件名 → 间隔秒（正的有限数字）。
*
* 只校验「写下的每个值都合法」，**不**要求键集合与内置默认一致——这个字段和别的顶层字段
* 一样是**整段替换**：缺的键就是缺（消费端各自兜底 1800 / 300），多写的键原样保留
* （不再像旧的逐键深合并那样静默丢弃不认识的键）。空对象合法（等于全走消费端兜底）。
*/
function eventsRefreshSecValid(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	for (const v of Object.values(value)) {
		const n = Number(v);
		if (!Number.isFinite(n) || n <= 0) return false;
	}
	return true;
}
/**
* 文件宠物条目的合并基座：内置默认 + 白名单字段改用**用户层**的值。
*
* 为什么：那 9 个字段是用户级成本/偏好/环境/节奏参数，不是种类属性——用户在设置页改一次，
* 期望所有宠物（含 pet pack）都生效。没有这一步，文件宠物只能拿到内置默认值，
* 于是"设置页写着全局、实际只影响主宠物"（见 GLOBAL_DEFAULT_KEYS 的判据）。
*
* 语义仍是「种类可覆盖」：种类文件顶层写了自己的值 → 走 overlay 覆盖（mergeEntry 负责）。
* 用户层写了但非法的值直接跳过（main 条目那边合并时已告警过一次，这里不再重复刷屏）。
*/
function packBase(base, mainOverlay) {
	if (!mainOverlay) return base;
	let out;
	for (const key of GLOBAL_DEFAULT_KEYS) {
		const own = mainOverlay[key];
		if (own === void 0 || !topFieldValid(key, own)) continue;
		out ??= { ...base };
		out[key] = own;
	}
	return out ?? base;
}
/** 一个覆盖文件 → 完整条目：顶层逐字段合并（没写/非法 → 内置默认 + 告警），pets 逐实例 */
function mergeEntry(base, overlay, label, basePets, seenIds) {
	const out = {};
	for (const key of Object.keys(base)) {
		if (key === "pets") {
			out.pets = mergePets(basePets, overlay?.[key], label, seenIds);
			continue;
		}
		const own = overlay ? overlay[key] : void 0;
		if (own === void 0) {
			out[key] = base[key];
			continue;
		}
		if (!topFieldValid(key, own)) {
			warnOnce(`${label}:${key}`, `「${label}」的 ${key} 非法，已取默认值`);
			out[key] = base[key];
			continue;
		}
		out[key] = own;
	}
	return out;
}
/** pets 数组合并：文件没写/空 → 默认列表；逐实例合并（缺字段 → 内置默认 pets[0]，静默）。 */
function mergePets(basePets, raw, label, seenIds) {
	const basePet = basePets[0] ?? {};
	if (!Array.isArray(raw) || raw.length === 0) {
		warnOnce(`${label}:pets`, `「${label}」的 pets 缺失或为空，已取默认宠物列表`);
		return basePets;
	}
	const out = [];
	for (const item of raw) {
		const pet = mergePet(basePet, item, label, seenIds);
		if (pet) out.push(pet);
	}
	if (out.length === 0) {
		warnOnce(`${label}:pets`, `「${label}」的 pets 全部被跳过（id 非法/重复/冲突），已取默认宠物列表`);
		return basePets;
	}
	return out;
}
/** 宠物实例字段取数字；缺失 → 静默取默认（结构性常态）；显式写但非法 → 告警 + 默认 */
function petNumber(own, def, min, label, field, id) {
	const n = Number(own);
	if (own !== void 0 && own !== null && Number.isFinite(n) && n >= min) return n;
	if (own !== void 0 && own !== null) warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
	return Number(def);
}
/** 宠物实例字段取布尔；缺失 → 静默取默认；显式写但非法 → 告警 + 默认 */
function petBool(own, def, label, field, id) {
	if (typeof own === "boolean") return own;
	if (own !== void 0 && own !== null) warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
	return Boolean(def);
}
/** 宠物实例字段取白名单枚举；缺失 → 静默取默认；显式写但非法 → 告警 + 默认 */
function petEnum(own, set, def, label, field, id) {
	if (typeof own === "string" && set.has(own)) return own;
	if (own !== void 0 && own !== null) warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
	return typeof def === "string" ? def : "";
}
/** 一只实例 → 完成品实例（id 必须自己的且全局唯一；其余字段没写/非法 → 默认 + 告警） */
function mergePet(base, raw, label, seenIds) {
	const p = raw && typeof raw === "object" ? raw : {};
	const id = typeof p.id === "string" ? p.id.trim() : "";
	if (!id || id.length > 64 || ID_FORBIDDEN.test(id) || seenIds.has(id)) {
		warnOnce(`${label}:id:${id || "(空)"}`, `「${label}」的宠物 id「${id || "(空)"}」非法、重复或已存在，已跳过该实例`);
		return null;
	}
	seenIds.add(id);
	const rawName = typeof p.name === "string" ? p.name.trim() : "";
	const name = rawName || id;
	if (!rawName) warnOnce(`${label}:name:${id}`, `宠物「${id}」缺少 name，已按 id 处理`);
	const basePos = base.position && typeof base.position === "object" ? base.position : {};
	const ownPos = p.position && typeof p.position === "object" ? p.position : {};
	return {
		id,
		name,
		size: petNumber(p.size, base.size, 1, label, "size", id),
		balanceEnabled: petBool(p.balanceEnabled, base.balanceEnabled, label, "balanceEnabled", id),
		whisperEnabled: petBool(p.whisperEnabled, base.whisperEnabled, label, "whisperEnabled", id),
		workStatusEnabled: petBool(p.workStatusEnabled, base.workStatusEnabled, label, "workStatusEnabled", id),
		fixedEnabled: petBool(p.fixedEnabled, base.fixedEnabled, label, "fixedEnabled", id),
		display: petEnum(p.display, PET_DISPLAY_SET, base.display, label, "display", id),
		position: {
			corner: petEnum(ownPos.corner, CORNER_SET, basePos.corner, label, "position.corner", id),
			marginX: petNumber(ownPos.marginX, basePos.marginX, -Infinity, label, "position.marginX", id),
			marginY: petNumber(ownPos.marginY, basePos.marginY, -Infinity, label, "position.marginY", id)
		},
		...petPersonaField(p.whisperPrompt, label, id)
	};
}
/**
* 实例级 whisperPrompt 的合并：写了非空字符串 → 原样带出；否则返回空对象（该键不出现）。
* 显式写了非字符串（数字/对象/布尔）才算配置错误 → 告警一次并忽略（回落条目），与 petNumber 同口径。
*/
function petPersonaField(own, label, id) {
	if (typeof own === "string") return own.trim() === "" ? {} : { whisperPrompt: own };
	if (own !== void 0 && own !== null) warnOnce(`${label}:whisperPrompt:${id}`, `宠物「${id}」的 whisperPrompt 非法，已忽略（回落所属条目人设）`);
	return {};
}
function readAllConfig(paths) {
	const base = readJsonc(paths.defaultFile);
	if (!base) throw new Error("dsh-pet: 内置默认配置缺失或解析失败（安装损坏）：" + paths.defaultFile);
	const basePets = Array.isArray(base.pets) ? base.pets : [];
	const seenIds = new Set();
	const out = {};
	const userFile = effectiveUserFile(paths);
	const mainOverlay = userFile ? readJsonc(userFile) : void 0;
	if (userFile && !mainOverlay) warnOnce("file:" + userFile, "用户主配置解析失败，已按无用户配置处理：" + userFile);
	out.main = mergeEntry(base, mainOverlay, "main-config.jsonc", basePets, seenIds);
	const filePetBase = packBase(base, mainOverlay);
	for (const file of scanPetFiles(paths.petDir)) {
		const parsed = readJsonc(file.path);
		if (!parsed) {
			warnOnce("file:" + file.path, "文件宠物配置解析失败，已跳过：" + file.path);
			continue;
		}
		out[file.prefix] = mergeEntry(filePetBase, parsed, file.prefix + "-config.json", basePets, seenIds);
	}
	return out;
}
function flattenPetList(merged) {
	const out = [];
	for (const conf of Object.values(merged)) if (Array.isArray(conf?.pets)) out.push(...conf.pets);
	return out;
}
function findPetInstance(merged, petId) {
	for (const [entry, conf] of Object.entries(merged)) {
		const pets = Array.isArray(conf?.pets) ? conf.pets : [];
		const found = pets.find((p) => String(p.id) === petId);
		if (found) return {
			entry,
			conf,
			pet: found
		};
	}
	return void 0;
}
function saveUserConfig(raw, existing) {
	const o = raw && typeof raw === "object" ? raw : {};
	const arr = Array.isArray(o.pets) ? o.pets : null;
	if (!arr || !arr.length) return null;
	const out = [];
	for (const p of arr) {
		if (!p || typeof p !== "object") return null;
		const pp = p;
		const id = String(pp.id ?? "");
		if (!id || id.length > 64 || ID_FORBIDDEN.test(id)) return null;
		const size = Number(pp.size);
		if (!Number.isFinite(size) || size <= 0) return null;
		let name = typeof pp.name === "string" ? pp.name.trim() : "";
		if (!name) {
			console.warn(`dsh-pet: pet「${id}」缺少 name，已按默认 ${id}（宠物 id）处理`);
			name = id;
		}
		const balanceEnabled = pp.balanceEnabled;
		if (typeof balanceEnabled !== "boolean") return null;
		const whisperEnabled = pp.whisperEnabled;
		if (whisperEnabled !== void 0 && typeof whisperEnabled !== "boolean") return null;
		const workStatusEnabled = pp.workStatusEnabled;
		if (workStatusEnabled !== void 0 && typeof workStatusEnabled !== "boolean") return null;
		const fixedEnabled = pp.fixedEnabled;
		if (fixedEnabled !== void 0 && typeof fixedEnabled !== "boolean") return null;
		const display = String(pp.display ?? "");
		if (!PET_DISPLAY_SET.has(display)) return null;
		const pos = pp.position && typeof pp.position === "object" ? pp.position : {};
		const corner = String(pos.corner ?? "");
		if (!CORNER_SET.has(corner)) return null;
		const marginX = Number(pos.marginX);
		const marginY = Number(pos.marginY);
		if (!Number.isFinite(marginX) || !Number.isFinite(marginY)) return null;
		const rawPersona = pp.whisperPrompt;
		if (rawPersona !== void 0 && rawPersona !== null && typeof rawPersona !== "string") return null;
		const persona = typeof rawPersona === "string" ? rawPersona.trim() : "";
		const pet = {
			id,
			name,
			size,
			balanceEnabled,
			whisperEnabled,
			workStatusEnabled,
			fixedEnabled,
			display,
			position: {
				corner,
				marginX,
				marginY
			}
		};
		if (persona) pet.whisperPrompt = persona;
		out.push(pet);
	}
	const ne = o.notificationsEnabled;
	if (ne !== void 0 && typeof ne !== "boolean") return null;
	const wie = o.whisperImageEnabled;
	if (wie !== void 0 && typeof wie !== "boolean") return null;
	const cie = o.chatImageEnabled;
	if (cie !== void 0 && typeof cie !== "boolean") return null;
	const cts = o.confineToScreen;
	if (cts !== void 0 && typeof cts !== "boolean") return null;
	const ph = o.physics;
	if (ph !== void 0 && !physicsValid(ph)) return null;
	const fo = o.font;
	if (fo !== void 0 && !fontValid(fo)) return null;
	const wm = o.whisperModel;
	if (wm !== void 0 && !modelSelectionValid(wm)) return null;
	const cm = o.chatModel;
	if (cm !== void 0 && !modelSelectionValid(cm)) return null;
	const cmr = o.chatMemoryRounds;
	if (cmr !== void 0 && !topFieldValid("chatMemoryRounds", cmr)) return null;
	const cil = o.chatImageLimit;
	if (cil !== void 0 && !topFieldValid("chatImageLimit", cil)) return null;
	const cleanModel = (v) => ({
		provider: String(v.provider).trim(),
		model: String(v.model).trim()
	});
	const outConfig = { pets: out };
	if (ne !== void 0) outConfig.notificationsEnabled = ne;
	if (wie !== void 0) outConfig.whisperImageEnabled = wie;
	if (cie !== void 0) outConfig.chatImageEnabled = cie;
	if (cts !== void 0) outConfig.confineToScreen = cts;
	if (ph !== void 0) outConfig.physics = ph;
	if (fo !== void 0) outConfig.font = fo;
	if (wm !== void 0) outConfig.whisperModel = cleanModel(wm);
	if (cm !== void 0) outConfig.chatModel = cleanModel(cm);
	if (cmr !== void 0) outConfig.chatMemoryRounds = Number(cmr);
	if (cil !== void 0) outConfig.chatImageLimit = Number(cil);
	const bodyOwned = new Set(["pets"]);
	if (ne !== void 0) bodyOwned.add("notificationsEnabled");
	if (wie !== void 0) bodyOwned.add("whisperImageEnabled");
	if (cie !== void 0) bodyOwned.add("chatImageEnabled");
	if (cts !== void 0) bodyOwned.add("confineToScreen");
	if (ph !== void 0) bodyOwned.add("physics");
	if (fo !== void 0) bodyOwned.add("font");
	if (wm !== void 0) bodyOwned.add("whisperModel");
	if (cm !== void 0) bodyOwned.add("chatModel");
	if (cmr !== void 0) bodyOwned.add("chatMemoryRounds");
	if (cil !== void 0) bodyOwned.add("chatImageLimit");
	if (existing && typeof existing === "object") for (const key of Object.keys(existing)) {
		if (bodyOwned.has(key)) continue;
		outConfig[key] = existing[key];
	}
	return outConfig;
}
function syncUserConfigFromDefault(paths) {
	const raw = readFileSync(paths.defaultFile, "utf8");
	mkdirSync(dirname(paths.userFile), { recursive: true });
	writeFileSync(paths.userFile, raw, "utf8");
}
function sliceMemoryRounds(messages, rounds) {
	return rounds > 0 ? messages.slice(-Math.floor(rounds) * 2) : [];
}

//#endregion
//#region src/host/helper-process.ts
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const defaultHelperMain = resolve(packageRoot, "runtime", "electron-helper", "main.js");
const BRIDGE_PREFIX = "dsh-pet-bridge:";
function resolveElectronPath(candidates = []) {
	const seen = new Set();
	const list = [];
	const push = (value) => {
		if (!value || seen.has(value)) return;
		seen.add(value);
		list.push(value);
	};
	for (const value of candidates) push(value);
	if (process.env.DSH_PET_ELECTRON_PATH) push(process.env.DSH_PET_ELECTRON_PATH);
	try {
		const resolved = require("electron");
		if (typeof resolved === "string" && resolved) push(resolved);
	} catch {}
	push(defaultElectronExe());
	return list.find((value) => existsSync(value));
}
function hasGraphicalDisplay() {
	if (process.platform !== "linux") return true;
	if (process.env.DSH_PET_DESKTOP_FORCE === "1") return true;
	return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
function dshHomeDir() {
	const userProfile = process.env.USERPROFILE || process.env.HOME || "";
	return process.env.DSH_HOME || join(userProfile, ".dsh");
}
/** 当前平台标识（win32 / darwin / linux） */
const PLAT = process.platform;
/** $DSH_HOME/electron 落地目录下，可执行文件的相对路径（按平台） */
const ELECTRON_REL = PLAT === "win32" ? "electron.exe" : PLAT === "darwin" ? join("Electron.app", "Contents", "MacOS", "Electron") : "electron";
function electronLandingDir() {
	return join(dshHomeDir(), "electron");
}
function defaultElectronExe() {
	return join(electronLandingDir(), ELECTRON_REL);
}
async function ensureElectronDownload(options = {}) {
	const version = options.version || process.env.DSH_PET_ELECTRON_VERSION || "43.3.0";
	const mirror = options.mirror || process.env.DSH_PET_ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/";
	const timeoutMs = options.timeoutMs ?? 10 * 60 * 1e3;
	const targetDir = electronLandingDir();
	const exe = defaultElectronExe();
	if (existsSync(exe)) return exe;
	const log = (message) => console.log(`[dsh-pet] ${message}`);
	const warn = (message) => console.warn(`[dsh-pet] ${message}`);
	const startedAt = Date.now();
	log(`Electron not found, downloading v${version} (${PLAT}-${process.arch}) ...`);
	try {
		mkdirSync(targetDir, { recursive: true });
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error(`Electron download timed out after ${timeoutMs}ms`)), timeoutMs);
		timer.unref?.();
		let nextLogAt = Date.now() + 3e3;
		try {
			const zipPath = await downloadArtifact({
				version: `v${version}`,
				artifactName: "electron",
				mirrorOptions: { mirror: mirror.replace(/\/$/, "") + "/" },
				downloadOptions: {
					signal: controller.signal,
					quiet: true,
					getProgressCallback: async (progress) => {
						const now = Date.now();
						if (!progress.total || now < nextLogAt) return;
						nextLogAt = now + 3e3;
						log(`downloading ${(progress.transferred / 1024 / 1024).toFixed(1)}MB / ${(progress.total / 1024 / 1024).toFixed(1)}MB`);
					}
				}
			});
			const seconds = ((Date.now() - startedAt) / 1e3).toFixed(1);
			log(`download complete (${seconds}s), extracting to ${targetDir} ...`);
			const { default: extract } = await import("@electron-internal/extract-zip");
			await extract(zipPath, { dir: targetDir });
			if (!existsSync(exe)) throw new Error(`Electron zip extracted, but ${ELECTRON_REL} not found`);
			const readySeconds = ((Date.now() - startedAt) / 1e3).toFixed(1);
			log(`ready in ${readySeconds}s: ${exe}`);
			return exe;
		} finally {
			clearTimeout(timer);
		}
	} catch (error) {
		warn(`ensure failed: ${error instanceof Error ? error.message : String(error)}`);
		warn("desktop pet unavailable. Set DSH_PET_ELECTRON_PATH to an existing Electron, or retry later.");
		return void 0;
	}
}
function defaultLaunch(options = {}) {
	const electronPath = resolveElectronPath([options.electronPath]);
	if (!electronPath) throw new Error("dsh-pet: cannot resolve Electron executable. Set DSH_PET_ELECTRON_PATH or install electron.");
	const helperPath = options.helperPath || defaultHelperMain;
	return {
		command: electronPath,
		args: [helperPath]
	};
}
const HELPER_STOP_TIMEOUT_MS = 3e3;
const HELPER_STOP_GRACE_MS = 1e3;
function helperSpawnEnv(hostPid, extra) {
	const env = {
		...process.env,
		DSH_PET_HOST_PID: String(hostPid),
		...extra
	};
	delete env.ELECTRON_RUN_AS_NODE;
	return env;
}
var HelperProcess = class {
	constructor(options = {}, logger = console) {
		this.options = options;
		this.logger = logger;
		this.child = void 0;
		this.stopping = false;
		this.restartTimer = void 0;
		this.restartFailures = 0;
		this.lastStartAt = 0;
		this.stdoutBuffer = "";
	}
	start() {
		if (this.child || this.stopping) return this.child;
		this.lastStartAt = Date.now();
		const helperPath = this.options.helperPath || defaultHelperMain;
		const launch = this.options.command ? {
			command: this.options.command,
			args: this.options.args || [helperPath]
		} : defaultLaunch(this.options);
		const command = launch.command;
		const args = this.options.args || launch.args;
		const cwd = this.options.cwd || dshHomeDir();
		mkdirSync(cwd, { recursive: true });
		const child = spawn(command, args, {
			cwd,
			env: helperSpawnEnv(process.pid, this.options.env),
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		this.child = child;
		child.once("error", (error) => {
			this.logger.error?.(`dsh-pet desktop helper failed to start: ${error.message}`);
			if (child.pid === void 0 && this.child === child) {
				this.child = void 0;
				this.scheduleRestart();
			}
		});
		child.once("exit", (code, signal) => {
			if (this.child !== child) return;
			this.child = void 0;
			if (!this.stopping) {
				this.logger.warn?.(`dsh-pet desktop helper exited (code=${String(code)}, signal=${String(signal)}); restarting`);
				this.scheduleRestart();
			}
		});
		child.stdout.on("data", (chunk) => {
			this.onStdoutChunk(String(chunk));
		});
		child.stderr.on("data", (chunk) => {
			const line = String(chunk).trim();
			if (line) this.logger.warn?.(`[dsh-pet desktop helper] ${line}`);
		});
		child.stdin?.on("error", () => {});
		return child;
	}
	/** stdout 按行缓冲：`dsh-pet-bridge:` 前缀整行 = 协议请求，其余 = 日志行 */
	onStdoutChunk(chunk) {
		this.stdoutBuffer += chunk;
		let nl;
		while ((nl = this.stdoutBuffer.indexOf("\n")) >= 0) {
			const line = this.stdoutBuffer.slice(0, nl);
			this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
			const trimmed = line.trim();
			if (!trimmed) continue;
			if (trimmed.startsWith(BRIDGE_PREFIX)) {
				this.handleBridgeLine(trimmed);
				continue;
			}
			this.logger.debug?.(`[dsh-pet desktop helper] ${trimmed}`);
		}
	}
	/** 处理一条协议请求：交给宿主 bridgeHandler，结果按 id POST 回 main.js 的回调服务器
	*  （cb 由请求行携带；不走 stdin —— Electron 主进程收不到 piped stdin） */
	async handleBridgeLine(line) {
		const child = this.child;
		if (!child?.stdin || !this.options.bridgeHandler) return;
		let req;
		try {
			req = JSON.parse(line.slice(BRIDGE_PREFIX.length));
		} catch {
			this.logger.warn?.("[dsh-pet desktop helper] bridge 协议行非法，已忽略");
			return;
		}
		if (typeof req.id !== "number") return;
		try {
			const resp = await this.options.bridgeHandler(req);
			this.sendBridgeResponse(req, resp);
		} catch (e) {
			this.sendBridgeResponse(req, {
				id: req.id,
				status: 500,
				contentType: "application/json; charset=utf-8",
				body: JSON.stringify({ error: `bridge handler error: ${e instanceof Error ? e.message : String(e)}` })
			});
		}
	}
	/** 把应答发回 main.js：优先 POST 到请求行携带的 cb（本地回调服务器）；无 cb 时回写 stdin（低版本兼容） */
	sendBridgeResponse(req, resp) {
		const cb = typeof req.cb === "string" && /^https?:[/][/]/.test(req.cb) ? req.cb : "";
		if (cb) {
			fetch(cb, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(resp)
			}).catch(() => {});
			return;
		}
		const child = this.child;
		if (!child?.stdin || child.stdin.destroyed) return;
		try {
			child.stdin.write(BRIDGE_PREFIX + JSON.stringify(resp) + "\n");
		} catch {}
	}
	/** 停止 helper：发 SIGTERM 即返回，**不等它退出**。宿主退出/插件卸载路径用它——
	*  宿主马上就没了（Windows 有 job 对象、POSIX 有 helper 自己的 host-liveness 兜底，见 issue #56）。
	*  **停止后要立刻重启的场景必须用 stopAndWait()**，否则新旧进程会短暂重叠（issue #64）。 */
	stop(reason = "plugin-disposed") {
		this.stopping = true;
		if (this.restartTimer) clearTimeout(this.restartTimer);
		this.restartTimer = void 0;
		this.logger.debug?.(`dsh-pet desktop helper stopping (${reason})`);
		const child = this.child;
		if (!child) return;
		child.kill();
	}
	/**
	* 停止 helper 并**等它真正退出**（issue #64）：原实现只发一次 SIGTERM 就返回、紧接着 spawn 新进程，
	* 而 Electron 收到 SIGTERM 后关窗、销毁 GPU/动画合成器是异步的（几百 ms 起）——旧窗口（旧大小）
	* 还没消失、新窗口（新大小）已经画出来，桌面上就短暂出现"两只宠物"。
	*   ① 先置 `stopping`（由 stop() 完成）：守护逻辑不得把这次主动停止误判成崩溃去自动重启；
	*   ② 只等 `exit`，**不等 `close`**：stdio 管道关闭远早于进程真正退出（实测 SIGTERM 后 ~10ms 就触发）；
	*   ③ 超时（默认 3s）升级 SIGKILL；SIGKILL 后再给 1s 宽限，仍未退出就放弃等待——
	*      配置保存绝不能因为一个退不掉的子进程而被无限挂住。
	*/
	async stopAndWait(reason = "plugin-disposed", timeoutMs = HELPER_STOP_TIMEOUT_MS) {
		this.stop(reason);
		const child = this.child;
		if (!child) return;
		await waitForChildExit(child, timeoutMs, () => {
			this.logger.warn?.(`dsh-pet desktop helper 未在 ${timeoutMs}ms 内退出，升级 SIGKILL（${reason}）`);
			try {
				child.kill("SIGKILL");
			} catch {}
		});
	}
	scheduleRestart() {
		if (this.restartTimer || this.stopping) return;
		if (helperRunIsStable(Date.now() - this.lastStartAt)) this.restartFailures = 0;
		else this.restartFailures += 1;
		if (shouldCircuitBreak(this.restartFailures, this.resolveMaxFailures())) {
			this.logger.error?.(`dsh-pet desktop helper crashed ${this.restartFailures} consecutive times; circuit breaker tripped, no more restarts. Fix the environment (e.g. DISPLAY/headless) or set DSH_PET_RESTART_MAX_FAILURES to raise the limit.`);
			return;
		}
		const base = this.resolveRestartBaseMs();
		const delay = restartBackoffDelayMs(this.restartFailures - 1, base);
		this.logger.warn?.(`dsh-pet desktop helper exited; restarting in ${Math.round(delay)}ms (attempt ${this.restartFailures}, consecutive-crash limit ${this.resolveMaxFailures()})`);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = void 0;
			this.start();
		}, delay);
		this.restartTimer.unref?.();
	}
	/** 退避基值：DSH_PET_RESTART_BASE_MS（ms，>0）可调，默认 750。 */
	resolveRestartBaseMs() {
		return envPositiveInt(process.env.DSH_PET_RESTART_BASE_MS, RESTART_BASE_MS_DEFAULT);
	}
	/** 熔断阈值：DSH_PET_RESTART_MAX_FAILURES（次，>0）可调，默认 12。 */
	resolveMaxFailures() {
		return envPositiveInt(process.env.DSH_PET_RESTART_MAX_FAILURES, RESTART_MAX_FAILURES_DEFAULT);
	}
};
/**
* 等子进程真正退出（issue #64 的"停止要等干净"那一步）：
*   - 已经退出（exitCode/signalCode 有值）→ 立即 resolve，不挂监听；
*   - 只等 `exit`：`close` 只代表 stdio 管道关闭，远早于进程真正退出；
*   - 到 timeoutMs 调 onTimeout()（调用方升级 SIGKILL），再给 HELPER_STOP_GRACE_MS 宽限；
*   - 宽限到点仍未退出就 resolve——调用方（配置保存触发的重启）绝不能被无限挂住。
*/
function waitForChildExit(child, timeoutMs, onTimeout) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve$1) => {
		let giveUpTimer;
		const done = () => {
			clearTimeout(killTimer);
			if (giveUpTimer) clearTimeout(giveUpTimer);
			child.removeListener("exit", done);
			resolve$1();
		};
		const killTimer = setTimeout(() => {
			onTimeout();
			giveUpTimer = setTimeout(done, HELPER_STOP_GRACE_MS);
			giveUpTimer.unref?.();
		}, timeoutMs);
		killTimer.unref?.();
		child.once("exit", done);
	});
}
const HELPER_STABLE_MS = 3 * 60 * 1e3;
function restartBackoffDelayMs(consecutiveFailures, baseMs = 750) {
	const MAX = 3e4;
	const raw = baseMs * 2 ** Math.max(0, consecutiveFailures);
	return Math.min(raw, MAX);
}
function shouldCircuitBreak(consecutiveFailures, limit = 12) {
	return consecutiveFailures >= limit;
}
function helperRunIsStable(elapsedMs) {
	return elapsedMs >= HELPER_STABLE_MS;
}
/** 退避基值（ms）：默认 750 与旧版首延一致，DSH_PET_RESTART_BASE_MS 可调。 */
const RESTART_BASE_MS_DEFAULT = 750;
/** 熔断阈值（连续崩溃次数）：默认 12，DSH_PET_RESTART_MAX_FAILURES 可调。 */
const RESTART_MAX_FAILURES_DEFAULT = 12;
/** 非负整数 env 解析（非法/未设回落默认），供重启参数读取共用。 */
function envPositiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

//#endregion
//#region src/standalone/shims/dsh-credentials.ts
function credentialRef(ref) {
	return ref;
}

//#endregion
//#region src/host/balance/internal.ts
/**
* 余额查询的**内部工具**（host 侧）：网络策略 + 响应校验 + 金额处理。
*
* 只给 ./providers/* 用。所有服务商共用同一套口径：
* - 网络：20s 超时 + 3 次重试（实测该环境对境外端点间歇性超时）；
* - 校验：必填字段缺失/非法一律 `throw`，**绝不静默当 0**（失败要显式暴露成 fetch-error）；
* - 可选字段：缺失就是缺失（`undefined`），不补默认值。
*/
/** 抓取超时（ms） */
const FETCH_TIMEOUT_MS = 2e4;
/** 单次抓取失败后的重试次数（失败间隔 0.8s 线性退避） */
const RETRIES = 3;
/** fetch 一次，带超时；失败抛错（调用方决定是否重试） */
async function fetchOnce(url, key) {
	return fetch(url, {
		headers: {
			Authorization: "Bearer " + key,
			"User-Agent": "dsh-pet-balance"
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
}
async function fetchWithRetry(url, key) {
	let last;
	for (let i = 0; i <= RETRIES; i++) try {
		return await fetchOnce(url, key);
	} catch (e) {
		last = e;
		if (i < RETRIES) await new Promise((r) => setTimeout(r, 800));
	}
	throw last instanceof Error ? last : new Error(String(last));
}
function num(value, what) {
	const n = Number(value);
	if (!Number.isFinite(n)) throw new Error("dsh-pet: 余额数据非法字段 " + what);
	return n;
}
function str(value, what) {
	if (typeof value !== "string" || value.length === 0) throw new Error("dsh-pet: 余额数据非法字段 " + what);
	return value;
}
function looseNum(value) {
	if (value === void 0 || value === null || value === "") return void 0;
	const n = Number(value);
	return Number.isFinite(n) ? n : void 0;
}
function obj(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
/**
* 重置时间：字符串原样（ISO 8601）；数字时间戳按秒/毫秒自动识别转 ISO；0 / 负数 / 非法 → undefined。
* 真实报文里空闲窗口是 `resetAt: 0`（占位值，不是 1970 年重置）→ 视为「无重置时间」。
*/
function resetTime(value) {
	if (typeof value === "string") return value.length > 0 ? value : void 0;
	const n = looseNum(value);
	if (n === void 0 || n <= 0) return void 0;
	const ms = n < 1e12 ? n * 1e3 : n;
	const d = new Date(ms);
	return Number.isNaN(d.getTime()) ? void 0 : d.toISOString();
}
function readWindow(value) {
	const w = obj(value);
	if (!w) return void 0;
	const used = looseNum(w.used);
	const cap = looseNum(w.cap);
	if (used === void 0 || cap === void 0 || cap <= 0) return void 0;
	return {
		percent: Math.max(0, used / cap * 100),
		capUsd: cap,
		resetsAt: resetTime(w.resetAt)
	};
}
function queryString(params) {
	const pairs = Object.entries(params).filter(([, v]) => v !== void 0);
	return pairs.length > 0 ? "?" + pairs.map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&") : "";
}
function money(value, what) {
	const raw = str(value, what);
	const n = Number(raw);
	if (!Number.isFinite(n)) throw new Error("dsh-pet: 账号余额金额非法 " + what);
	return n.toFixed(2);
}
function sumMoney(a, b) {
	return ((Math.round(Number(a) * 100) + Math.round(Number(b) * 100)) / 100).toFixed(2);
}

//#endregion
//#region src/host/balance/providers/commandcode.ts
/** 控制面基址（`/alpha/*` 固定在根域名） */
const API_BASE = "https://api.commandcode.ai";
/** 滚动窗时长（展示名）：本服务商的 5h 窗口就是 `windowLimits.fiveHour` */
const ROLLING_LABEL$1 = "5h";
/** 抓一次 JSON（GET + Bearer），HTTP 非 2xx 抛错；`label` 是接口路径，只进错误信息（便于自查哪一个失败） */
async function fetchJson(url, key, label) {
	const res = await fetchWithRetry(url, key);
	if (!res.ok) throw new Error("commandcode " + label + " HTTP " + res.status);
	return await res.json();
}
function parseCommandCode(creditsBody, subscriptionBody, summaryBody, provider) {
	const root = obj(creditsBody);
	const credits = obj(root?.credits);
	if (!credits) throw new Error("dsh-pet: commandcode 响应缺少 credits");
	const creditFields = [
		credits.monthlyCredits,
		credits.purchasedCredits,
		credits.freeCredits
	];
	if (creditFields.every((v) => looseNum(v) === void 0)) throw new Error("dsh-pet: commandcode credits 响应缺少额度字段");
	const remaining = creditFields.reduce((sum, v) => sum + Math.max(0, looseNum(v) ?? 0), 0);
	const summary = obj(summaryBody);
	const spentRaw = summary?.totalCost;
	if (spentRaw === void 0 || spentRaw === null) throw new Error("dsh-pet: commandcode usage 响应缺少 totalCost");
	const spent = Math.max(0, num(spentRaw, "totalCost"));
	const pool = spent + remaining;
	const data = { monthly: pool > 0 ? spent / pool * 100 : 0 };
	if (pool > 0) data.monthlyCapUsd = pool;
	const subscription = obj(obj(subscriptionBody)?.data);
	const periodEnd = subscription?.currentPeriodEnd;
	if (typeof periodEnd === "string" && periodEnd.length > 0) data.monthlyResetsAt = periodEnd;
	const limits = obj(root?.windowLimits) ?? obj(credits.windowLimits);
	if (limits?.limited === true) {
		const fiveHour = readWindow(limits.fiveHour);
		if (fiveHour) {
			data.rolling = fiveHour.percent;
			data.rollingCapUsd = fiveHour.capUsd;
			data.rollingLabel = ROLLING_LABEL$1;
			if (fiveHour.resetsAt) data.rollingResetsAt = fiveHour.resetsAt;
		}
		const weekly = readWindow(limits.weekly);
		if (weekly) {
			data.weekly = weekly.percent;
			data.weeklyCapUsd = weekly.capUsd;
			if (weekly.resetsAt) data.weeklyResetsAt = weekly.resetsAt;
		}
	}
	return {
		ok: true,
		provider,
		shape: "windows",
		data
	};
}
const commandCode = {
	id: "commandcode",
	credential: {
		mode: "ref",
		ref: "COMMANDCODE_API_KEY"
	},
	async fetch({ key, provider }) {
		const whoami = obj(await fetchJson(API_BASE + "/alpha/whoami" + queryString({ limits: "1" }), key, "/alpha/whoami"));
		const org = obj(whoami?.org);
		const orgId = typeof org?.id === "string" && org.id.length > 0 ? org.id : void 0;
		const credits = await fetchJson(API_BASE + "/alpha/billing/credits" + queryString({ orgId }), key, "/alpha/billing/credits");
		let subscription;
		try {
			subscription = await fetchJson(API_BASE + "/alpha/billing/subscriptions" + queryString({ orgId }), key, "/alpha/billing/subscriptions");
		} catch {
			subscription = void 0;
		}
		const periodStart = obj(obj(subscription)?.data)?.currentPeriodStart;
		const summary = await fetchJson(API_BASE + "/alpha/usage/summary" + queryString({
			since: typeof periodStart === "string" ? periodStart : void 0,
			orgId
		}), key, "/alpha/usage/summary");
		return parseCommandCode(credits, subscription, summary, provider);
	}
};

//#endregion
//#region src/host/balance/deepseek-common.ts
const DEEPSEEK_FULL_BALANCE = {
	CNY: "20",
	USD: "5"
};
function deepseekFullBalance(currency) {
	return DEEPSEEK_FULL_BALANCE[currency];
}
function deepseekPricingTier(now = new Date()) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "Asia/Shanghai",
		weekday: "short",
		hour: "2-digit",
		hourCycle: "h23"
	}).formatToParts(now);
	const pick = (type) => parts.find((p) => p.type === type)?.value;
	const weekday = pick("weekday");
	const hour = Number(pick("hour"));
	if (weekday === "Sat" || weekday === "Sun") return "idle";
	return hour >= 9 && hour < 12 || hour >= 14 && hour < 18 ? "peak" : "idle";
}

//#endregion
//#region src/host/balance/providers/deepseek-account.ts
function parseAccountBalance(snapshot, provider) {
	if (!snapshot) throw new Error("dsh-pet: 账号未登录（deepseek-account）");
	if (snapshot.status !== "ready") throw new Error("dsh-pet: 账号余额查询失败");
	const wallets = Array.isArray(snapshot.value) ? snapshot.value : [];
	if (wallets.length === 0) throw new Error("dsh-pet: 账号没有充值钱包余额");
	const candidates = wallets.map((w) => obj(w)).filter((w) => w !== void 0);
	if (candidates.length === 0) throw new Error("dsh-pet: 账号钱包结构非法");
	const toppedUpBy = new Map();
	for (const w of candidates) {
		const currency = typeof w.currency === "string" && w.currency.length > 0 ? w.currency : "CNY";
		const amount = money(w.balance, "balance");
		const prev = toppedUpBy.get(currency);
		toppedUpBy.set(currency, prev === void 0 ? amount : sumMoney(prev, amount));
	}
	const grantedBy = new Map();
	for (const raw of Array.isArray(snapshot.bonusWallets) ? snapshot.bonusWallets : []) {
		const w = obj(raw);
		if (!w || typeof w.currency !== "string" || w.currency.length === 0) continue;
		const amount = money(w.balance, "bonus balance");
		const prev = grantedBy.get(w.currency);
		grantedBy.set(w.currency, prev === void 0 ? amount : sumMoney(prev, amount));
	}
	for (const currency of grantedBy.keys()) if (!toppedUpBy.has(currency)) toppedUpBy.set(currency, "0.00");
	const walletsOut = [...toppedUpBy.entries()].map(([currency, toppedUp]) => {
		const granted = grantedBy.get(currency) ?? "0.00";
		const fullBalance = deepseekFullBalance(currency);
		return {
			currency,
			total: sumMoney(granted, toppedUp),
			granted,
			toppedUp,
			...fullBalance === void 0 ? {} : { fullBalance }
		};
	});
	return {
		ok: true,
		provider,
		shape: "money",
		data: {
			wallets: walletsOut,
			tier: deepseekPricingTier()
		}
	};
}
const deepseekAccount = {
	id: "deepseek-account",
	credential: { mode: "none" },
	async fetch({ provider, resolveAccount }) {
		if (!resolveAccount) throw new Error("dsh-pet: 缺少账号服务（" + provider + "）");
		return parseAccountBalance(await resolveAccount(), provider);
	}
};

//#endregion
//#region src/host/balance/providers/deepseek-official.ts
const deepseekOfficial = {
	id: "deepseek-official",
	credential: {
		mode: "ref",
		ref: "DEEPSEEK_API_KEY"
	},
	async fetch({ key, provider }) {
		const res = await fetchWithRetry("https://api.deepseek.com/user/balance", key);
		if (!res.ok) throw new Error("deepseek balance HTTP " + res.status);
		const body = await res.json();
		const infos = body?.balance_infos;
		if (!Array.isArray(infos) || infos.length === 0) throw new Error("dsh-pet: deepseek balance 响应缺少 balance_infos");
		const wallets = infos.map((raw) => {
			const w = obj(raw) ?? {};
			const currency = str(w.currency, "currency");
			const fullBalance = deepseekFullBalance(currency);
			return {
				currency,
				total: str(w.total_balance, "total_balance"),
				granted: str(w.granted_balance, "granted_balance"),
				toppedUp: str(w.topped_up_balance, "topped_up_balance"),
				...fullBalance === void 0 ? {} : { fullBalance }
			};
		});
		return {
			ok: true,
			provider,
			shape: "money",
			data: {
				wallets,
				tier: deepseekPricingTier()
			}
		};
	}
};

//#endregion
//#region src/host/balance/providers/opencode-go.ts
/** 各窗口满额度金额（USD）。业务常量：12 = 5h（5 小时滚动窗口）、30 = 周、60 = 月 */
const QUOTA_USD = {
	rolling: 12,
	weekly: 30,
	monthly: 60
};
/** 滚动窗时长（展示名）：本服务商是 5 小时 */
const ROLLING_LABEL = "5h";
const opencodeGo = {
	id: "opencode-go",
	credential: {
		mode: "ref",
		ref: "OPENCODE_GO_API_KEY"
	},
	async fetch({ key, provider }) {
		const res = await fetchWithRetry("https://opencode.ai/zen/go/v1/usage", key);
		if (!res.ok) throw new Error("opencode usage HTTP " + res.status);
		const body = await res.json();
		const usage = body?.usage;
		if (!usage || typeof usage !== "object") throw new Error("dsh-pet: opencode usage 响应缺少 usage");
		const u = usage;
		const rolling = u.rolling, weekly = u.weekly, monthly = u.monthly;
		if (!rolling || !weekly || !monthly) throw new Error("dsh-pet: opencode usage 响应缺少窗口");
		return {
			ok: true,
			provider,
			shape: "windows",
			data: {
				rolling: num(rolling.percent, "rolling.percent"),
				weekly: num(weekly.percent, "weekly.percent"),
				monthly: num(monthly.percent, "monthly.percent"),
				rollingCapUsd: QUOTA_USD.rolling,
				weeklyCapUsd: QUOTA_USD.weekly,
				monthlyCapUsd: QUOTA_USD.monthly,
				rollingLabel: ROLLING_LABEL,
				rollingResetsAt: str(rolling.resetsAt, "rolling.resetsAt"),
				weeklyResetsAt: str(weekly.resetsAt, "weekly.resetsAt"),
				monthlyResetsAt: str(monthly.resetsAt, "monthly.resetsAt")
			}
		};
	}
};

//#endregion
//#region src/host/balance/registry.ts
const BUILTIN_PROVIDERS = [
	opencodeGo,
	commandCode,
	deepseekOfficial,
	deepseekAccount
];
/** 第三方运行时注册：provider id → 定义。 */
const external = new Map();
function registerBalanceProvider(def) {
	if (!def || typeof def !== "object") throw new TypeError("provider 定义必须是对象");
	if (typeof def.id !== "string" || def.id.length === 0) throw new TypeError("id 必须是非空字符串");
	if (typeof def.fetch !== "function") throw new TypeError("fetch 必须是函数");
	if (BUILTIN_PROVIDERS.some((p) => p.id === def.id)) throw new Error("不能覆盖内置服务商: " + def.id);
	if (external.has(def.id)) throw new Error("该服务商 id 已被注册: " + def.id);
	external.set(def.id, def);
	return () => {
		if (external.get(def.id) === def) external.delete(def.id);
	};
}
function listBalanceProviders() {
	return {
		builtin: BUILTIN_PROVIDERS.map((p) => p.id),
		external: [...external.keys()]
	};
}
function matchBalanceProvider(provider) {
	return BUILTIN_PROVIDERS.find((p) => p.id === provider) ?? external.get(provider);
}

//#endregion
//#region src/host/balance/index.ts
/**
* 失败结果（三种 reason 一个出口，避免各处手写字段）。
* `message` 缺省时**不写这个键** —— 叶子的形状是对外契约，多一个 `undefined` 键会让
* `deepStrictEqual` 一类的严格比对失败（消费端也按「有/无」判断）。
*/
function failed(provider, reason, message) {
	return message === void 0 ? {
		ok: false,
		provider,
		reason
	} : {
		ok: false,
		provider,
		reason,
		message
	};
}
/** provider 取数抛错 → 统一的 `fetch-error` 结果（内置与第三方同一口径）。 */
function fetchFailed(provider, e) {
	return failed(provider, "fetch-error", e instanceof Error ? e.message : String(e));
}
async function queryBalance(provider, resolveKey, resolveAccount) {
	const def = matchBalanceProvider(provider);
	if (!def) return failed(provider, "unsupported");
	if (!("credential" in def)) try {
		return await def.fetch({ provider });
	} catch (e) {
		return fetchFailed(provider, e);
	}
	let key = "";
	if (def.credential.mode === "ref") {
		const resolved = await resolveKey(def.credential.ref);
		if (!resolved) return failed(provider, "credential-missing", "缺少凭证 " + def.credential.ref);
		key = resolved;
	} else if (!resolveAccount) return failed(provider, "credential-missing", "缺少账号服务（" + provider + "）");
	try {
		return await def.fetch({
			provider,
			key,
			resolveAccount
		});
	} catch (e) {
		return fetchFailed(provider, e);
	}
}

//#endregion
//#region src/standalone/shims/dsh-llm.ts
function createUserMessage(input) {
	return {
		role: "user",
		content: input.content,
		source: input.source
	};
}
function createAssistantMessage(input) {
	return {
		role: "assistant",
		content: input.content,
		source: input.source
	};
}
var BlockAssembler = class {
	chunks = [];
	/** 收集一个块；非文本块（工具调用等）在独立模式下被忽略 */
	push(chunk) {
		if (chunk !== null && typeof chunk === "object" && chunk.type === "text") {
			const text = chunk.text;
			if (typeof text === "string") this.chunks.push(text);
		}
	}
	/** 当前已拼装的块列表 */
	blocks() {
		const text = this.chunks.join("");
		return text === "" ? [] : [{
			type: "text",
			text
		}];
	}
};
function ReasoningEffortId(id) {
	return id;
}

//#endregion
//#region src/host/llm-call.ts
const PET_CALL_IDENTITY = "dsh-pet";
function noTextReason(finish) {
	const { kind, failure } = finish ?? {};
	if (kind === "aborted") return "生成已取消";
	if (kind === "max-tokens") return "输出达到上限，未产出正文";
	if (kind !== "error") return "模型未返回文本";
	const { message, code } = failure ?? {};
	if (typeof message === "string" && message.trim() !== "") return message;
	if (typeof code === "string" && code.trim() !== "") return code;
	return "未提供失败原因";
}

//#endregion
//#region src/host/llm-reasoning.ts
async function supportsReasoningOff(ctx, provider, model) {
	const llm = ctx.llm;
	if (!llm || typeof llm.resolveModelInfo !== "function") return false;
	try {
		const info = await llm.resolveModelInfo(provider, model);
		return info?.reasoning?.efforts?.some((e) => e.id === "off") ?? false;
	} catch {
		return false;
	}
}

//#endregion
//#region src/host/model-selection.ts
function configuredModel(conf, key) {
	const raw = conf?.[key];
	if (!raw || typeof raw !== "object") return void 0;
	const m = raw;
	if (typeof m.provider !== "string" || typeof m.model !== "string") return void 0;
	const provider = m.provider.trim();
	const model = m.model.trim();
	return provider && model ? {
		provider,
		model
	} : void 0;
}
function currentModel(ctx) {
	try {
		const sel = ctx.agentDefaultModel?.currentSelection();
		return sel?.provider && sel?.model ? {
			provider: sel.provider,
			model: sel.model
		} : void 0;
	} catch {
		return void 0;
	}
}
function modelCandidates(ctx, preferred) {
	const out = [];
	const push = (m) => {
		if (!m) return;
		if (out.some((x) => x.provider === m.provider && x.model === m.model)) return;
		out.push(m);
	};
	push(preferred);
	push(currentModel(ctx));
	return out;
}
function modelLabel(m) {
	return m.provider + "/" + m.model;
}

//#endregion
//#region src/host/whisper.ts
/** 单次生成超时（ms）：骈骈念不需要长输出，30s 足够 */
const TIMEOUT_MS$1 = 3e4;
/** 碎碎念指令：纯文本（原行为） */
const USER_TEXT = "随便说一句日常碎碎念，一句就好，20 字以内。";
/**
* 碎碎念指令：带表情包（用户开启 whisperImageEnabled 时）——要求模型配合作画说一句。
* 明确「正文仍是一句话」：图是配图，不是让模型描述画面本身。
*/
function userTextWithMeme(meme) {
	return "随便说一句日常碎碎念，一句就好，20 字以内。\n这次会配一张表情包一起显示，图的内容是：" + meme.name + "（" + meme.desc + "）。\n请让这句话和这张图的情绪/场景自然契合，像是配合画面说出来的；不要描述画面本身。";
}
async function generateWhisper(ctx, system, meme, preferred) {
	const candidates = modelCandidates(ctx, preferred);
	if (candidates.length === 0) return {
		ok: false,
		reason: "provider-missing",
		message: "当前对话未配置模型"
	};
	const llm = ctx.llm;
	if (!llm || typeof llm.stream !== "function") return {
		ok: false,
		reason: "generate-error",
		message: "LLM 服务不可用"
	};
	let last = {
		ok: false,
		reason: "generate-error",
		message: noTextReason(void 0)
	};
	for (const [i, sel] of candidates.entries()) {
		const result = await generateWith$1(ctx, llm, sel, system, meme);
		if (result.ok) return result;
		last = result;
		if (i + 1 < candidates.length) console.warn(`dsh-pet: 碎碎念用 ${modelLabel(sel)} 生成失败（${result.message ?? result.reason}），回落到 ${modelLabel(candidates[i + 1])}`);
	}
	return last;
}
/** 用**一个**确定的 provider/model 跑一次生成（候选链的一环；失败原样返回结构化原因，不吞） */
async function generateWith$1(ctx, llm, sel, system, meme) {
	const deadline = AbortSignal.timeout(TIMEOUT_MS$1);
	const supportsOff = await supportsReasoningOff(ctx, sel.provider, sel.model);
	const options = {
		provider: sel.provider,
		model: sel.model,
		sessionId: PET_CALL_IDENTITY,
		messages: [createUserMessage({
			content: [{
				type: "text",
				text: meme ? userTextWithMeme(meme) : USER_TEXT
			}],
			source: { kind: "user" }
		})],
		system,
		temperature: 1,
		...supportsOff ? { reasoningEffort: ReasoningEffortId("off") } : {},
		signal: deadline
	};
	const assembler = new BlockAssembler();
	try {
		for await (const chunk of llm.stream(options)) assembler.push(chunk);
	} catch (e) {
		return {
			ok: false,
			reason: "generate-error",
			message: e instanceof Error ? e.message : String(e)
		};
	}
	const text = assembler.blocks().filter((b) => b.type === "text").map((b) => "text" in b ? b.text : "").join("").trim();
	if (!text) return {
		ok: false,
		reason: "generate-error",
		message: noTextReason(assembler.finish)
	};
	return meme ? {
		ok: true,
		text,
		image: meme.name
	} : {
		ok: true,
		text
	};
}

//#endregion
//#region src/host/whisper-policy.ts
function automaticWhisperSchedule(policy, petEnabled, configuredPeriodSec) {
	if (!policy) return {
		enabled: petEnabled,
		periodSec: configuredPeriodSec
	};
	const period = policy.whisperIntervalSec();
	return {
		enabled: petEnabled && policy.isReady() && policy.canWhisper(),
		periodSec: Number.isFinite(period) ? Math.max(60, period) : 300
	};
}

//#endregion
//#region src/host/memes.ts
function readMemePool(memes, dirs) {
	if (!memes || typeof memes !== "object" || Array.isArray(memes)) return [];
	if (dirs.length === 0) return [];
	const out = [];
	for (const [name, desc] of Object.entries(memes)) {
		const text = typeof desc === "string" ? desc.trim() : "";
		if (!name || !text) continue;
		if (!dirs.some((dir) => existsSync(join(dir, name + ".png")))) continue;
		out.push({
			name,
			desc: text
		});
	}
	return out;
}
function pickMeme(pool, random = Math.random) {
	if (pool.length === 0) return void 0;
	const idx = Math.floor(random() * pool.length) % pool.length;
	return pool[idx];
}
function matchMeme(pool, name) {
	const key = String(name ?? "").trim();
	return key ? pool.find((m) => m.name === key) : void 0;
}
/** 配图选择标记：`[图:名称]` 附在回复末尾（容忍全角冒号与前后空白） */
const IMG_TAG = /\[图[:：]\s*([^\]\n]+?)\s*\]\s*$/;
function extractChatImage(text, pool) {
	const m = IMG_TAG.exec(text);
	if (!m) return { text };
	const hit = matchMeme(pool, m[1] ?? "");
	const body = text.slice(0, m.index).trim();
	if (!hit || !body) return { text };
	return {
		text: body,
		image: hit.name
	};
}
function memeCatalog(pool) {
	return pool.map((m) => "- " + m.name + "：" + m.desc).join("\n");
}
function limitPool(pool, limit) {
	const n = Math.floor(Number(limit));
	if (!Number.isFinite(n) || n <= 0) return pool;
	return pool.slice(0, n);
}

//#endregion
//#region src/host/chat.ts
/** 单次生成超时（ms）：对话等 LLM 回复，60s 足够 */
const TIMEOUT_MS = 6e4;
/** 配图指令：附在 user 正文之后（紧邻回答位置，模型更容易遵守） */
function imageInstruction(pool) {
	return "\n\n[配图] 回复结尾可选附一张表情包给用户看，从下列清单里挑最贴合当前语境的：\n" + memeCatalog(pool) + "\n挑中就在回复最后另起一行写 [图:名称]（名称原样照抄）；没有合适的就完全不要写这个标记。";
}
async function generateChat(ctx, system, history, userText, pool = [], preferred) {
	const candidates = modelCandidates(ctx, preferred);
	if (candidates.length === 0) return {
		ok: false,
		reason: "provider-missing",
		message: "当前对话未配置模型"
	};
	const llm = ctx.llm;
	if (!llm || typeof llm.stream !== "function") return {
		ok: false,
		reason: "generate-error",
		message: "LLM 服务不可用"
	};
	let last = {
		ok: false,
		reason: "generate-error",
		message: noTextReason(void 0)
	};
	for (const [i, sel] of candidates.entries()) {
		const result = await generateWith(ctx, llm, sel, system, history, userText, pool);
		if (result.ok) return result;
		last = result;
		if (i + 1 < candidates.length) console.warn(`dsh-pet: 对话用 ${modelLabel(sel)} 生成失败（${result.message ?? result.reason}），回落到 ${modelLabel(candidates[i + 1])}`);
	}
	return last;
}
/** 用**一个**确定的 provider/model 跑一次对话生成（候选链的一环；失败原样返回结构化原因，不吞） */
async function generateWith(ctx, llm, sel, system, history, userText, pool) {
	const historyMessages = history.map((m) => m.role === "user" ? createUserMessage({
		content: [{
			type: "text",
			text: m.content
		}],
		source: { kind: "user" }
	}) : createAssistantMessage({
		content: [{
			type: "text",
			text: m.content
		}],
		source: {
			provider: sel.provider,
			model: sel.model
		}
	}));
	const deadline = AbortSignal.timeout(TIMEOUT_MS);
	const supportsOff = await supportsReasoningOff(ctx, sel.provider, sel.model);
	const wantImage = pool.length > 0;
	const options = {
		provider: sel.provider,
		model: sel.model,
		sessionId: PET_CALL_IDENTITY,
		messages: [...historyMessages, createUserMessage({
			content: [{
				type: "text",
				text: wantImage ? userText + imageInstruction(pool) : userText
			}],
			source: { kind: "user" }
		})],
		system,
		temperature: 1,
		...supportsOff ? { reasoningEffort: ReasoningEffortId("off") } : {},
		signal: deadline
	};
	const assembler = new BlockAssembler();
	try {
		for await (const chunk of llm.stream(options)) assembler.push(chunk);
	} catch (e) {
		return {
			ok: false,
			reason: "generate-error",
			message: e instanceof Error ? e.message : String(e)
		};
	}
	const text = assembler.blocks().filter((b) => b.type === "text").map((b) => "text" in b ? b.text : "").join("").trim();
	if (!text) return {
		ok: false,
		reason: "generate-error",
		message: noTextReason(assembler.finish)
	};
	if (!wantImage) return {
		ok: true,
		text
	};
	const picked = extractChatImage(text, pool);
	return picked.image ? {
		ok: true,
		text: picked.text,
		image: picked.image
	} : {
		ok: true,
		text: picked.text
	};
}

//#endregion
//#region src/host/interactive.ts
/** 视觉接口单次超时（ms）：GLM-4.5V 关思考实测 2~4s，60s 足够且不会拖死窗口 */
const VISION_TIMEOUT_MS = 6e4;
const INTERACTIVE_LOG_MAX = 40;
function parseEnvText(raw) {
	const out = {};
	for (const line of raw.split(/\r?\n/)) {
		const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!m) continue;
		out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
	}
	return out;
}
async function resolveVisionSettings(conf) {
	const envFile = typeof conf.interactiveVisionEnvFile === "string" ? conf.interactiveVisionEnvFile.trim() : "";
	let env = {};
	if (envFile) try {
		env = parseEnvText(await readFile(envFile, "utf8"));
	} catch {}
	const first = (...vals) => {
		for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
		return "";
	};
	const apiKey = first(process.env.ZHIPU_API_KEY, process.env.GLM_API_KEY, env.ZHIPU_API_KEY, env.GLM_API_KEY);
	const model = first(typeof conf.interactiveVisionModel === "string" ? conf.interactiveVisionModel : void 0, env.ZHIPU_MODEL, "glm-4.5v");
	const baseUrl = first(typeof conf.interactiveVisionBaseUrl === "string" ? conf.interactiveVisionBaseUrl : void 0, env.ZHIPU_BASE_URL, "https://open.bigmodel.cn/api/paas/v4");
	const rawInterval = Number(conf.interactiveIntervalSec);
	const rawMaxChars = Number(conf.interactiveMaxChars);
	return {
		model,
		baseUrl,
		apiKey,
		maxChars: Number.isFinite(rawMaxChars) ? Math.min(200, Math.max(10, Math.floor(rawMaxChars))) : 60,
		intervalSec: Number.isFinite(rawInterval) ? Math.min(3600, Math.max(5, Math.floor(rawInterval))) : 30,
		envFile
	};
}
function trimComment(input, maxChars) {
	let text = String(input ?? "").replace(/\r/g, "").replace(/\n+/g, " ").trim();
	text = text.replace(/^[\s"'“”‘’「」]+/, "").replace(/[\s"'“”‘’「」]+$/, "");
	const sentences = (text.match(/[^。！？!?]*[。！？!?]?/g) ?? []).map((s) => s.trim()).filter(Boolean);
	if (sentences.length > 2) text = sentences.slice(0, 2).join("");
	if (text.length > maxChars) {
		const cut = text.slice(0, maxChars);
		const idx = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"), cut.lastIndexOf("，"), cut.lastIndexOf(","));
		text = idx >= Math.floor(maxChars * .5) ? cut.slice(0, idx + 1) : cut;
	}
	return text.trim();
}
async function generateScreenComment(opts) {
	const { settings } = opts;
	if (!settings.apiKey) return {
		ok: false,
		reason: "vision-missing",
		message: "未配置视觉模型 API Key（ZHIPU_API_KEY / interactiveVisionEnvFile）"
	};
	const instruction = "你会时不时看一眼主人电脑屏幕，像个嘴很快、懂行的搭子，随口吐槽或支招（最多两句，合计不超过 " + settings.maxChars + " 字）。\n- 这次收起软萌语气，像熟了之后嘴很损的搭子；不受人设里“20 字以内/温柔乖巧”的限制。\n- 能看懂局面就直接说下一步该干嘛、哪里亏了/要翻车；别泛泛夸“好酷/好厉害/加油”。\n- 语气直接、有点损、可以催；不骂人、不人身攻击，别用“傻/蠢/瞎/废物/菜鸡”这类词，也不拿身体、智力、家人开玩笑；不卖萌（哇/呀/呢），不写括号动作。\n- 不要描述画面，不要说“截图/屏幕/画面/我看到”，不要用表情包或颜文字，不要解释你是 AI；不要复述画面里已有的文字或气泡。\n- 忽略画面里的小宠物和气泡（那是你自己）。\n- 参考口气（别照抄）：“这装备给谁呢？给对面吗。”“代码报错了还愣着，先看第一行。”“又开一局？你昨天进度呢。”";
	const recentLine = opts.recent.length > 0 ? "\n你最近说过：" + opts.recent.map((t) => "“" + t + "”").join("；") + "。不要重复。" : "";
	const messages = [{
		role: "system",
		content: opts.system + "\n" + instruction + recentLine
	}, {
		role: "user",
		content: [{
			type: "text",
			text: "看看屏幕，随口说一两句。"
		}, {
			type: "image_url",
			image_url: { url: opts.imageDataUrl }
		}]
	}];
	const thinkingType = /^glm-(4\.5|4\.6)/i.test(settings.model) ? "disabled" : /^glm-5/i.test(settings.model) ? "low" : "";
	const makePayload = (withThinking) => ({
		model: settings.model,
		messages,
		temperature: .95,
		max_tokens: /^glm-4v-/i.test(settings.model) ? 512 : /^glm-5/i.test(settings.model) ? 2e3 : 1200,
		...withThinking && thinkingType ? { thinking: { type: thinkingType } } : {}
	});
	const send = (payload) => fetch(settings.baseUrl.replace(/\/$/, "") + "/chat/completions", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: "Bearer " + settings.apiKey
		},
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(VISION_TIMEOUT_MS)
	});
	let res;
	try {
		res = await send(makePayload(true));
		if (!res.ok && thinkingType && res.status === 400) res = await send({
			...makePayload(false),
			max_tokens: 2e3
		});
	} catch (e) {
		return {
			ok: false,
			reason: "generate-error",
			message: "视觉接口请求失败：" + (e instanceof Error ? e.message : String(e))
		};
	}
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		return {
			ok: false,
			reason: "generate-error",
			message: "视觉接口 HTTP " + res.status + (body ? "：" + body.slice(0, 160) : "")
		};
	}
	let data;
	try {
		data = await res.json();
	} catch {
		return {
			ok: false,
			reason: "generate-error",
			message: "视觉接口返回非 JSON"
		};
	}
	const raw = data?.choices?.[0]?.message?.content;
	const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((p) => p && typeof p === "object" && "text" in p ? String(p.text ?? "") : "").join("") : "";
	const cleaned = trimComment(text, settings.maxChars);
	if (!cleaned) return {
		ok: false,
		reason: "generate-error",
		message: "视觉模型没有返回文字"
	};
	return {
		ok: true,
		text: cleaned
	};
}
async function readInteractiveLog(path) {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}
/** 互动写操作串行队列（窗口 tick 与历史读并发时防交错写盘） */
let interactiveQueue = Promise.resolve();
function withInteractiveLock(fn) {
	const run$1 = interactiveQueue.then(fn, fn);
	interactiveQueue = run$1.then(() => void 0, () => void 0);
	return run$1;
}
async function appendInteractiveMessage(path, petId, text, ts) {
	await withInteractiveLock(async () => {
		const log = await readInteractiveLog(path);
		const list = Array.isArray(log[petId]?.messages) ? log[petId].messages : [];
		list.push({
			text,
			ts
		});
		log[petId] = { messages: list.slice(-INTERACTIVE_LOG_MAX) };
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(log, null, 2), "utf8");
	});
}
function isTempScreenshotPath(file) {
	try {
		const abs = resolve(file);
		const tmp = resolve(tmpdir());
		return abs.toLowerCase().startsWith((tmp + sep).toLowerCase()) && /dsh-pet-screen-\d+(?:-[a-z0-9]+)?\.(jpg|jpeg|png)$/i.test(abs);
	} catch {
		return false;
	}
}
async function fileToDataUrl(file) {
	const buf = await readFile(file);
	const mime = /\.png$/i.test(file) ? "image/png" : "image/jpeg";
	return "data:" + mime + ";base64," + buf.toString("base64");
}

//#endregion
//#region src/host/anim.ts
/** 字符串数组收窄（配置里的池子；非数组/空串 → 空数组） */
function strings(v) {
	return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x !== "") : [];
}
/** 朝向收窄：只认两个字面量（大小写、空白、非字符串一律不算），不认识返回 `null` */
const petFacing = (v) => v === "left" || v === "right" ? v : null;
function animationNames(animations) {
	const a = animations && typeof animations === "object" ? animations : {};
	const out = [];
	const push = (names) => {
		for (const n of names) if (!out.includes(n)) out.push(n);
	};
	push(strings(a.idle));
	push(strings(a.turn));
	push(strings(a.drag));
	push(strings(a.clicks));
	const moves = a.moves && typeof a.moves === "object" ? a.moves : {};
	push(Array.isArray(moves.actions) ? moves.actions.map((m) => m && typeof m === "object" ? m.name : void 0).filter((x) => typeof x === "string" && x !== "") : []);
	if (Array.isArray(a.categories)) {
		for (const c of a.categories) if (c && typeof c === "object") push(strings(c.actions));
	}
	const events = a.events && typeof a.events === "object" ? a.events : {};
	for (const key of Object.keys(events)) {
		const pool = events[key];
		if (!Array.isArray(pool)) continue;
		const names = [];
		for (const slot of pool) if (typeof slot === "string") names.push(slot);
		else names.push(...strings(slot));
		push(names);
	}
	return out;
}
function normalizeHttpUrl(v) {
	if (typeof v !== "string") return null;
	const raw = v.trim();
	if (!raw) return null;
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	return raw;
}
function decideAnim(args) {
	const { cfg, requested } = args;
	const name = typeof args.name === "string" ? args.name.trim() : "";
	const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
	if (name && rawUrl) return {
		ok: false,
		reason: "bad-request",
		message: "name 与 url 只能给一个"
	};
	if (!name && !rawUrl) return {
		ok: false,
		reason: "bad-request",
		message: "name 或 url 必须给一个"
	};
	let facing;
	if (args.facing !== void 0 && args.facing !== null) {
		const f = petFacing(args.facing);
		if (f === null) return {
			ok: false,
			reason: "bad-request",
			message: "facing 必须是 left / right"
		};
		facing = f;
	}
	const petId = String(requested ?? "").trim();
	if (!petId) return {
		ok: false,
		reason: "pet-required",
		message: "pet 必填：要指定操作哪只桌宠"
	};
	const found = findPetInstance(cfg, petId);
	if (!found) return {
		ok: false,
		reason: "unknown-pet",
		message: "没有这只桌宠：" + petId
	};
	if (rawUrl) {
		const url = normalizeHttpUrl(rawUrl);
		if (url === null) return {
			ok: false,
			reason: "bad-request",
			message: "url 必须是 http/https 的完整地址"
		};
		return {
			ok: true,
			petId,
			url,
			facing
		};
	}
	const allowed = animationNames(found.conf.animations);
	if (!allowed.includes(name)) return {
		ok: false,
		reason: "unknown-animation",
		message: "没有这个动画：" + name
	};
	return {
		ok: true,
		petId,
		name,
		facing
	};
}

//#endregion
//#region src/host/broadcast.ts
/** 气泡默认显示时长（ms）——与两端消费侧的常量同值（host 不得 import src/shared，只能各写一份）。
*  这个值只用于**把缺省解析成显式值**写进叶子，让 /state 里能看到实际生效的时长。 */
const DEFAULT_BUBBLE_DURATION_MS = 10 * 1e3;
function normalizeBroadcastText(text) {
	return typeof text === "string" ? text.trim() : "";
}
function normalizeBroadcastDuration(duration) {
	if (duration === void 0 || duration === null) return DEFAULT_BUBBLE_DURATION_MS;
	if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) return null;
	return duration;
}
function normalizeBroadcastAnim(anim) {
	return anim !== false;
}
/**
* `?pet=` → 实际落点（与 ./anim、./motion-cue 同一口径）：**必填**且必须真实存在。
*
* 两种失败分开报（issue #122 第 1 条「绝不默认退到列表第一只」）：没给 → `pet-required`；
* 给了但配置里没有 → `unknown-pet`。收紧前这里是 `requested || active || 'main'`——`active`
* 是"当前桌宠" = **有效宠物列表第一只**，落点随用户 /pet 操作而变，第三方无从预期，故整条删除。
*/
function resolvePetId(cfg, requested) {
	const petId = String(requested ?? "").trim();
	if (!petId) return {
		ok: false,
		reason: "pet-required",
		message: "pet 必填：要指定操作哪只桌宠"
	};
	const found = findPetInstance(cfg, petId);
	if (!found) return {
		ok: false,
		reason: "unknown-pet",
		message: "没有这只桌宠：" + petId
	};
	return {
		ok: true,
		petId,
		entry: found.entry,
		conf: found.conf
	};
}
function decideBroadcast(args) {
	const { cfg, requested, memeDirs } = args;
	const text = normalizeBroadcastText(args.text);
	if (!text) return {
		ok: false,
		reason: "bad-request",
		message: "text 为空"
	};
	const who = resolvePetId(cfg, requested);
	if (!who.ok) return {
		ok: false,
		reason: who.reason,
		message: who.message
	};
	const petId = who.petId;
	const rawImage = typeof args.image === "string" ? args.image.trim() : "";
	const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
	if (rawImage && rawUrl) return {
		ok: false,
		reason: "bad-request",
		message: "image 与 url 只能给一个"
	};
	if (!rawImage && !rawUrl) return {
		ok: true,
		petId,
		text,
		duration: args.duration,
		anim: args.anim
	};
	if (rawUrl) {
		const url = normalizeHttpUrl(rawUrl);
		if (url === null) return {
			ok: false,
			reason: "bad-request",
			message: "url 必须是 http/https 的完整地址"
		};
		return {
			ok: true,
			petId,
			text,
			url,
			duration: args.duration,
			anim: args.anim
		};
	}
	const hit = matchMeme(readMemePool(who.conf.memes, memeDirs(who.entry)), rawImage);
	if (!hit) return {
		ok: false,
		reason: "unknown-image",
		message: "配图不在表情包池内：" + rawImage
	};
	return {
		ok: true,
		petId,
		text,
		image: hit.name,
		duration: args.duration,
		anim: args.anim
	};
}
function decideBubbleClear(args) {
	const who = resolvePetId(args.cfg, args.requested);
	if (!who.ok) return {
		ok: false,
		reason: who.reason,
		message: who.message
	};
	return {
		ok: true,
		petId: who.petId
	};
}

//#endregion
//#region src/host/lock.ts
const LOCK_DEFAULT_TTL_MS = 2 * 60 * 1e3;
const LOCK_MIN_TTL_MS = 1 * 1e3;
const LOCK_MAX_TTL_MS = 30 * 60 * 1e3;
/** cause → 给人看的一句话（回执里的 message；reason 才是机器读的那个） */
const CAUSE_TEXT = {
	expired: "占用已过期（没有及时续期）",
	released: "占用已被释放",
	preempted: "占用已被用户接管（拖拽/点击/隐藏/关闭）",
	unknown: "lock 不是当前生效的占用编号"
};
/** ttl 合法性说明（路由与决策层共用同一条规则，免得两处走样） */
const TTL_TEXT = `ttl 必须是 ${LOCK_MIN_TTL_MS}~${LOCK_MAX_TTL_MS} 之间的有限数字（毫秒）`;
function normalizeLockTtl(ttl, fallback) {
	if (ttl === void 0 || ttl === null) return fallback;
	if (typeof ttl !== "number" || !Number.isFinite(ttl)) return null;
	if (ttl < LOCK_MIN_TTL_MS || ttl > LOCK_MAX_TTL_MS) return null;
	return ttl;
}
/**
* lockId 规范化：缺省 / null → 空串（= "没给"，走新建那条路）；字符串 → trim 后原样；
* **非字符串 → null（非法）**。空串按"没给"处理是有意的（与 `image`/`url` 的宽松口径一致）。
*/
function normalizeLockId(v) {
	if (v === void 0 || v === null) return "";
	if (typeof v !== "string") return null;
	return v.trim();
}
var LockStore = class {
	constructor(opts) {
		this.locks = new Map();
		this.tombstones = new Map();
		this.seq = 0;
		this.now = opts?.now ?? Date.now;
		this.onChange = opts?.onChange ?? (() => {});
	}
	/**
	* 当前占用（**懒判过期**）。到点即视为没有：清记录、记墓碑、同步一次叶子。
	*
	* 这里会写叶子（读方法带一次副作用）是有意的：叶子是渲染端唯一能看到的信号，
	* 而宿主这一侧没有任何定时器。任一动作端点或内部来源调一次本方法，过期的锁就会被清掉并
	* 如实写进 S；即便一次都没人调，渲染端也会按叶子里的 `expiresAt` **自己**解除静止。
	*/
	current(petId) {
		const rec = this.locks.get(petId);
		if (rec === void 0) return null;
		if (this.now() < rec.expiresAt) return rec;
		this.drop(petId, rec, "expired");
		return null;
	}
	/** 这只宠物此刻是否被占用（宿主内部自动来源用它决定跳过；同样懒判过期） */
	locked(petId) {
		return this.current(petId) !== null;
	}
	/**
	* 当前是否有**任意**宠物被占用（测试 / 观测用，同 ./state 的 `waiterCount()`）。
	*
	* **生产路径上没有人调它**：占用期间要挡的两个**全局段**（`sections.balance` /
	* `sections.workStatus`）是**所有宠物共用一份**，宿主"跳过写入"会连带静音别的宠物
	* （issue #122 要的是"只控制指定 main"），所以那两处改由**渲染端按宠物忽略**——
	* 叶子照常推进，被占用那只自己不看（见 src/client/pet.ts 的冻结判定与
	* runtime/electron-helper/events.js 里同一处判断）。宿主侧只挡 per-pet 的碎碎念周期。
	*/
	anyLocked() {
		for (const petId of [...this.locks.keys()]) if (this.current(petId) !== null) return true;
		return false;
	}
	/**
	* 动作端点的门禁（`/anim`、`/broadcast`、`/position`、`/throw`、`/bubble/clear` 共用）。
	*
	* 无锁时按「有没有带编号」分两条：
	*   - **没带 `lock`** → 放行。没有占用的常态下，既有调用方一个字都不用改。
	*   - **带了 `lock` 但查不到锁** → `lock-lost`。带了编号就说明调用方以为自己还持有；这时放行
	*     等于把「你把锁丢了」悄悄抹掉，它会以为演出还在继续。`cause` 从墓碑里取，从没建过锁就是
	*     `unknown`（issue #122 第 4 点：旧租约不能继续执行迟到请求）。
	*/
	gate(petId, provided) {
		const rec = this.current(petId);
		if (rec !== null) {
			if (provided && provided === rec.lockId) return { ok: true };
			if (!provided) return {
				ok: false,
				reason: "lock-required",
				message: "这只桌宠正被占用，必须带 lock=<lockId>"
			};
			return {
				ok: false,
				reason: "lock-lost",
				cause: "unknown",
				message: CAUSE_TEXT.unknown
			};
		}
		if (!provided) return { ok: true };
		const cause = this.causeOf(petId, provided);
		return {
			ok: false,
			reason: "lock-lost",
			cause,
			message: CAUSE_TEXT[cause]
		};
	}
	/**
	* 取锁 / 续期（**二合一**：`lockId` 给了就是续期，没给就是新建）。
	*
	* 真值表（每一格都有确定结论，不替调用方猜）：
	*   | body       | 当前锁       | 结论 |
	*   | 无 lockId  | 无锁         | 新建 |
	*   | 无 lockId  | 有锁         | `locked` + `expiresAt` |
	*   | 有 lockId  | 一致         | 续期 |
	*   | 有 lockId  | 有锁但不一致 | `lock-lost` / `unknown` |
	*   | 有 lockId  | 无锁         | `lock-lost` / 墓碑里的 cause |
	*
	* **「有 id + 当前无锁」一律报错，不复活**：过期/被释放/被抢占之后拿旧编号来续期，
	* 不能借这条路把锁重新建起来——否则「我丢了锁」这件事会被悄悄抹掉，持锁者会以为演出还在继续。
	*/
	acquire(args) {
		const { petId } = args;
		const renewId = normalizeLockId(args.lockId);
		if (renewId === null) return {
			ok: false,
			reason: "bad-request",
			message: "lockId 必须是字符串"
		};
		const rec = this.current(petId);
		if (renewId) {
			if (rec === null || rec.lockId !== renewId) {
				const cause = rec === null ? this.causeOf(petId, renewId) : "unknown";
				return {
					ok: false,
					reason: "lock-lost",
					cause,
					message: CAUSE_TEXT[cause]
				};
			}
			const ttl$1 = normalizeLockTtl(args.ttl, rec.ttl);
			if (ttl$1 === null) return {
				ok: false,
				reason: "bad-request",
				message: TTL_TEXT
			};
			rec.ttl = ttl$1;
			rec.expiresAt = this.now() + ttl$1;
			this.onChange(petId, {
				locked: true,
				expiresAt: rec.expiresAt
			});
			return {
				ok: true,
				petId,
				lockId: rec.lockId,
				expiresAt: rec.expiresAt,
				renewed: true
			};
		}
		if (rec !== null) return {
			ok: false,
			reason: "locked",
			expiresAt: rec.expiresAt,
			message: "这只桌宠已被占用"
		};
		const ttl = normalizeLockTtl(args.ttl, LOCK_DEFAULT_TTL_MS);
		if (ttl === null) return {
			ok: false,
			reason: "bad-request",
			message: TTL_TEXT
		};
		const record = {
			lockId: this.newId(),
			ttl,
			expiresAt: this.now() + ttl
		};
		this.locks.set(petId, record);
		this.tombstones.delete(petId);
		this.onChange(petId, {
			locked: true,
			expiresAt: record.expiresAt
		});
		return {
			ok: true,
			petId,
			lockId: record.lockId,
			expiresAt: record.expiresAt,
			renewed: false
		};
	}
	/**
	* 释放。两种形态**二选一**：
	*   - `lockId`：持锁者收工 → `cause: released`
	*   - `force: true`：**渲染端**在用户拖拽/点击/隐藏/关闭时调 → `cause: preempted`
	*
	* 幂等：当前没有锁时回 `ok:true`（`released: false`）——"让锁消失"这个意图在空状态下已经成立。
	* 但有锁而 `lockId` 不匹配时**必须报错**（不许误放别人的锁）：这是唯一一条"释放也会失败"的路。
	*
	* `force` 只认**严格 `true`**（宽松口径会把误传当真，代价是撤掉别人的锁——宁可严格）。
	*/
	release(args) {
		const { petId } = args;
		const force = args.force === true;
		const releaseId = normalizeLockId(args.lockId);
		if (releaseId === null) return {
			ok: false,
			reason: "bad-request",
			message: "lockId 必须是字符串"
		};
		if (force && releaseId) return {
			ok: false,
			reason: "bad-request",
			message: "lockId 与 force 只能给一个"
		};
		if (!force && !releaseId) return {
			ok: false,
			reason: "bad-request",
			message: "lockId 或 force 必须给一个"
		};
		const rec = this.current(petId);
		if (rec === null) return {
			ok: true,
			petId,
			released: false
		};
		if (!force && rec.lockId !== releaseId) return {
			ok: false,
			reason: "lock-lost",
			cause: "unknown",
			message: CAUSE_TEXT.unknown
		};
		this.drop(petId, rec, force ? "preempted" : "released");
		return {
			ok: true,
			petId,
			released: true
		};
	}
	/** 撤掉全部占用（插件卸载路径）：不这样做的话，渲染端要等 TTL 到点才解除静止 */
	releaseAll() {
		for (const petId of [...this.locks.keys()]) {
			const rec = this.locks.get(petId);
			if (rec !== void 0) this.drop(petId, rec, "released");
		}
	}
	/** 撤锁并记墓碑（唯一改状态的出口：释放/抢占/过期都走它，保证叶子与墓碑不漏写） */
	drop(petId, rec, cause) {
		this.locks.delete(petId);
		this.tombstones.set(petId, {
			lockId: rec.lockId,
			cause
		});
		this.onChange(petId, { locked: false });
	}
	/** 墓碑查询：编号对得上就回它当初的 cause，否则 unknown（拿错编号 / 从来没有过） */
	causeOf(petId, lockId) {
		const stone = this.tombstones.get(petId);
		return stone !== void 0 && stone.lockId === lockId ? stone.cause : "unknown";
	}
	/** 新编号：`lk-<时间36>-<自增36>`（与 ./playback 的 playbackId 同一套，只保证一次运行内唯一） */
	newId() {
		return "lk-" + this.now().toString(36) + "-" + (++this.seq).toString(36);
	}
};

//#endregion
//#region src/host/menu.ts
/**
* 第三方右键菜单注册表（进程内存态，DSH 重启即清空；不落盘）。
*
* 用途：别的插件想在桌宠右键菜单里加自己的入口，就走这里注册；用户点了之后，注册方用它自己的
* owner 去查"我这一项被点了没有、是哪只宠物上点的"。
*
* 数据形状（两层，没有第三层）：
*
*   owners: Map<owner, Map<label, petId | null>>
*           键 = owner（身份键，同时也是一级分组名）
*           值 = label → 触发它的宠物 id；null = 没点过
*
* 语义要点（实现前先读完，都是刻意的）：
*  - **注册 = 整体覆盖**：该 owner 的菜单项 = 本次 labels 事件（不在列表里的项连同触发标记一起
*    丢弃）。没有单独的删除接口——注销就再注册一个空列表？不，空列表按非法处理（400），
*    所以"不想要了"只能注册一份新的（或等进程重启）。这是有意的：菜单项生命周期与插件一致。
*  - **同 owner 内 label 唯一**：重复 label 去重（保留第一次出现的顺序）。
*  - **点击是闩锁不是队列**：同一项连点两次，查询只看到"点过"一次；不计数、不排序。
*  - **查询即清空**（读取即消费）：返回后把这些标记全部清成 null。没有确认、没有重投——
*    查询方没处理完就崩了，这次触发就丢了（对"用户点了一下菜单"这种一次性触发是合理取舍）。
*  - **一个 owner 只该有一个消费者**：两个进程同时查会互抢（谁先返回谁拿到标记）。
*
* 限额（防本机进程把菜单/内存刷爆）：
*  - owner ≤ 64 字符、label ≤ 32 字符（都允许中文，trim 后非空，禁控制字符）
*  - 每 owner ≤ 20 项、全局 ≤ 32 个 owner
*/
/** owner 长度上限 */
const OWNER_MAX = 64;
/** 单个菜单项 label 长度上限（面板宽 150–240px，再长会被省略号截断） */
const LABEL_MAX = 32;
/** 每 owner 菜单项上限 */
const ITEMS_MAX = 20;
/** 全局 owner 上限 */
const OWNERS_MAX = 32;
const MENU_WAIT_MAX_MS = 1e4;
/** 控制字符（换行/制表等会把菜单布局搞炸，一律拒绝） */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
/** 校验一个显示用字符串：必须是 string、trim 后非空、不超长、无控制字符 */
function displayText(value, max) {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (text === "" || text.length > max || CONTROL_CHARS.test(text)) return null;
	return text;
}
var MenuRegistry = class {
	constructor() {
		this.owners = new Map();
		this.waiters = new Map();
	}
	/**
	* 注册（整体覆盖）：`{ owner, labels: string[] }`。
	*
	* 覆盖的粒度是 **owner 的全部菜单项**，不是逐项 upsert：这样注册方每次都能用一份完整列表
	* 描述"我现在有什么"，不必关心上次注册了什么，也不会留下已下线的僵尸项。
	*/
	register(raw) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {
			ok: false,
			reason: "bad-request",
			message: "body 必须是 { owner, labels }"
		};
		const body = raw;
		const owner = displayText(body.owner, OWNER_MAX);
		if (owner === null) return {
			ok: false,
			reason: "invalid-owner",
			message: `owner 必须是 1–${OWNER_MAX} 字符的字符串（禁控制字符）`
		};
		const rawLabels = body.labels;
		if (!Array.isArray(rawLabels) || rawLabels.length === 0) return {
			ok: false,
			reason: "invalid-labels",
			message: "labels 必须是非空数组"
		};
		if (rawLabels.length > ITEMS_MAX) return {
			ok: false,
			reason: "too-many-items",
			message: `每个 owner 最多 ${ITEMS_MAX} 项`
		};
		const labels = [];
		for (const rawLabel of rawLabels) {
			const label = displayText(rawLabel, LABEL_MAX);
			if (label === null) return {
				ok: false,
				reason: "invalid-label",
				message: `每个 label 必须是 1–${LABEL_MAX} 字符的字符串（禁控制字符）`
			};
			if (!labels.includes(label)) labels.push(label);
		}
		if (!this.owners.has(owner) && this.owners.size >= OWNERS_MAX) return {
			ok: false,
			reason: "too-many-owners",
			message: `最多 ${OWNERS_MAX} 个 owner`
		};
		this.owners.set(owner, new Map(labels.map((label) => [label, null])));
		return { ok: true };
	}
	/**
	* 清掉一个 owner 的全部菜单项（连它上面未取走的触发标记一起丢）。
	*
	* 幂等：owner 本来就不存在 → `removed: 0`，仍算成功——调用方重试注销时不该看到错误。
	* 挂在该 owner 上的长轮询会被叫醒，醒来后查不到 owner → `null`（路由回 `ok:false` +
	* `unknown-owner`），调用方据此知道要重新注册。
	*/
	clear(rawOwner) {
		const owner = displayText(rawOwner, OWNER_MAX);
		if (owner === null) return {
			ok: false,
			reason: "invalid-owner",
			message: `owner 必须是 1–${OWNER_MAX} 字符的字符串（禁控制字符）`
		};
		const items = this.owners.get(owner);
		if (!items) return {
			ok: true,
			removed: 0
		};
		const removed = items.size;
		this.owners.delete(owner);
		const waiters = this.waiters.get(owner);
		this.waiters.delete(owner);
		if (waiters) for (const wake of [...waiters]) wake();
		return {
			ok: true,
			removed
		};
	}
	/** 全量快照（写进 state；顺序 = 注册顺序 + 列表顺序，两端渲染顺序与它一致） */
	snapshot() {
		const out = [];
		for (const [owner, items] of this.owners) for (const label of items.keys()) out.push({
			owner,
			label
		});
		return out;
	}
	/**
	* 渲染端上报一次点击：把该项标成"被 petId 点了"，并叫醒该 owner 上挂着的长轮询。
	*
	* `delivered = false`（项不存在：菜单刚好被覆盖/还没注册）**不算错误**——渲染端拿着的是
	* 上一拍 /state 的快照，这一拍菜单已经变了，属于正常竞态，路由仍回 200。
	*/
	click(raw) {
		const body = raw && typeof raw === "object" ? raw : {};
		const owner = typeof body.owner === "string" ? body.owner : "";
		const label = typeof body.label === "string" ? body.label : "";
		const pet = typeof body.pet === "string" ? body.pet.trim() : "";
		const items = this.owners.get(owner);
		if (!items || !items.has(label) || pet === "") return {
			ok: true,
			delivered: false
		};
		items.set(label, pet);
		const waiters = this.waiters.get(owner);
		if (waiters) for (const wake of [...waiters]) wake();
		return {
			ok: true,
			delivered: true
		};
	}
	/**
	* 查询触发：返回 `{ label: petId | null }` 全量映射，**返回即清空**这些标记。
	*
	* `waitMs > 0` 且当下没有任何触发 → 挂起等待（该 owner 被点/超时/被覆盖都会唤醒），
	* 超时后照常返回全 null 的映射。owner 不存在 → null（路由回 404，调用方据此知道要重新注册）。
	*/
	async poll(owner, waitMs) {
		const items = this.owners.get(owner);
		if (!items) return null;
		if (waitMs > 0 && !hasFired(items)) await new Promise((resolve$1) => {
			const set = this.waiters.get(owner) ?? new Set();
			this.waiters.set(owner, set);
			const hold = {};
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				if (hold.timer !== void 0) clearTimeout(hold.timer);
				set.delete(finish);
				if (set.size === 0 && this.waiters.get(owner) === set) this.waiters.delete(owner);
				resolve$1();
			};
			hold.timer = setTimeout(finish, Math.min(waitMs, MENU_WAIT_MAX_MS));
			set.add(finish);
		});
		const current = this.owners.get(owner);
		if (!current) return null;
		const out = {};
		for (const [label, pet] of current) {
			out[label] = pet;
			current.set(label, null);
		}
		return out;
	}
};
/** 该 owner 当前有没有任意一项被点过 */
function hasFired(items) {
	for (const pet of items.values()) if (pet !== null) return true;
	return false;
}

//#endregion
//#region src/host/motion-cue.ts
const POSITION_MODES = [
	"instant",
	"spring",
	"line"
];
/** 夹到 0~1：归一化坐标的合法范围，**越界夹取而不是拒绝**（调用方拿响应里的实际值即可） */
const clamp01 = (v) => Math.min(1, Math.max(0, v));
/** 有限数字收窄：字符串 / 布尔 / NaN / Infinity 一律不算（配置里也这么判） */
const finite = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
/** 模式收窄：只认三个字面量（大小写、空白、非字符串一律不算），不认识返回 `null` */
const positionMode = (v) => typeof v === "string" && POSITION_MODES.includes(v) ? v : null;
/**
* 目标宠物解析（与 ./anim、./broadcast 同一口径）：`?pet=` **必填**且必须真实存在。
*
* 两种失败分开报（issue #122 第 1 条「绝不默认退到列表第一只」）：
* 没给 → `pet-required`；给了但配置里没有 → `unknown-pet`。
*
* 收紧前这里是 `requested || active || 'main'`：`active` 是"当前桌宠" = **有效宠物列表第一只**，
* 而那个落点是用户 /pet 操作的函数——同一句不带 pet 的调用，落点会随用户操作而变，调用方无从
* 预期。所以整条缺省链已删除，pet 与 /pet-display 的 `id` 一样是必填项。
*/
function resolvePet(cfg, requested) {
	const petId = String(requested ?? "").trim();
	if (!petId) return {
		ok: false,
		reason: "pet-required",
		message: "pet 必填：要指定操作哪只桌宠"
	};
	if (!flattenPetList(cfg).some((p) => String(p.id) === petId)) return {
		ok: false,
		reason: "unknown-pet",
		message: "没有这只桌宠：" + petId
	};
	return {
		ok: true,
		petId
	};
}
function decidePosition(args) {
	const x = finite(args.x);
	if (x === null) return {
		ok: false,
		reason: "bad-request",
		message: "x 必须是有限数字"
	};
	const y = finite(args.y);
	if (y === null) return {
		ok: false,
		reason: "bad-request",
		message: "y 必须是有限数字"
	};
	const mode = positionMode(args.mode);
	if (mode === null) return {
		ok: false,
		reason: "bad-request",
		message: "mode 必须是 instant / spring / line"
	};
	let duration = null;
	if (mode === "line") {
		const d = finite(args.duration);
		if (d === null || d < 0) return {
			ok: false,
			reason: "bad-request",
			message: "line 模式的 duration 必须是非负有限数字（毫秒）"
		};
		duration = d;
	}
	const pet = resolvePet(args.cfg, args.requested);
	if (!pet.ok) return pet;
	return {
		ok: true,
		petId: pet.petId,
		x: clamp01(x),
		y: clamp01(y),
		mode,
		duration
	};
}
const positionLeafData = (d) => d.duration === null ? {
	x: d.x,
	y: d.y,
	mode: d.mode
} : {
	x: d.x,
	y: d.y,
	mode: d.mode,
	duration: d.duration
};
function decideThrow(args) {
	const angle = finite(args.angle);
	if (angle === null) return {
		ok: false,
		reason: "bad-request",
		message: "angle 必须是有限数字"
	};
	const power = finite(args.power);
	if (power === null || power <= 0) return {
		ok: false,
		reason: "bad-request",
		message: "power 必须是大于 0 的有限数字"
	};
	const pet = resolvePet(args.cfg, args.requested);
	if (!pet.ok) return pet;
	return {
		ok: true,
		petId: pet.petId,
		angle,
		power
	};
}

//#endregion
//#region src/host/playback.ts
const TERMINAL_STATUSES = [
	"ended",
	"failed",
	"cancelled"
];
const REPORTABLE_STATUSES = [
	"playing",
	"ended",
	"failed",
	"cancelled"
];
const PLAYBACK_KEEP_MS = 60 * 1e3;
const MAX_PLAYBACK_WAIT_MS = 10 * 1e3;
/** 终态判定用集合 */
const TERMINAL = new Set(TERMINAL_STATUSES);
/** 可上报判定用集合 */
const REPORTABLE = new Set(REPORTABLE_STATUSES);
const isTerminalStatus = (s) => TERMINAL.has(s);
const isPlaybackStatus = (s) => s === "accepted" || REPORTABLE.has(s);
const isReportableStatus = (s) => REPORTABLE.has(s);
function parsePlaybackPath(rest) {
	const m = /^playback\/([^/]+)(\/report)?$/.exec(rest);
	if (!m) return void 0;
	return {
		playbackId: m[1] ?? "",
		isReport: m[2] === "/report"
	};
}
function parseWaitQuery(waitRaw, timeoutRaw) {
	if (waitRaw === null && timeoutRaw === null) return { kind: "none" };
	if (waitRaw === null || timeoutRaw === null) return {
		kind: "error",
		error: "wait and timeout must be used together"
	};
	const wait = waitRaw.split(",").map((s) => s.trim()).filter((s) => s !== "");
	const bad = wait.find((s) => !isPlaybackStatus(s));
	if (wait.length === 0 || bad !== void 0) return {
		kind: "error",
		error: `invalid wait status: ${bad ?? waitRaw}`
	};
	if (!/^\d+$/.test(timeoutRaw)) return {
		kind: "error",
		error: `invalid timeout (expect 0..${MAX_PLAYBACK_WAIT_MS})`
	};
	const timeoutMs = Number(timeoutRaw);
	if (!Number.isFinite(timeoutMs) || timeoutMs > MAX_PLAYBACK_WAIT_MS) return {
		kind: "error",
		error: `invalid timeout (expect 0..${MAX_PLAYBACK_WAIT_MS})`
	};
	return {
		kind: "ok",
		wait,
		timeoutMs
	};
}
var PlaybackStore = class {
	constructor() {
		this.records = new Map();
		this.waiters = new Map();
		this.activeByPet = new Map();
		this.seq = 0;
	}
	/**
	* 受理一次点播：建记录（accepted），并把该宠物上一场（若仍在非终态）标为 cancelled/superseded。
	* @returns 新建的记录（调用方取 playbackId 下发给调用方）
	*/
	create(petId, name) {
		this.sweep();
		const prev = this.activeByPet.get(petId);
		if (prev !== void 0) this.finish(prev, "cancelled", "superseded");
		const now = Date.now();
		const record = {
			playbackId: "pb-" + now.toString(36) + "-" + (++this.seq).toString(36),
			petId,
			name,
			status: "accepted",
			createdAt: now,
			updatedAt: now
		};
		this.records.set(record.playbackId, record);
		this.activeByPet.set(petId, record.playbackId);
		return record;
	}
	/** 查记录；不存在 / 已过期 → undefined（路由回 404） */
	get(playbackId) {
		this.sweep();
		return this.records.get(playbackId);
	}
	/**
	* 渲染端上报一次状态。
	*
	* 幂等与终态保护：**终态之后的上报一律 ignored**（迟到的 ended 不许覆盖 cancelled），
	* 与当前状态相同的上报同样 ignored。两种情况路由都回 200——对上报方来说"已经这样了"就是成功。
	*/
	report(playbackId, status, reason) {
		this.sweep();
		const record = this.records.get(playbackId);
		if (!record) return "unknown";
		const next = typeof status === "string" ? status : "";
		if (!isReportableStatus(next)) return "invalid";
		if (isTerminalStatus(record.status) || record.status === next) return "ignored";
		const why = typeof reason === "string" && reason !== "" ? reason : void 0;
		this.finish(playbackId, next, why);
		return "ok";
	}
	/**
	* 挂起一个等待者。
	* @returns 取消函数；编号不存在时返回 **undefined**（路由据此立刻回 404，不挂）
	*/
	wait(args) {
		this.sweep();
		const record = this.records.get(args.playbackId);
		if (!record) return void 0;
		const waiter = {
			wait: new Set(args.wait),
			onWake: args.onWake,
			record,
			timer: void 0
		};
		let set = this.waiters.get(args.playbackId);
		if (!set) {
			set = new Set();
			this.waiters.set(args.playbackId, set);
		}
		set.add(waiter);
		waiter.timer = setTimeout(() => {
			this.dropWaiter(args.playbackId, waiter);
			waiter.onWake(waiter.record, false);
		}, Math.max(0, args.timeoutMs));
		waiter.timer.unref?.();
		return () => this.dropWaiter(args.playbackId, waiter);
	}
	/**
	* 结束**所有**挂起的等待（插件卸载 / 宿主退出路径）。
	* 唤醒时 matched=false：调用方据此立刻收尾，而不是留一个悬挂的响应。
	*/
	cancelAll() {
		for (const [playbackId, set] of [...this.waiters]) for (const waiter of [...set]) {
			this.dropWaiter(playbackId, waiter);
			waiter.onWake(waiter.record, false);
		}
	}
	/**
	* 清理过期终态记录（惰性调用：create / get / report 各调一次，记录数很少，成本可忽略）。
	*
	* **必须先把还在等它的人叫醒**：等待上限（10s）通常远小于保留时长（60s），但调用方完全可以在
	* 一条终态记录的保留窗口末尾注册一个等"别的状态"的等待者——那种情况下记录会被清理，
	* 不唤醒就成了永远等不到的悬挂等待者。
	*
	* @param now 注入时间（单测用；缺省取当前时刻）
	*/
	sweep(now = Date.now()) {
		for (const [playbackId, record] of this.records) {
			if (!isTerminalStatus(record.status)) continue;
			if (now - record.updatedAt < PLAYBACK_KEEP_MS) continue;
			const set = this.waiters.get(playbackId);
			if (set) for (const waiter of [...set]) {
				this.dropWaiter(playbackId, waiter);
				waiter.onWake(waiter.record, false);
			}
			this.records.delete(playbackId);
		}
	}
	/** 当前记录数（测试 / 观测用） */
	count() {
		return this.records.size;
	}
	/** 当前等待者数（测试 / 观测用：验证不泄漏） */
	waiterCount() {
		let n = 0;
		for (const set of this.waiters.values()) n += set.size;
		return n;
	}
	/**
	* 落到一个终态：写状态、更新时间、摘掉"当前活跃"、唤醒在等这个状态的人。
	* 唯一的状态写入点——等待者唤醒只在这里发生（不需要 diff、不需要比对）。
	*/
	finish(playbackId, status, reason) {
		const record = this.records.get(playbackId);
		if (!record) return;
		record.status = status;
		record.updatedAt = Date.now();
		if (status === "ended") record.endedAt = record.updatedAt;
		if (reason !== void 0) record.reason = reason;
		if (this.activeByPet.get(record.petId) === playbackId) this.activeByPet.delete(record.petId);
		const set = this.waiters.get(playbackId);
		if (!set) return;
		for (const waiter of [...set]) {
			if (!waiter.wait.has(status)) continue;
			this.dropWaiter(playbackId, waiter);
			waiter.onWake(waiter.record, true);
		}
	}
	/** 摘掉一个等待者（清定时器 + 从集合移除 + 空集合回收） */
	dropWaiter(playbackId, waiter) {
		if (waiter.timer !== void 0) {
			clearTimeout(waiter.timer);
			waiter.timer = void 0;
		}
		const set = this.waiters.get(playbackId);
		if (!set) return;
		set.delete(waiter);
		if (set.size === 0) this.waiters.delete(playbackId);
	}
};

//#endregion
//#region src/host/pose.ts
function normalizePoseInput(raw) {
	const o = raw && typeof raw === "object" ? raw : null;
	if (!o) return {
		ok: false,
		reason: "bad-request",
		message: "请求体必须是对象：{ x, y, facing }"
	};
	if (typeof o.x !== "number" || !Number.isFinite(o.x)) return {
		ok: false,
		reason: "bad-request",
		message: "x 必须是有限数字（归一化横坐标）"
	};
	if (typeof o.y !== "number" || !Number.isFinite(o.y)) return {
		ok: false,
		reason: "bad-request",
		message: "y 必须是有限数字（归一化纵坐标）"
	};
	if (o.facing !== "left" && o.facing !== "right") return {
		ok: false,
		reason: "bad-request",
		message: "facing 必须是 left / right"
	};
	return {
		ok: true,
		pose: {
			x: o.x,
			y: o.y,
			facing: o.facing
		}
	};
}
var PoseStore = class {
	constructor(opts) {
		this.byPet = new Map();
		this.now = opts?.now ?? Date.now;
	}
	/** 覆盖一只宠物的实况（返回落定的快照，方便调用方断言） */
	set(petId, pose) {
		const snap = {
			x: pose.x,
			y: pose.y,
			facing: pose.facing,
			updatedAt: this.now()
		};
		this.byPet.set(petId, snap);
		return snap;
	}
	/** 读最近一次实况；从没上报过 → undefined（路由回 `pose-unavailable`） */
	get(petId) {
		return this.byPet.get(petId);
	}
	/** 当前快照数（测试 / 观测用） */
	count() {
		return this.byPet.size;
	}
};

//#endregion
//#region src/host/surface.ts
const SURFACES = [
	"web",
	"desktop",
	"both",
	"any"
];
const SURFACE_TEXT = "surface 必填：web / desktop / both / any";
function normalizeSurface(v) {
	return typeof v === "string" && SURFACES.includes(v) ? v : null;
}
function displayCovers(want, display) {
	switch (want) {
		case "any": return display === "web" || display === "desktop" || display === "both";
		case "web": return display === "web" || display === "both";
		case "desktop": return display === "desktop" || display === "both";
		case "both": return display === "both";
	}
}

//#endregion
//#region src/host/work-status.ts
const HOST_WORK_STATUS_STATES = [
	"thinking",
	"working",
	"result",
	"waiting",
	"success",
	"error"
];
/**
* turn/end reason.kind → 状态：
*   completed → success、错误系（error/max-tokens/timeout）→ error、blocked → waiting（回合被阻塞，等用户确认）；
*   其余（aborted 等）→ null＝该会话回合已结束，由调用方清理会话回空闲——绝不残留上一档
*   （否则回合被打断后会永远卡在 working，即当年"这一步正在进行中哦"挂死的根因）。
*/
function turnEndState(kind) {
	if (kind === "completed") return "success";
	if (kind === "error" || kind === "max-tokens" || kind === "timeout") return "error";
	if (kind === "blocked") return "waiting";
	return null;
}
/** ask_user_question 工具名：模型在等用户选择题答复 → 归为 waiting（等待确认）而非普通工作 */
const USER_QUESTION_TOOL$1 = "ask_user_question";
const GOAL_UPDATE_TOOL = "update_goal";
function goalUpdateAction(args) {
	try {
		const o = JSON.parse(args);
		const action = String(o?.action ?? "");
		if (action === "complete" || action === "blocked") return action;
	} catch {}
	return null;
}
function completedState(turn) {
	if (!turn?.goalRound) return "success";
	if (turn.closing === "blocked") return "error";
	if (turn.closing === "complete") return "success";
	return "result";
}
function reduceWorkStatus(event, turn) {
	switch (event?.type) {
		case "turn/start": return "thinking";
		case "tool/call": {
			if (String(event?.data?.name ?? "") === USER_QUESTION_TOOL$1) return "waiting";
			return "working";
		}
		case "tool/result": return "result";
		case "approval/asked": return "waiting";
		case "turn/end": {
			const reason = turnEndState(String(event?.data?.reason?.kind ?? ""));
			if (reason === "success") return completedState(turn);
			return reason;
		}
		default: return null;
	}
}
const TASK_TEXT_MAX = 40;
function currentTaskFromTodo(event) {
	const todos = Array.isArray(event?.data?.todos) ? event.data.todos : [];
	let current;
	for (const t of todos) if (t?.status === "in_progress") current = t;
	if (!current) current = todos.find((t) => t?.status === "pending");
	const content = String(current?.content ?? "").trim();
	if (!content) return null;
	const points = Array.from(content);
	return points.length > TASK_TEXT_MAX ? `${points.slice(0, TASK_TEXT_MAX).join("")}…` : content;
}
const WORK_STATUS_PRIORITY = {
	waiting: 60,
	error: 50,
	working: 40,
	thinking: 30,
	result: 25,
	success: 20
};
function pickDisplayed(entries) {
	let best;
	for (const entry of entries) if (!best || WORK_STATUS_PRIORITY[entry.state] > WORK_STATUS_PRIORITY[best.state] || WORK_STATUS_PRIORITY[entry.state] === WORK_STATUS_PRIORITY[best.state] && entry.seq > best.seq) best = entry;
	return best;
}
var WorkStatusStore = class {
	constructor() {
		this.sessions = new Map();
		this.snap = {
			state: null,
			task: null,
			ts: 0
		};
	}
	/** 该会话当前是否有活动条目（决定 todo/write 是否还值得更新它的文案） */
	has(sessionId) {
		return this.sessions.has(sessionId);
	}
	/** 该会话当前档位（无条目 / 已清 → undefined） */
	stateOf(sessionId) {
		return this.sessions.get(sessionId)?.state;
	}
	/** 该会话当前任务详情（无条目 → null） */
	taskOf(sessionId) {
		return this.sessions.get(sessionId)?.task ?? null;
	}
	/** 写会话状态（保留该会话已有的 task）；同状态且 seq 不更新 → 无变化返回 false（防刷屏） */
	setState(sessionId, state, seq = 0) {
		const prev = this.sessions.get(sessionId);
		if (prev?.state === state && prev.seq >= seq) return false;
		this.sessions.set(sessionId, {
			state,
			seq,
			task: prev?.task ?? null
		});
		this.refresh();
		return true;
	}
	/** 写该会话的任务详情（null = 清空）；会话无活动条目 → 不动（它不会被展示） */
	setTask(sessionId, task) {
		const prev = this.sessions.get(sessionId);
		if (!prev || prev.task === task) return false;
		this.sessions.set(sessionId, {
			...prev,
			task
		});
		this.refresh();
		return true;
	}
	/** 清掉某会话（回合结束 / 终态过期）：它的 task 一并消失，不会残留到后续活动里 */
	clear(sessionId) {
		if (!this.sessions.delete(sessionId)) return false;
		this.refresh();
		return true;
	}
	/** 展示快照（对象引用稳定，供 /work-status 直接序列化） */
	snapshot() {
		return this.snap;
	}
	/** 重算展示：state 与 task **任一**变化才更新 ts（轮询侧据此触发，两端都靠它刷新） */
	refresh() {
		const best = pickDisplayed(this.sessions.values());
		const nextState = best?.state ?? null;
		const nextTask = best?.task ?? null;
		if (nextState === this.snap.state && nextTask === this.snap.task) return;
		this.snap.state = nextState;
		this.snap.task = nextTask;
		this.snap.ts = Date.now();
	}
};

//#endregion
//#region src/host/notify-events.ts
function shouldNotifySession(session) {
	const header = session?.header;
	if (!header || typeof header !== "object") return true;
	if (header.origin === "subagent") return false;
	const depth = header.delegationDepth;
	if (typeof depth === "number" && Number.isFinite(depth) && depth > 0) return false;
	return true;
}
function sessionIdOf(session) {
	const s = session;
	return String(s?.header?.id ?? s?.id ?? "unknown");
}
function withSessionId(frame, sessionId) {
	return sessionId === "unknown" ? frame : {
		...frame,
		sessionId
	};
}
function isCompletionTurnEnd(event) {
	const e = event;
	return e?.type === "turn/end" && e.data?.reason?.kind === "completed";
}
function hasBlockingActivity(activity) {
	if (!Array.isArray(activity)) return false;
	for (const item of activity) {
		const kind = item?.kind;
		if (kind === "job" || kind === "subagent" || kind === "schedule") return true;
	}
	return false;
}
function turnEndNotifyKind(kind) {
	if (kind === "completed") return "completed";
	if (kind === "error" || kind === "max-tokens") return kind;
	return null;
}
/** ask_user_question 工具名（与 work-status.ts 同源；该工具触发时模型在等用户选择题答复） */
const USER_QUESTION_TOOL = "ask_user_question";
function parseToolQuestions(args) {
	if (typeof args !== "string") return null;
	try {
		const parsed = JSON.parse(args);
		const questions = parsed?.questions;
		if (!Array.isArray(questions)) return null;
		return questions;
	} catch {
		return null;
	}
}
function reduceNotifyFrame(event) {
	if (!event?.type) return null;
	switch (event.type) {
		case "turn/end": {
			const reason = event.data?.reason;
			const kind = turnEndNotifyKind(reason?.kind);
			if (!kind) return null;
			return {
				type: "session/event",
				event: {
					type: "turn/end",
					data: { reason }
				}
			};
		}
		case "approval/asked": {
			const data = event.data ?? {};
			return {
				type: "approval/requested",
				...typeof data.toolName === "string" && data.toolName ? { toolName: data.toolName } : {},
				...typeof data.reason === "string" && data.reason ? { reason: data.reason } : {}
			};
		}
		case "tool/call": {
			if (String(event.data?.name ?? "") !== USER_QUESTION_TOOL) return null;
			const questions = parseToolQuestions(event.data?.arguments);
			if (!questions || questions.length === 0) return null;
			return {
				type: "question/requested",
				questions
			};
		}
		default: return null;
	}
}
function agentErrorFrame(error) {
	const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error ?? "");
	return {
		type: "host/agent-error",
		message
	};
}

//#endregion
//#region src/host/storage-paths.ts
const DESKTOP_APP_NAME = "dsh-pet-electron-helper";
/** Electron 下载缓存的应用名（@electron/get 写死 env-paths('electron')，与插件名无关） */
const ELECTRON_PATHS_NAME = "electron";
/**
* 桌面端 userData 目录（Electron app.getPath('userData') 的等价推导）。
*
* 与 Electron 的口径逐平台对齐：
*   win32  = %APPDATA%\<name>（appData 在 Windows 就是 Roaming）
*   darwin = ~/Library/Application Support/<name>
*   linux  = $XDG_CONFIG_HOME/<name>，未设则 ~/.config/<name>
*/
function desktopUserDataDir(input) {
	const { home, env = process.env, platform = process.platform } = input;
	if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), DESKTOP_APP_NAME);
	if (platform === "darwin") return join(home, "Library", "Application Support", DESKTOP_APP_NAME);
	return join(env.XDG_CONFIG_HOME || join(home, ".config"), DESKTOP_APP_NAME);
}
/**
* Electron 安装包下载缓存目录（@electron/get 默认 cacheRoot = env-paths('electron').cache）。
*
* env-paths 的口径：win32 在 LOCALAPPDATA 下多一层 Cache，macOS 用 ~/Library/Caches，
* Linux 用 $XDG_CACHE_HOME（默认 ~/.cache）——都是「应用名单独一层」。
* 该目录与其它用 @electron/get 的工具共用，删掉只是下次重新下载。
*/
function electronCacheDir(input) {
	const { home, env = process.env, platform = process.platform } = input;
	if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), ELECTRON_PATHS_NAME, "Cache");
	if (platform === "darwin") return join(home, "Library", "Caches", ELECTRON_PATHS_NAME);
	return join(env.XDG_CACHE_HOME || join(home, ".cache"), ELECTRON_PATHS_NAME);
}
function storageEntries(input) {
	const items = [
		{
			key: "userData",
			path: input.userDataRoot
		},
		{
			key: "electron",
			path: input.electronDir
		},
		{
			key: "desktopCache",
			path: desktopUserDataDir(input)
		},
		{
			key: "electronCache",
			path: electronCacheDir(input)
		},
		{
			key: "package",
			path: input.packageRoot
		}
	];
	return items.map((it) => ({
		...it,
		exists: existsSync(it.path)
	}));
}
function profileNameFrom(packageRoot$1) {
	const m = /[\\/]profiles[\\/]([^\\/]+)[\\/]node_modules[\\/][^\\/]+[\\/]?$/.exec(packageRoot$1);
	return m?.[1];
}

//#endregion
//#region src/host/state.ts
const MAX_STATE_WAIT_MS = 10 * 1e3;
function parseStateWaitQuery(sinceRaw, timeoutRaw) {
	if (sinceRaw === null && timeoutRaw === null) return { kind: "none" };
	if (sinceRaw === null || timeoutRaw === null) return {
		kind: "error",
		error: "since and timeout must be used together"
	};
	if (!/^\d+$/.test(sinceRaw)) return {
		kind: "error",
		error: "invalid since (expect a non-negative integer)"
	};
	if (!/^\d+$/.test(timeoutRaw)) return {
		kind: "error",
		error: `invalid timeout (expect 0..${MAX_STATE_WAIT_MS})`
	};
	const since = Number(sinceRaw);
	const timeoutMs = Number(timeoutRaw);
	if (!Number.isFinite(since)) return {
		kind: "error",
		error: "invalid since (expect a non-negative integer)"
	};
	if (!Number.isFinite(timeoutMs) || timeoutMs > MAX_STATE_WAIT_MS) return {
		kind: "error",
		error: `invalid timeout (expect 0..${MAX_STATE_WAIT_MS})`
	};
	return {
		kind: "ok",
		since,
		timeoutMs
	};
}
/** 空叶子：counter=0 表示"从未写过"——前端首拉把它当基线，之后 counter 变化才渲染 */
const emptyLeaf = () => ({
	counter: 0,
	data: null
});
var PollStateStore = class {
	constructor() {
		this.last = 0;
		this.sections = {
			balance: emptyLeaf(),
			workStatus: emptyLeaf(),
			notify: emptyLeaf(),
			config: emptyLeaf(),
			menu: emptyLeaf()
		};
		this.pets = new Map();
		this.waiters = new Set();
	}
	/** 下一个 counter：`Date.now()` 与「上一个 +1」取大——单调、不回退、同毫秒不重复 */
	next() {
		this.last = Math.max(Date.now(), this.last + 1);
		return this.last;
	}
	/**
	* 写一个全局叶子（余额 / 工作状态 / 通知 / 配置变更信号）。
	* 每次都整体替换叶子对象（不原地改字段），保证 `read()` 拿到的引用不会半新半旧。
	*/
	writeSection(name, data) {
		this.sections[name] = {
			counter: this.next(),
			data
		};
		this.wakeWaiters();
	}
	/** 写一只宠物的叶子（宠物条目不存在则自动建立，**所有槽位一起建好**，形状恒定） */
	writePet(petId, leaf, data) {
		let entry = this.pets.get(petId);
		if (!entry) {
			entry = {
				say: emptyLeaf(),
				anim: emptyLeaf(),
				position: emptyLeaf(),
				throw: emptyLeaf(),
				lock: emptyLeaf()
			};
			this.pets.set(petId, entry);
		}
		entry[leaf] = {
			counter: this.next(),
			data
		};
		this.wakeWaiters();
	}
	/**
	* 当前 S（GET /state 的响应体）。
	* 返回的 sections 是浅拷贝、pets 是新建对象——叶子对象本身共享，但写入永远整体替换，
	* 所以消费端不会读到写了一半的叶子。
	*/
	read() {
		return {
			counter: this.last,
			sections: { ...this.sections },
			pets: Object.fromEntries(this.pets)
		};
	}
	/**
	* 挂起一个等待者：直到 `last` 变得不等于 `since`、或超时、或调用方取消。
	*
	* 三种收尾对调用方是同一件事（去 `read()` 拿最新状态），所以回调不带参数——
	* 需要区分"等到了"还是"超时了"的场景并不存在。
	*
	* **唤醒发生在写入落定之后**（见两个 write 方法里 `wakeWaiters()` 的位置）：如果放在
	* `next()` 里，回调会先于 `this.sections[name] = …` 执行，调用方读到的就是**旧状态**。
	*
	* @returns 取消函数（清掉超时定时器并摘掉等待者）
	*/
	wait(args) {
		const waiter = {
			since: args.since,
			onWake: args.onWake,
			timer: void 0
		};
		this.waiters.add(waiter);
		waiter.timer = setTimeout(() => {
			this.dropWaiter(waiter);
			waiter.onWake();
		}, Math.max(0, args.timeoutMs));
		if (process.env.NODE_TEST_CONTEXT === void 0) waiter.timer.unref?.();
		return () => this.dropWaiter(waiter);
	}
	/**
	* 结束**所有**挂起的等待（插件卸载 / 宿主退出路径）。
	* 唤醒时不给区分标志：调用方据此立刻收尾，而不是留一个悬挂的响应。
	*/
	cancelAll() {
		for (const waiter of [...this.waiters]) {
			this.dropWaiter(waiter);
			waiter.onWake();
		}
	}
	/** 当前等待者数（测试 / 观测用：验证不泄漏） */
	waiterCount() {
		return this.waiters.size;
	}
	/**
	* 唤醒所有**已经过期**的等待者（唯一调用点是两个 write 方法，且必须在叶子写定之后）。
	* `since === this.last` 的跳过：那种等待者是"已经是最新"的，叫醒它等于空转。
	*/
	wakeWaiters() {
		if (this.waiters.size === 0) return;
		for (const waiter of [...this.waiters]) {
			if (waiter.since === this.last) continue;
			this.dropWaiter(waiter);
			waiter.onWake();
		}
	}
	/** 摘掉一个等待者（清定时器 + 从集合移除） */
	dropWaiter(waiter) {
		if (waiter.timer !== void 0) {
			clearTimeout(waiter.timer);
			waiter.timer = void 0;
		}
		this.waiters.delete(waiter);
	}
};

//#endregion
//#region src/host/time-context.ts
/**
* 时段划分表：[起始小时, 时段]，**按起始小时从晚到早**排列——匹配时取第一个不超过当前小时的档。
* 口径（含起始小时，0–23 全覆盖、不重叠）：
*   凌晨 0–4 / 清晨 5–6 / 早上 7–8 / 上午 9–10 / 中午 11–12 / 下午 13–16 / 傍晚 17–18 / 晚上 19–22 / 深夜 23
*/
const SLOTS = [
	[23, "深夜"],
	[19, "晚上"],
	[17, "傍晚"],
	[13, "下午"],
	[11, "中午"],
	[9, "上午"],
	[7, "早上"],
	[5, "清晨"],
	[0, "凌晨"]
];
/** 星期文案：索引 = Date.getDay()（0 = 周日） */
const WEEKDAYS = [
	"星期日",
	"星期一",
	"星期二",
	"星期三",
	"星期四",
	"星期五",
	"星期六"
];
/** 一天毫秒数（日期算术用 UTC 毫秒，避开本地时区） */
const DAY_MS = 864e5;
/** 缺省窗口：提前 3 天预热、本身 1 天、过后 3 天回味 */
const DEFAULT_AHEAD = 3;
const DEFAULT_SPAN = 1;
const DEFAULT_AFTER = 3;
/** 假期区间的窗口：提前 3 天预热、末尾 3 天说「快结束了」、结束后 3 天回味 */
const SEASON_AHEAD = 3;
const SEASON_ENDING_AHEAD = 3;
const SEASON_AFTER = 3;
/** 两位补零（只用于时分；月/日刻意不补零——中文日期写「2月17日」比「02月17日」自然） */
function pad2(n) {
	return String(n).padStart(2, "0");
}
function timeSlotOf(hour) {
	for (const [start, slot] of SLOTS) if (hour >= start) return slot;
	return "凌晨";
}
function dayKindOf(day) {
	return day === 0 || day === 6 ? "周末" : "工作日";
}
/**
* ★ 顺序 = 优先级（靠前的先说话）。编排口径：
*   ① 只有「当天」值得说、且会被邻座节日窗口挤掉的小节（情人节 / 跨年夜 / 愚人节 / 青年节）排在各自邻座之前，
*      并用 after: 0 掐掉回味，免得反过来压住邻座的当天；
*   ② 除夕、元宵必须排在春节之前：否则 2/16 会说「明天就是春节」、3/3 会说「春节假期最后一天」，
*      而不是「今天是除夕」「今天是元宵节」；
*   ③ 大节与家庭假期（春节 / 中秋 / 国庆 / 元旦 / 端午 / 清明 / 劳动节 / 寒暑假）在中段，
*      传统节日（七夕 / 中元 / 龙抬头 / 重阳 / 腊八 / 小年）紧随其后并**排在寒暑假之前**——
*      所以暑假里的七夕、寒假里的小年照常由节日说话；
*   ④ 纪念日类（妇女节 / 教师节 / 建党节 / 建军节 / 万圣夜 / 平安夜 / 圣诞节）排在最后，
*      因此暑假期间的建党节（7/1）、建军节（8/1）会让位给「正在放暑假」。
*   ⑤ 寒暑假区间放在中段之后、纪念日之前：7/1 既是建党节又是暑假首日，按本顺序由「暑假开始了」说话。
*/
const PRIORITY = [
	{
		kind: "solar",
		key: "2-14",
		name: "情人节",
		after: 0
	},
	{
		kind: "solar",
		key: "12-31",
		name: "跨年夜",
		after: 0
	},
	{
		kind: "solar",
		key: "4-1",
		name: "愚人节",
		after: 0
	},
	{
		kind: "solar",
		key: "5-4",
		name: "青年节",
		ahead: 0,
		after: 0
	},
	{
		kind: "lunarEve",
		name: "除夕",
		ahead: 1,
		after: 0
	},
	{
		kind: "lunar",
		key: "1-15",
		name: "元宵节"
	},
	{
		kind: "lunar",
		key: "1-1",
		name: "春节",
		spoken: "大年初一",
		span: 15
	},
	{
		kind: "lunar",
		key: "8-15",
		name: "中秋节",
		span: 3,
		after: 2
	},
	{
		kind: "solar",
		key: "10-1",
		name: "国庆节",
		span: 7
	},
	{
		kind: "solar",
		key: "1-1",
		name: "元旦",
		spoken: "新年第一天",
		span: 3
	},
	{
		kind: "lunar",
		key: "5-5",
		name: "端午节",
		span: 3
	},
	{
		kind: "solar",
		key: "4-4",
		name: "清明节",
		span: 3,
		ahead: 1
	},
	{
		kind: "solar",
		key: "5-1",
		name: "劳动节",
		span: 3
	},
	{
		kind: "solar",
		key: "6-1",
		name: "儿童节"
	},
	{
		kind: "lunar",
		key: "7-7",
		name: "七夕"
	},
	{
		kind: "lunar",
		key: "7-15",
		name: "中元节"
	},
	{
		kind: "lunar",
		key: "2-2",
		name: "龙抬头"
	},
	{
		kind: "lunar",
		key: "9-9",
		name: "重阳节"
	},
	{
		kind: "lunar",
		key: "12-8",
		name: "腊八节"
	},
	{
		kind: "lunar",
		key: "12-23",
		name: "小年"
	},
	{
		kind: "season",
		from: "1-20",
		to: "2-18",
		name: "寒假"
	},
	{
		kind: "season",
		from: "7-1",
		to: "8-29",
		name: "暑假"
	},
	{
		kind: "solar",
		key: "3-8",
		name: "妇女节"
	},
	{
		kind: "solar",
		key: "9-10",
		name: "教师节"
	},
	{
		kind: "solar",
		key: "7-1",
		name: "建党节"
	},
	{
		kind: "solar",
		key: "8-1",
		name: "建军节"
	},
	{
		kind: "solar",
		key: "10-31",
		name: "万圣夜"
	},
	{
		kind: "solar",
		key: "12-24",
		name: "平安夜",
		after: 0
	},
	{
		kind: "solar",
		key: "12-25",
		name: "圣诞节"
	}
];
/** 公历 / 农历 / 除夕 / 假期区间的索引（模块加载时按 PRIORITY 建一次） */
const SOLAR_INDEX = new Map();
const LUNAR_INDEX = new Map();
const SEASON_ENTRIES = [];
let LUNAR_EVE;
PRIORITY.forEach((entry, priority) => {
	if (entry.kind === "solar") SOLAR_INDEX.set(entry.key, {
		entry,
		priority
	});
	else if (entry.kind === "lunar") LUNAR_INDEX.set(entry.key, {
		entry,
		priority
	});
	else if (entry.kind === "lunarEve") LUNAR_EVE = {
		entry,
		priority
	};
	else SEASON_ENTRIES.push({
		entry,
		priority,
		from: entry.from,
		to: entry.to
	});
});
/** ICU 中国农历格式器；null = 已判定本环境不可用（不重试、不抛错） */
let lunarFormatter;
/**
* 取 ICU 农历格式器。
* Intl 在缺少该日历时**不会抛错**，而是静默退回公历——那会让每个月都被当成农历同月同日，
* 所以这里用 resolvedOptions().calendar 确认它真的解析成了 'chinese'，否则一律判不可用。
*/
function getLunarFormatter() {
	if (lunarFormatter === null) return void 0;
	if (!lunarFormatter) {
		const fmt = new Intl.DateTimeFormat("en-u-ca-chinese", {
			month: "numeric",
			day: "numeric",
			year: "numeric"
		});
		lunarFormatter = fmt.resolvedOptions().calendar === "chinese" ? fmt : null;
	}
	return lunarFormatter ?? void 0;
}
/** 年内日序号（0 起，按 UTC 计算，闰年自然正确）——假期区间比较用它 */
function dayOfYear(date) {
	return (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 1)) / DAY_MS;
}
/** '月-日' → 该年内的日序号（0 起） */
function dayOfYearOf(year, monthDay) {
	const [month, day] = monthDay.split("-").map(Number);
	return (Date.UTC(year, (month ?? 1) - 1, day ?? 1) - Date.UTC(year, 0, 1)) / DAY_MS;
}
/**
* 公历日期 → 农历月日。
* @returns 农历月/日（闰月 month 为负）；环境不支持农历、取不到月日，或**农历年与公历年不吻合**
*   （自洽校验，合理范围：公历年或公历年 − 1，用于挡住 ICU 退化时把公历当农历返回）→ undefined。
*/
function lunarPartsOf(date) {
	const fmt = getLunarFormatter();
	if (!fmt) return void 0;
	const parts = fmt.formatToParts(date);
	const pick = (type) => parts.find((p) => p.type === type)?.value;
	const rawMonth = pick("month");
	const rawDay = pick("day");
	const rawYear = pick("relatedYear") ?? pick("year");
	if (!rawMonth || !rawDay || !rawYear) return void 0;
	const month = Number.parseInt(rawMonth, 10);
	const day = Number.parseInt(rawDay, 10);
	const year = Number.parseInt(rawYear, 10);
	if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) return void 0;
	const gregorianYear = date.getFullYear();
	if (year !== gregorianYear && year !== gregorianYear - 1) return void 0;
	return {
		month: /bis/i.test(rawMonth) ? -month : month,
		day
	};
}
/** 当天是否是除夕（腊月最后一天：次日为正月初一即成立，廿九/三十都能认） */
function isLunarEve(date) {
	const today = lunarPartsOf(date);
	if (!today || today.month !== 12) return false;
	const next = lunarPartsOf(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1));
	return Boolean(next && next.month === 1 && next.day === 1);
}
/** 某一天命中的全部条目（公历、农历、除夕三类；假期区间不按天查，另行处理） */
function entriesAt(date) {
	const out = [];
	const solar = SOLAR_INDEX.get(date.getMonth() + 1 + "-" + date.getDate());
	if (solar) out.push(solar);
	const lunar = lunarPartsOf(date);
	if (lunar && lunar.month > 0) {
		const hit = LUNAR_INDEX.get(lunar.month + "-" + lunar.day);
		if (hit) out.push(hit);
	}
	if (LUNAR_EVE && isLunarEve(date)) out.push(LUNAR_EVE);
	return out;
}
/**
* 相位 → 从句措辞。
* @param delta 相对**节日起始日**的天数：> 0 = 还有这么多天；0 = 起始当天；< 0 = 已在节期内或过后
*/
function phraseOf(entry, delta) {
	const span = entry.span ?? DEFAULT_SPAN;
	if (delta > 0) return delta === 1 ? "明天就是" + entry.name : "快要过" + entry.name + "了";
	if (delta === 0) return "今天是" + (entry.spoken ?? entry.name);
	const daysIn = -delta;
	if (daysIn < span) return span - daysIn === 1 ? entry.name + "假期最后一天了" : "还在" + entry.name + "假期里";
	const rest = daysIn - span;
	return rest <= 1 ? entry.name + "刚过完" : entry.name + "这么快就过完了";
}
/**
* 条目 → 候选从句（不在自身窗口内则返回 undefined）。
* @param delta 相对节日起始日的天数
*/
function candidateOf(ranked, delta) {
	const { entry, priority } = ranked;
	const ahead = entry.ahead ?? DEFAULT_AHEAD;
	const span = entry.span ?? DEFAULT_SPAN;
	const after = entry.after ?? DEFAULT_AFTER;
	const daysIn = -delta;
	if (delta > 0) {
		if (delta > ahead) return void 0;
	} else if (delta < 0) {
		if (daysIn >= span + after) return void 0;
	}
	return {
		clause: phraseOf(entry, delta),
		priority
	};
}
/** 假期区间 → 候选从句（不在窗口内返回 undefined） */
function seasonCandidateOf(date) {
	const year = date.getFullYear();
	const today = dayOfYear(date);
	for (const ranked of SEASON_ENTRIES) {
		const { entry, priority, from: fromMd, to: toMd } = ranked;
		const name = entry.name;
		const from = dayOfYearOf(year, fromMd);
		const to = dayOfYearOf(year, toMd);
		if (today < from) {
			const ahead = from - today;
			if (ahead > SEASON_AHEAD) continue;
			return {
				clause: ahead === 1 ? "明天就放" + name + "了" : "快要放" + name + "了",
				priority
			};
		}
		if (today <= to) {
			if (today === from) return {
				clause: name + "开始了",
				priority
			};
			if (to - today < SEASON_ENDING_AHEAD) return {
				clause: name + "快结束了",
				priority
			};
			return {
				clause: "正在放" + name,
				priority
			};
		}
		const rest = today - to - 1;
		if (rest >= SEASON_AFTER) continue;
		return {
			clause: rest <= 1 ? name + "刚结束" : name + "这么快就过完了",
			priority
		};
	}
	return void 0;
}
/** 条目里最长的预热天数与回看距离（长假 15 天 + 回味 3 天），据此决定扫描窗口 */
const HOLIDAY_ENTRIES = PRIORITY.filter((e) => e.kind !== "season");
const MAX_AHEAD = Math.max(...HOLIDAY_ENTRIES.map((e) => e.ahead ?? DEFAULT_AHEAD));
const MAX_LOOKBACK = Math.max(...HOLIDAY_ENTRIES.map((e) => (e.span ?? DEFAULT_SPAN) - 1 + (e.after ?? DEFAULT_AFTER)));
/**
* 节日从句：扫描窗口内枚举每一天命中的条目、算出各自相位与措辞，取**优先级最小**（数组里最靠前）的那个。
* @returns 如「今天是大年初一」「快要过国庆节了」「还在春节假期里」「正在放暑假」；无节日时 ''
*/
function holidayClauseOf(date) {
	let best;
	const keep = (candidate) => {
		if (candidate && (!best || candidate.priority < best.priority)) best = candidate;
	};
	for (let delta = -MAX_LOOKBACK; delta <= MAX_AHEAD; delta++) {
		const day = new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
		for (const ranked of entriesAt(day)) keep(candidateOf(ranked, delta));
	}
	keep(seasonCandidateOf(date));
	return best ? best.clause : "";
}
function timeContextOf(date) {
	if (Number.isNaN(date.getTime())) return "";
	const day = date.getDay();
	const hour = date.getHours();
	const holiday = holidayClauseOf(date);
	return "【当下】现在是" + date.getFullYear() + "年" + (date.getMonth() + 1) + "月" + date.getDate() + "日" + (WEEKDAYS[day] ?? "星期?") + " " + pad2(hour) + ":" + pad2(date.getMinutes()) + "，" + timeSlotOf(hour) + "，" + dayKindOf(day) + (holiday ? "，" + holiday : "") + "。这只是背景，不必刻意报时，也别句句都提节日——多数时候正常说话就好，真贴切时才顺口带一句。";
}

//#endregion
//#region src/host/persona.ts
function petPersona(conf, pet) {
	const own = pet.whisperPrompt;
	if (typeof own === "string" && own.trim() !== "") return own;
	const entry = conf.whisperPrompt;
	return typeof entry === "string" ? entry : "";
}
function composeSystemPrompt(parts) {
	const name = String(parts.name || parts.id);
	const nameLine = name ? "你的名字是“" + name + "”。" : "";
	const lines = [parts.prompt, nameLine].filter((line) => line !== "");
	const time = timeContextOf(parts.now);
	if (time) lines.push(time);
	return lines.join("\n");
}

//#endregion
//#region src/host/index.ts
/** 本包目录：宿主构建产物位于 lib/，其上一级即包根。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
/** 包内 assets 根 */
const PACKAGE_ROOT_ASSETS = join(PACKAGE_ROOT, "assets");
/** 包内表情包目录（表情包池的最后一环：assets/memes/<名称>.png） */
const PACKAGE_MEMES_DIR = join(PACKAGE_ROOT_ASSETS, "memes");
/** 路由前缀 */
const ROUTE_PREFIX = "/dsh-pet-7340";
/**
* 宿主是不是 **DSH 桌面应用**（Electron 宿主）。
*
* 判据只用 `process.versions.electron`：桌面应用以 `ELECTRON_RUN_AS_NODE=1` 跑宿主（见 dsh.cmd），
* 该字段照样在；而 `dsh web` / 独立模式都是纯 Node 进程，取不到它。据此把「打开网站」自动分派：
* 桌面宿主 → 唤起桌面应用窗口（helper 走 `dsh://open`），其余 → 浏览器打开站点。
*/
const isDesktopHost = () => Boolean(process.versions.electron);
/** 不同扩展名对应的 Content-Type 映射 */
const MIME = {
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mp4": "video/mp4",
	".png": "image/png",
	".json": "application/json; charset=utf-8",
	".jsonc": "application/json; charset=utf-8",
	".ttf": "font/ttf",
	".woff": "font/woff",
	".woff2": "font/woff2"
};
/**
* 规范化并校验请求路径，确保它在 assets 根目录内（防路径穿越）。
* @returns 规范化后的绝对文件路径；非法（穿越）时返回 undefined
*/
function resolveAsset(root, rel) {
	if (rel.length === 0) return void 0;
	const candidate = normalize(join(root, rel));
	const rootWithSep = root.endsWith(sep) ? root : root + sep;
	if (candidate !== root && !candidate.startsWith(rootWithSep)) return void 0;
	return candidate;
}
/** 在 root 下解析并确认实体存在；非法（穿越）或不存在时返回 undefined */
function resolveExisting(root, rel) {
	const candidate = resolveAsset(root, rel);
	return candidate && existsSync(candidate) ? candidate : void 0;
}
/**
* 流式返回一个文件（带 Content-Type / 长度 / 缓存头）。
*
* Content-Length 必须取自**正在读的那个 fd**（open 事件里 fstat），不能先 stat 再另开流：用户往
* $DSH_HOME/dsh-pet/main-animation/webm/ 复制或同名覆盖素材时，stat 与真正开始读之间文件会被截断/
* 改写，一旦实际字节数少于声明的长度，这个响应就**永远不结束、也不报错**（浏览器表现为 stalled、
* 视频 loadeddata 永不触发且无 error）——正是 issue #62 现场"数据断供"的一种成因。同一个 fd 的
* fstat 拿到的大小与随后读出的字节天然一致。
*/
function sendFile(res, file, contentType) {
	const stream = createReadStream(file);
	stream.once("open", (fd) => {
		if (res.destroyed || res.writableEnded) {
			stream.destroy();
			return;
		}
		try {
			res.writeHead(200, {
				"content-type": contentType,
				"content-length": fstatSync(fd).size,
				"cache-control": "public, max-age=3600"
			});
		} catch {
			res.writeHead(200, {
				"content-type": contentType,
				"cache-control": "public, max-age=3600"
			});
		}
		stream.pipe(res);
	});
	stream.on("error", () => res.destroy());
	res.on("close", () => stream.destroy());
}
/** 该宠物是否参与桌面模式（Electron 透明窗） */
const isDesktopVisible$1 = (display) => display === "desktop" || display === "both";
/** 发送 JSON 响应（headers 可选：如 no-cache 触发计数） */
function sendJson$1(res, status, obj$1, headers = {}) {
	const body = JSON.stringify(obj$1);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		...headers
	});
	res.end(body);
}
/** 发送纯文本响应（素材 404/400 等显式错误文案） */
function sendText(res, status, body) {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
	res.end(body);
}
/** 收集请求体（文本） */
function readBody(req) {
	return new Promise((resolve2, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve2(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
function apply(ctx) {
	const dshHome = dshHomeDir();
	const userRoot = join(dshHome, "dsh-pet");
	const userConfigPath = join(userRoot, "main-config.jsonc");
	const legacyUserConfigPath = join(userRoot, "main-config.json");
	const petConfigDir = join(userRoot, "pet");
	const configPaths = {
		defaultFile: join(PACKAGE_ROOT, "assets", "config.jsonc"),
		userFile: userConfigPath,
		legacyUserFile: legacyUserConfigPath,
		petDir: petConfigDir
	};
	migrateUserConfig(configPaths, (msg) => console.log("[dsh-pet] " + msg));
	const thumbUserRoot = join(userRoot, "main-animation");
	const memesUserRoot = join(userRoot, "memes");
	/**
	* 表情包目录链 —— 与动画素材（/thumb）**同一套素材归属语义**：
	*   - `pet/<素材根>-memes/` 存在（种类自带表情包）：**只查它**，池与路由都不回落——
	*     查不到即 404 / 该条目剔除（与 `pet/<素材根>-animation/` 的独占规则逐字一致）；
	*   - 否则：用户目录 `$DSH_HOME/dsh-pet/memes/` 优先，其次包内 `assets/memes/`（逐文件合并，
	*     与「main-animation/<ext> → 包内 assets/<ext>」的主素材链同构）。
	* 池（readMemePool）与路由（/pic/memes）必须走**同一个函数**：池里能选的名字，
	* 路由必须取得到，否则气泡配图会图裂。
	* 素材根一律先过 resolveAsset：它来自 URL 段，Windows 上 %5C 解出的反斜杠不会被
	* rest.split('/') 切开，直接 join 会让 `..\..\x` 逃出用户根读盘（与 /thumb 同一道防线）。
	*/
	const memeDirsFor = (assetRoot) => {
		const own = resolveAsset(petConfigDir, assetRoot + "-memes");
		if (own !== void 0 && existsSync(own)) return [own];
		return [memesUserRoot, PACKAGE_MEMES_DIR];
	};
	const state = new PollStateStore();
	const menuRegistry = new MenuRegistry();
	ctx.provide("petApi7340", { balance: {
		register: registerBalanceProvider,
		list: listBalanceProviders
	} });
	const playback = new PlaybackStore();
	const workStatus = new WorkStatusStore();
	/** 外部写入槽：固定会话 id，最后写入者生效；不做多写者仲裁/租约/会话管理 */
	const EXTERNAL_WORK_SESSION = "api";
	let externalWorkSeq = 0;
	const WORK_STATE_GAP_MS = 5e3;
	/** 忙碌档：只有这两个档位之间的互切算"抖动"，其余档位变化一律立即写 */
	const isBusyTier = (s) => s === "working" || s === "result";
	let publishedWork = "\0";
	let publishedState = null;
	let publishedTask = null;
	let publishedWorkAt = 0;
	let workFlushTimer = null;
	const publishWorkStatus = () => {
		const snap = workStatus.snapshot();
		const key = String(snap.state) + "\0" + String(snap.task);
		if (key === publishedWork) return;
		const churn = snap.task === publishedTask && isBusyTier(publishedState) && isBusyTier(snap.state);
		const wait = WORK_STATE_GAP_MS - (Date.now() - publishedWorkAt);
		if (churn && wait > 0) {
			workFlushTimer ??= setTimeout(() => {
				workFlushTimer = null;
				publishWorkStatus();
			}, wait);
			return;
		}
		if (workFlushTimer !== null) {
			clearTimeout(workFlushTimer);
			workFlushTimer = null;
		}
		publishedWork = key;
		publishedState = snap.state;
		publishedTask = snap.task;
		publishedWorkAt = Date.now();
		state.writeSection("workStatus", {
			state: snap.state,
			task: snap.task
		});
	};
	const lock = new LockStore({ onChange: (petId, data) => state.writePet(petId, "lock", data) });
	const pose = new PoseStore();
	/**
	* `?surface=` 的**参数级**校验（缺省 / 非法 → `bad-request`）。放在读盘之前：必然失败的请求
	* 不碰磁盘（与 pet 空串同一处境）。通过则给出收窄后的取值。
	*/
	const surfaceParam = (params) => {
		const want = normalizeSurface(params.get("surface"));
		if (want !== null) return {
			ok: true,
			want
		};
		return {
			ok: false,
			res: {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason: "bad-request",
					message: SURFACE_TEXT
				}
			}
		};
	};
	/**
	* `?surface=` 与该宠物 `display` 的对齐校验（issue #122 第 1 条）：不满足 → `pet-not-displayed`
	* + **实际 display 原样回给调用方**（调用方据此一眼知道该怎么办），放行回 null。
	*
	* 这是**前置校验**，不是按面分发——指令照旧写进同一个叶子、两端内容照旧完全一致
	* （要"网页播 A、桌面播 B"用两只宠物表达，见 ./surface 的第 1 条边界）。
	*/
	const surfaceMismatch = (pet, petId, want) => {
		const display = String(pet.display ?? "");
		if (displayCovers(want, display)) return null;
		return {
			kind: "json",
			status: 200,
			obj: {
				ok: false,
				reason: "pet-not-displayed",
				message: petId + " 的显示模式是 " + display + "，不满足 surface=" + want,
				display
			}
		};
	};
	/**
	* 决策函数**之后**的 surface 校验（`/anim`、`/broadcast`、`/bubble/clear`、`/position`、
	* `/throw` 共用）：这五条的 pet 解析住在各自的决策模块里，所以这里按 `petId` 再查一次实例取
	* `display`（配置已在手，成本可忽略）。放行回 null。
	*
	* 位置与 `lockBlocked` 一致——都在决策函数之后、任何副作用之前，所以校验顺序是
	* 「body → pet → surface → 锁」。
	*/
	const surfaceBlocked = (cfg, petId, params) => {
		const p = surfaceParam(params);
		if (!p.ok) return p.res;
		return surfaceMismatch(findPetInstance(cfg, petId)?.pet ?? {}, petId, p.want);
	};
	/**
	* 路由层的 pet 参数解析（`/lock`、`/lock/release`、`/whisper`、`/chat` 用——这四条没有独立决策层；
	* `/anim`、`/broadcast`、`/bubble/clear`、`/position`、`/throw` 的同一套校验住在各自的决策模块里，
	* 口径与这里逐字一致）：**必填**且必须真实存在。
	*
	* 两种失败分开报（issue #122 第 1 条「绝不默认退到列表第一只」）：
	* 没给 / 空串 → `pet-required`；给了但配置里没有 → `unknown-pet`。
	*
	* 收紧前这四条是 `get('pet') || resolveActivePetId() || 'main'`：缺省会落到"当前桌宠"
	* = **有效宠物列表第一只**（`/whisper`、`/chat` 更彻底——`?? ''` 直接空串：人设按 main 条目取、
	* 生成结果写进没人消费的 `pets[""].say`，还回 ok:true——钱花了、话丢了、调用方以为成功）。
	* 落点随用户 /pet 操作而变、失败也不报，第三方无从预期，故整条缺省链已删除：
	* pet 与 `/pet-display` 的 `id` 一样是必填项。
	*
	* `cfg` 传**惰性读取**：pet 空串时不必碰磁盘（与 /broadcast 的 text/duration 同一处境，
	* routes.test.ts 里"配置不可达"那一组断言正是靠这个顺序钉住的）。
	*
	* `opts.surface` = 是否同时校验 `?surface=`。**只对会产生渲染端可见效果的端点开**：
	* `/lock`、`/whisper`、`/chat` 的 POST。`/lock/release` 与 `/chat` 的 GET 不开——
	* 释放必须永远能成功（否则宠物中途被隐藏就撤不掉锁），读记忆与显示在哪一端无关。
	*/
	const requirePet = (params, cfg, opts) => {
		const fail$1 = (reason, message) => ({
			ok: false,
			res: {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason,
					message
				}
			}
		});
		const petId = String(params.get("pet") ?? "").trim();
		if (!petId) return fail$1("pet-required", "pet 必填：要指定操作哪只桌宠");
		let want = null;
		if (opts?.surface === true) {
			const p = surfaceParam(params);
			if (!p.ok) return {
				ok: false,
				res: p.res
			};
			want = p.want;
		}
		const found = findPetInstance(cfg(), petId);
		if (!found) return fail$1("unknown-pet", "没有这只桌宠：" + petId);
		if (want !== null) {
			const mismatch = surfaceMismatch(found.pet, petId, want);
			if (mismatch) return {
				ok: false,
				res: mismatch
			};
		}
		return {
			ok: true,
			petId,
			entry: found.entry,
			conf: found.conf,
			pet: found.pet
		};
	};
	/**
	* 动作端点的占用门禁（`/anim`、`/broadcast`、`/position`、`/throw`、`/bubble/clear` 共用）：
	* 放行回 null，否则直接给出路由应答。抽成一个函数，是为了让"哪些接口受占用约束"只有一处可查。
	*
	* **无锁时按「有没有带 `lock`」分流**：没带 → 返回 null（既有调用方一个字都不用改）；
	* 带了但查不到锁 → `lock-lost`，旧租约不能继续执行迟到请求。
	* 没带这一支就是「不传 lock = 现状零变化」（issue #122 最重要的边界）的落点。
	*
	* 位置放在决策函数**之后**：`petId` 要先解析出来才知道问哪只宠物的锁，而这时还没有任何副作用
	* （没写叶子、没建播放记录、没调模型）。所以"先判锁再干活"这个意图是满足的，只是与
	* body 校验的先后为「body → pet → 锁」——两者都不合法时报的是 body 的错。
	*/
	const lockBlocked = (petId, params) => {
		const g = lock.gate(petId, String(params.get("lock") ?? ""));
		if (g.ok) return null;
		return {
			kind: "json",
			status: 200,
			obj: g.reason === "lock-lost" ? {
				ok: false,
				reason: g.reason,
				cause: g.cause,
				message: g.message
			} : {
				ok: false,
				reason: g.reason,
				message: g.message
			}
		};
	};
	const pushNotifyFrame = (frame) => {
		state.writeSection("notify", frame);
	};
	const turnFlags = new Map();
	/** 终态（success/error）展示窗口定时器：约 60s 后清掉该会话条目，陈旧完成态不再浮上来（Bug 2/3） */
	const terminalTimers = new Map();
	const TERMINAL_KEEP_MS = 60 * 1e3;
	/** 取消某会话待执行的终态清理：会话已回到非终态，那次清理到点后既不清理也不重排，留着只会误导 */
	const cancelTerminalCleanup = (sessionId) => {
		const t = terminalTimers.get(sessionId);
		if (t === void 0) return;
		clearTimeout(t);
		terminalTimers.delete(sessionId);
	};
	/** 排一个终态清理定时器（每会话一个，已排则跳过） */
	const scheduleTerminalCleanup = (sessionId) => {
		if (terminalTimers.has(sessionId)) return;
		const t = setTimeout(() => {
			terminalTimers.delete(sessionId);
			const sessionState = workStatus.stateOf(sessionId);
			if (sessionState === "success" || sessionState === "error") {
				workStatus.clear(sessionId);
				turnFlags.delete(sessionId);
				publishWorkStatus();
			}
		}, TERMINAL_KEEP_MS);
		terminalTimers.set(sessionId, t);
	};
	const NOTIFY_ACTIVITY_DELAY_MS = 1500;
	/** 每会话一个待查定时器（同会话连续收尾只保留最后一次：后到覆盖先到，与单槽帧同语义） */
	const notifyActivityTimers = new Map();
	/** 这条会话是否还有在跑的活；判据不可用一律 false＝放行 */
	const sessionHasRunningWork = async (sessionId) => {
		const waterfall = ctx.waterfall;
		if (typeof waterfall !== "function") return false;
		try {
			const activity = await waterfall.call(ctx, "workspace/session-activity", { sessionId }, () => Promise.resolve([]));
			return hasBlockingActivity(activity);
		} catch {
			return false;
		}
	};
	/** 排一个活动门定时器：到点确认空闲才推这一帧 */
	const scheduleCompletionNotify = (sessionId, event) => {
		const prev = notifyActivityTimers.get(sessionId);
		if (prev !== void 0) clearTimeout(prev);
		notifyActivityTimers.set(sessionId, setTimeout(() => {
			notifyActivityTimers.delete(sessionId);
			(async () => {
				if (await sessionHasRunningWork(sessionId)) return;
				const frame = reduceNotifyFrame(event);
				if (frame) pushNotifyFrame(withSessionId(frame, sessionId));
			})();
		}, NOTIFY_ACTIVITY_DELAY_MS));
	};
	let activePetId = "";
	const lastWhisperAt = new Map();
	const memoryPath = join(userRoot, "memory.json");
	const interactiveLogPath = join(userRoot, "interactive.json");
	const interactiveInflight = new Set();
	let chatQueue = Promise.resolve();
	/** 读记忆文件：不存在 → 空；损坏 → 显式报错 + 备份原始文件（绝不静默丢数据）+ 重建空记忆 */
	const readMemory = async () => {
		let raw;
		try {
			raw = await readFile(memoryPath, "utf8");
		} catch {
			return {};
		}
		try {
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object") throw new Error("not an object");
			return parsed;
		} catch (e) {
			console.error(`dsh-pet: 记忆文件损坏已备份（对话将从头开始）：${memoryPath}（${e instanceof Error ? e.message : String(e)}）`);
			try {
				await mkdir(userRoot, { recursive: true });
				await writeFile(`${memoryPath}.bak-${Date.now()}`, raw, "utf8");
			} catch {}
			return {};
		}
	};
	const writeMemory = async (mem) => {
		await mkdir(userRoot, { recursive: true });
		await writeFile(memoryPath, JSON.stringify(mem, null, 2), "utf8");
	};
	/** 把一次读写封进串行队列（同进程内防交错），返回 fn 的结果 */
	const withMemoryLock = (fn) => {
		const run$1 = chatQueue.then(fn, fn);
		chatQueue = run$1.then(() => void 0, () => void 0);
		return run$1;
	};
	/** 某宠物的最终人设 system：**实例级** `pets[].whisperPrompt` 优先，没写回落到所属条目
	*  （写在该条目 `pets` 里的实例 → 那个条目；主配置的实例 → `main`）的 whisperPrompt（合并器已填默认）。
	*  拼装本身在 ./persona（纯函数、有单测）：人设正文 + 一句名字声明（name，缺失已按 id）+ 一行时间背景
	*  （日期/星期/时刻/时段/工作日或周末/节日）——碎碎念与对话共用同一份拼装。
	*  时间每次现算（这里传 new Date()），所以拿到的永远是**当前**时刻，不需要额外的刷新机制。
	*
	*  收 `findPetInstance` 的**命中结果**而不是 `(petId, cfg)`：两个调用方都已经解析过了，这里再查一次
	*  只会多出一处"查不到就兜底 main"的不可达分支。 */
	const petSystemPrompt = (found) => composeSystemPrompt({
		prompt: petPersona(found.conf, found.pet),
		name: String(found.pet.name ?? ""),
		id: String(found.pet.id ?? ""),
		now: new Date()
	});
	/** 对话记忆轮数（1 轮 = 1 问 1 答）：该宠物**所属条目**的 chatMemoryRounds（合并器已填默认非负数字）。
	*  同样收**已解析的条目配置**：两个调用方都已经拿到 `findPetInstance` 的结果。 */
	const memoryRounds = (conf) => {
		const v = Number(conf.chatMemoryRounds);
		return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 5;
	};
	/** 生成/返回某宠物的一句碎碎念（周期 GET 与菜单手动触发共用的同一逻辑）：
	*  每只宠物独立生成（人设 = 它自己的 whisperPrompt，没写回落到所属条目）。生成成功就写进 S 的 pets.<id>.say——
	*  碎碎念 / 命令气泡 / 对话回复在前端本来就是**同一条展示链路**（同一个 triggerWhisper、
	*  同一个气泡槽、同一批 events.whisper 动画），所以合并成同一个叶子；"周期内不重复"由
	*  调度侧的 lastWhisperAt 保证，不再需要一份 whisperCache（多端共享也由 S 天然保证）。
	*  配图（whisperImageEnabled 开启时）：从表情包池**随机抽 1 张**，把描述注入指令并随文本一起写。
	*
	*  失败**带回真实 reason**（含 `unknown-pet`：目标宠物在"校验那次读"与这里之间被删掉了）。
	*  成功**带回生成的文本**（与同时写进叶子的那份完全相同）——调用方拿到就不必再拉一拍 /state。 */
	const publishWhisper = async (petId) => {
		const cfg = readAllConfig(configPaths);
		const found = findPetInstance(cfg, petId);
		if (!found) return {
			ok: false,
			reason: "unknown-pet",
			message: "没有这只桌宠：" + petId
		};
		const system = petSystemPrompt(found);
		const meme = found.conf.whisperImageEnabled === true ? pickMeme(readMemePool(found.conf.memes, memeDirsFor(found.entry))) : void 0;
		const result = await generateWhisper(ctx, system, meme, configuredModel(found.conf, "whisperModel"));
		if (!result.ok) {
			console.warn("[dsh-pet] 碎碎念生成失败 pet=" + petId + " reason=" + result.reason + (result.message ? " " + result.message : ""));
			return result;
		}
		state.writePet(petId, "say", result.image ? {
			text: result.text,
			image: result.image
		} : { text: result.text });
		return {
			ok: true,
			text: result.text,
			...result.image ? { image: result.image } : {}
		};
	};
	/** 与某只宠物对话：截取最近记忆 → 生成回复 → 写入记忆 → 把回复写进 S 的 pets.<id>.say。
	*  供 POST /chat（动作端点）与 /chat 命令共用同一条路径（锁内读写，防两端交错写盘）。
	*  配图（chatImageEnabled 开启时）：把表情包清单交给模型按语境选一张，命中池内才随回复写回。
	*  成功**带回回复文本**（与同时写进叶子的那份完全相同）——调用方拿到就不必再拉一拍 /state。 */
	const chatWithPet = async (petId, text) => withMemoryLock(async () => {
		const cfg = readAllConfig(configPaths);
		const found = findPetInstance(cfg, petId);
		if (!found) return {
			ok: false,
			reason: "unknown-pet",
			message: "没有这只桌宠：" + petId
		};
		const rounds = memoryRounds(found.conf);
		const system = petSystemPrompt(found);
		const pool = found.conf.chatImageEnabled === true ? limitPool(readMemePool(found.conf.memes, memeDirsFor(found.entry)), Number(found.conf.chatImageLimit)) : [];
		const mem = await readMemory();
		const bucket = mem[found.entry] ??= {};
		const entry = bucket[petId] ??= { messages: [] };
		const list = sliceMemoryRounds(entry.messages, rounds);
		const generated = await generateChat(ctx, system, list, text, pool, configuredModel(found.conf, "chatModel"));
		if (!generated.ok) return generated;
		const now = Date.now();
		entry.messages.push({
			role: "user",
			content: text,
			ts: now
		});
		entry.messages.push({
			role: "assistant",
			content: generated.text,
			ts: now
		});
		await writeMemory(mem);
		state.writePet(petId, "say", generated.image ? {
			text: generated.text,
			image: generated.image
		} : { text: generated.text });
		return {
			ok: true,
			text: generated.text,
			...generated.image ? { image: generated.image } : {}
		};
	});
	/**
	* 当前生效宠物列表 = readAllConfig 成品拍平（main + 文件宠物全部条目；合并器已保证 id 唯一、
	* 字段填满），命令与桌面模式都从这里取。
	*/
	const effectivePetList = () => flattenPetList(readAllConfig(configPaths));
	/** 余额刷新周期（秒）：成品 main 条目的 eventsRefreshSec.balance（合并器已填默认；非法兜底 1800） */
	const balancePeriodSec = (cfg) => {
		const ers = cfg.main?.eventsRefreshSec;
		const n = Number(ers?.balance);
		return Number.isFinite(n) && n > 0 ? n : 1800;
	};
	/** 碎碎念周期（秒）：该宠物**所属条目**的 eventsRefreshSec.whisper（合并器已填默认；非法兜底 300）。
	*  收**已解析的条目配置**：唯一调用方是周期调度，而它的 `petId` 就是从**同一份 cfg** 拍平出来的，
	*  所以这里再查一次只会多出一处"查不到就兜底 main"的不可达分支。 */
	const whisperPeriodSec = (conf) => {
		const ers = conf.eventsRefreshSec;
		const n = Number(ers?.whisper);
		return Number.isFinite(n) && n > 0 ? n : 300;
	};
	/**
	* 刷新余额并写入 S —— host 侧**唯一**的余额查询点。
	*
	* 改造前是每个客户端各自按自己的定时器去查（浏览器一个 + 桌面每窗口一个）：同一份外部 API
	* 被重复请求、两端还可能看到新旧不一致的数据。现在只有这里查，两端都从 /state 读同一份结果。
	*
	* 失败也写进 S（reason 区分 unsupported / credential-missing / fetch-error）——余额不可用要弹
	* 文字说明气泡，不能静默；意外异常同样落成 fetch-error，不吞。
	*
	* @param manual 这次刷新是不是"用户要的"（/balance 命令、桌面「查看余额」菜单）。
	*   标记随数据一起写进叶子：只有 host 知道是谁要的，前端据此决定余额不可用时要不要**必弹**
	*   文字说明（decideBalanceNotice 的 explicit；周期刷新则只在原因变化时弹一次，免得反复刷屏）。
	*/
	/**
	* 账号服务要求的调用方身份（`AccountClientMetadata`）：Platform 用它派生五个客户端头，
	* 只影响**请求来源标识**与**服务端本地化文案**，不参与余额数值与币种。
	*
	* - version：本插件版本（读自身 package.json；读不到回落 '0.0.0'——该字段只是标识）
	* - locale：本插件是中文产品，固定 `zh-CN`（Platform 侧归一到 zh_CN）
	* - timezoneOffsetSeconds：本机 UTC 偏移（东八区为 +28800）
	*/
	const accountClientMetadata = () => {
		let version = "0.0.0";
		try {
			const raw = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
			if (typeof raw.version === "string" && raw.version.length > 0) version = raw.version;
		} catch {}
		return {
			version,
			locale: "zh-CN",
			timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
		};
	};
	const refreshBalance = async (manual = false) => {
		const mark = (v) => manual ? {
			...v,
			manual: true
		} : v;
		try {
			const sel = ctx.agentDefaultModel.currentSelection();
			const result = await queryBalance(
				sel.provider,
				async (ref) => {
					const rc = await ctx.credentials.resolve(credentialRef(ref));
					return rc?.value;
				},
				// `deepseek-account`（免费额度 / 平台登录）没有 API Key：它的凭证是 DSH 账号服务
				// 持有的授权记录，只能经 getBalance 查询。账号服务是**可选**服务（软取，不放进
				// inject）——没装账号插件时它不在场，此时该路由报 credential-missing 而不是崩。
				async () => {
					const account = ctx.get("deepseekAccount", false);
					if (!account) return void 0;
					return account.getBalance(accountClientMetadata());
				}
);
			state.writeSection("balance", mark(result));
		} catch (e) {
			state.writeSection("balance", mark({
				ok: false,
				provider: "unknown",
				reason: "fetch-error",
				message: e instanceof Error ? e.message : String(e)
			}));
		}
	};
	/** 当前交互桌宠 id：/pet 已选且仍存在 → 该宠物；未选/已失效 → 有效宠物列表第一只（进程内，重启回默认） */
	const resolveActivePetId = () => {
		try {
			const eff = effectivePetList();
			if (eff.length === 0) return "";
			if (activePetId && eff.some((p) => String(p.id) === activePetId)) return activePetId;
			return String(eff[0].id);
		} catch {
			return activePetId;
		}
	};
	/** 宠物的显示名（name，缺失回落 id）——命令文案用 */
	const petDisplayName = (pet) => {
		const n = String(pet.name ?? "").trim();
		return n || String(pet.id ?? "");
	};
	let hasDesktopPet = false;
	/**
	* 桌面模式是否**曾经**成功启动过（粘性，仅本插件生命周期内有效）。
	* 把「没有桌面宠物就不启动」放宽成「从来没有过桌面宠物才不启动」：桌面宠物被全部改成
	* web/none 之后，Helper 仍会带着空宠物列表重启并常驻——因为托盘（桌面端显示开关）是此时
	* 唯一还能把宠物切回桌面的入口，Helper 一退它就没了。
	* 纯浏览器用户（从未有过桌面宠物）不受影响：照旧不探测、不下载、不拉起 Electron。
	*/
	let desktopModeEverActive = false;
	const refreshDesktop = () => {
		hasDesktopPet = false;
		try {
			hasDesktopPet = effectivePetList().some((p) => isDesktopVisible$1(p.display));
		} catch (e) {
			ctx.logger?.warn?.(`[dsh-pet] 宠物配置非法，桌面模式已跳过：${e instanceof Error ? e.message : String(e)}`);
		}
	};
	refreshDesktop();
	/** 桌面可见宠物列表（[{id,size}]）：透传 Helper 决定创建几个局部窗口（每宠物一个）。 */
	const desktopPetList = () => {
		try {
			return effectivePetList().filter((p) => isDesktopVisible$1(p.display)).map((p) => ({
				id: String(p.id),
				size: Number(p.size)
			}));
		} catch {
			return [];
		}
	};
	let helper;
	let startRetryTimer;
	let electronEnsure;
	let disposed = false;
	/** 「无图形环境」提示只在进程生命周期内打一次，避免守护循环刷屏 */
	let displayWarned = false;
	/** 用已确认存在的 Electron 路径拉起桌面 Helper（每只桌面宠物一个局部小窗口）。 */
	const launchHelper = (electronPath) => {
		if (helper || disposed) return;
		if (!hasDesktopPet && !desktopModeEverActive) return;
		const port = typeof ctx.webServer?.port === "number" ? ctx.webServer.port : 0;
		if (!port || port <= 0) {
			if (!startRetryTimer) {
				startRetryTimer = setTimeout(() => {
					startRetryTimer = void 0;
					launchHelper(electronPath);
				}, 500);
				startRetryTimer.unref?.();
			}
			return;
		}
		const origin = `http://127.0.0.1:${port}`;
		const siteUrl = ctx.connection.authenticatedUrl(origin);
		const configUrl = `${origin}${ROUTE_PREFIX}/config`;
		helper = new HelperProcess({
			electronPath,
			env: {
				DSH_PET_CONFIG_URL: configUrl,
				DSH_PET_SITE_URL: siteUrl,
				DSH_PET_OPEN_TARGET: isDesktopHost() ? "desktop" : "site",
				DSH_PET_SCALE: "1",
				DSH_PET_BRIDGE: "1",
				DSH_PET_PETS: JSON.stringify(desktopPetList())
			},
			bridgeHandler: async (req) => {
				const result = await handlePetRoute(req.url ?? "/", req.method ?? "GET", req.body);
				if (result.kind === "file") return {
					id: req.id,
					status: 200,
					contentType: result.contentType,
					file: result.file
				};
				if (result.kind === "text") return {
					id: req.id,
					status: result.status,
					contentType: "text/plain; charset=utf-8",
					body: result.body
				};
				if (result.kind === "none") return {
					id: req.id,
					status: 204,
					contentType: "text/plain; charset=utf-8",
					body: ""
				};
				return {
					id: req.id,
					status: result.status,
					contentType: "application/json; charset=utf-8",
					body: JSON.stringify(result.obj)
				};
			}
		}, ctx.logger ?? console);
		try {
			helper.start();
			desktopModeEverActive = true;
			ctx.logger?.info?.(`dsh-pet desktop helper started (config: ${configUrl})`);
		} catch (e) {
			ctx.logger?.warn?.(`dsh-pet desktop helper start failed: ${e instanceof Error ? e.message : String(e)}`);
			helper = void 0;
		}
	};
	/** 拉起桌面 Helper：先探测本机 Electron；缺失时进程内异步下载
	*  （不 spawn 子进程，CLI node 与 DSH Desktop 均适用），下载完成后自动拉起。 */
	const startHelper = () => {
		if (helper || electronEnsure || disposed) return;
		if (!hasDesktopPet && !desktopModeEverActive) return;
		if (!hasGraphicalDisplay()) {
			if (!displayWarned) {
				displayWarned = true;
				ctx.logger?.warn?.("[dsh-pet] 未检测到图形显示环境（DISPLAY/WAYLAND_DISPLAY 均为空），已跳过桌面宠物。浏览器内宠物不受影响；如需在服务器上启用桌面模式，请配置 Xvfb 后设置 DSH_PET_DESKTOP_FORCE=1。");
			}
			return;
		}
		const found = resolveElectronPath();
		if (found) {
			launchHelper(found);
			return;
		}
		console.warn(`[dsh-pet] Electron not found, downloading to ${defaultElectronExe()} ...`);
		electronEnsure = ensureElectronDownload().then((path) => {
			if (path) launchHelper(path);
			else console.warn("[dsh-pet] Electron download failed; desktop pet unavailable. Set DSH_PET_ELECTRON_PATH and restart, or retry later.");
		}).finally(() => {
			electronEnsure = void 0;
		});
	};
	/** 停止桌面 Helper（保留配置，可再次拉起）。宿主退出/插件卸载路径：不等它退干净（见 stopAndWait）。 */
	const stopHelper = (reason = "settings-change") => {
		if (startRetryTimer) {
			clearTimeout(startRetryTimer);
			startRetryTimer = void 0;
		}
		helper?.stop(reason);
		helper = void 0;
	};
	/** 停止并**等旧 helper 真正退出**：配置变更触发的"停旧起新"专用（issue #64）。 */
	const stopHelperAndWait = async (reason) => {
		if (startRetryTimer) {
			clearTimeout(startRetryTimer);
			startRetryTimer = void 0;
		}
		const old = helper;
		helper = void 0;
		await old?.stopAndWait(reason);
	};
	/**
	* 宠物配置（display / size 等）变更后：重解析桌面宠物，**等旧 helper 退出**再拉起新的。
	*
	* 为什么要等（issue #64）：Electron 收到 SIGTERM 后关窗是异步的（几百 ms 起），"发完 kill 就 spawn
	* 新进程"会让旧窗口（旧大小）与新窗口（新大小）短暂共存——用户看到的就是"改完大小冒出来第二只宠物"。
	* 为什么要串行：连续保存会触发多次重启，两次重启交错同样会同时拉起两个 helper，所以用队列串起来。
	* 队列自身绝不留下 rejected 状态，否则后续保存再也不会重启 helper。
	*/
	let desktopSyncQueue = Promise.resolve();
	const syncDesktop = () => {
		desktopSyncQueue = desktopSyncQueue.then(async () => {
			refreshDesktop();
			await stopHelperAndWait("desktop-config-change");
			startHelper();
		}).catch((e) => {
			ctx.logger?.warn?.(`[dsh-pet] 重启桌面 Helper 失败：${e instanceof Error ? e.message : String(e)}`);
		});
		return desktopSyncQueue;
	};
	/** 扩展名 → 素材子目录名（webm → webm/，mov → mov/；其余落在动画目录平级放行） */
	const animSubdirFor = (ext) => ext === ".mov" ? "mov" : "webm";
	/** 包内动画素材根：按扩展名取子目录（webm/ 随包发布；mov/ 不存在时为 404 兜底，仅 macOS 自维护）。 */
	const assetRootFor = (ext) => join(PACKAGE_ROOT, "assets", animSubdirFor(ext));
	/** 用户动画根：按扩展名取子目录（main-animation/webm 或 main-animation/mov）。 */
	const userRootFor = (ext) => join(thumbUserRoot, animSubdirFor(ext));
	/** 单次业务路由(WebServer 注册 → HTTP 落盘 / 桌面 Helper 管道 → scheme 应答,共用同一份实现):
	*  输入只需 rawUrl(/dsh-pet-7340/... + 查询) + method + body 文本;返回 RouteResult(JSON/文本/文件),
	*  消费方各自落盘——业务逻辑只有一份,两端天然一致(硬契约:浏览器/桌面行为严格对齐)。
	*  signal（可选）：调用方断开时**中止挂起等待**（只有 /playback 的 wait 分支会用到）。
	*  管道侧不传——桌面渲染端不查 /playback；HTTP 侧由注册处按 res 的 close 触发。 */
	const handlePetRoute = async (rawUrl, method, body, signal) => {
		const url = new URL(rawUrl, "http://localhost");
		const rest = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1));
		if (rest === "config") {
			if (method === "GET") try {
				return {
					kind: "json",
					status: 200,
					obj: readAllConfig(configPaths),
					headers: { "cache-control": "no-cache, no-store" }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 500,
					obj: { error: e instanceof Error ? e.message : String(e) }
				};
			}
			if (method === "PUT") try {
				const parsed = JSON.parse(body ?? "");
				const existing = readUserConfig(configPaths);
				const clean = saveUserConfig(parsed, existing);
				if (!clean) return {
					kind: "json",
					status: 400,
					obj: { error: "invalid pet config: expected { pets:[{name?,id,size,balanceEnabled,display,position:{corner,marginX,marginY}}] }（display 为 web/desktop/both/none 之一；可选顶层 notificationsEnabled / whisperImageEnabled / chatImageEnabled 布尔；可选宠物布尔 whisperEnabled / workStatusEnabled / fixedEnabled）" }
				};
				if (url.searchParams.get("force") !== "1" && userConfigUnparsable(configPaths)) return {
					kind: "json",
					status: 409,
					obj: {
						error: "user config is unparsable",
						needConfirm: true,
						userFile: userConfigPath
					}
				};
				await mkdir(userRoot, { recursive: true });
				await writeFile(userConfigPath, JSON.stringify(clean, null, 2), "utf8");
				syncDesktop();
				return {
					kind: "json",
					status: 200,
					obj: readAllConfig(configPaths)
				};
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			if (method === "POST") {
				try {
					syncUserConfigFromDefault(configPaths);
				} catch (e) {
					return {
						kind: "json",
						status: 500,
						obj: { error: e instanceof Error ? e.message : String(e) }
					};
				}
				syncDesktop();
				return {
					kind: "json",
					status: 200,
					obj: readAllConfig(configPaths)
				};
			}
			return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
		}
		if (rest === "pet-display") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			const fail$1 = (reason, message) => ({
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason,
					message
				}
			});
			let payload;
			try {
				payload = JSON.parse(body ?? "");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const petId$1 = typeof payload.id === "string" ? payload.id.trim() : "";
			const nextDisplay = String(payload.display ?? "");
			if (!petId$1) return fail$1("pet-required", "pet 必填：要指定操作哪只桌宠");
			if (!PET_DISPLAY_SET.has(nextDisplay)) return fail$1("bad-request", `display 必须是 web / desktop / both / none：${nextDisplay}`);
			let merged;
			try {
				merged = readAllConfig(configPaths);
			} catch (e) {
				return fail$1("generate-error", e instanceof Error ? e.message : String(e));
			}
			const hit = findPetInstance(merged, petId$1);
			if (!hit) return fail$1("unknown-pet", `没有这只桌宠：${petId$1}`);
			let layerPath;
			let layerDir;
			let existing;
			if (hit.entry === "main") {
				layerPath = userConfigPath;
				layerDir = userRoot;
				existing = readUserConfig(configPaths);
			} else {
				const file$1 = readPetConfigEntry(configPaths, hit.entry);
				if (!file$1) return fail$1("generate-error", `宠物条目配置文件找不到：${hit.entry}`);
				layerPath = file$1.path;
				layerDir = petConfigDir;
				existing = file$1.raw;
			}
			const layerPets = Array.isArray(hit.conf.pets) ? hit.conf.pets : [];
			const pets = layerPets.map((p) => String(p.id) === petId$1 ? {
				...p,
				display: nextDisplay
			} : p);
			const clean = saveUserConfig({ pets }, existing);
			if (!clean) return fail$1("bad-request", "宠物配置非法");
			try {
				await mkdir(layerDir, { recursive: true });
				await writeFile(layerPath, JSON.stringify(clean, null, 2), "utf8");
			} catch (e) {
				return fail$1("generate-error", e instanceof Error ? e.message : String(e));
			}
			state.writeSection("config", {});
			if (nextDisplay === "none") lock.release({
				petId: petId$1,
				force: true
			});
			syncDesktop();
			return {
				kind: "json",
				status: 200,
				obj: readAllConfig(configPaths)
			};
		}
		if (rest === "reload") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			syncDesktop();
			return {
				kind: "json",
				status: 200,
				obj: { reloading: true }
			};
		}
		if (rest === "config/meta") return {
			kind: "json",
			status: 200,
			obj: {
				user: userConfigPath,
				default: join(PACKAGE_ROOT, "assets", "config.jsonc"),
				animations: thumbUserRoot,
				memes: memesUserRoot,
				storage: storageEntries({
					userDataRoot: userRoot,
					electronDir: electronLandingDir(),
					home: homedir(),
					packageRoot: PACKAGE_ROOT
				}),
				profile: profileNameFrom(PACKAGE_ROOT) ?? ""
			}
		};
		if (rest === "menu/item") {
			if (method === "DELETE") {
				const result$1 = menuRegistry.clear(url.searchParams.get("owner") ?? "");
				if (!result$1.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: result$1.reason,
						message: result$1.message
					}
				};
				state.writeSection("menu", { items: menuRegistry.snapshot() });
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						removed: result$1.removed
					}
				};
			}
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const result = menuRegistry.register(parsed);
			if (!result.ok) return {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason: result.reason,
					message: result.message
				}
			};
			state.writeSection("menu", { items: menuRegistry.snapshot() });
			return {
				kind: "json",
				status: 200,
				obj: { ok: true }
			};
		}
		if (rest === "menu/events") {
			if (method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			const owner = url.searchParams.get("owner") ?? "";
			const rawWait = Number(url.searchParams.get("wait") ?? "0");
			const waitMs = Number.isFinite(rawWait) && rawWait > 0 ? Math.min(rawWait, MENU_WAIT_MAX_MS) : 0;
			const events = await menuRegistry.poll(owner, waitMs);
			if (events === null) return {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason: "unknown-owner",
					message: "这个 owner 没有注册，重新注册即可"
				}
			};
			return {
				kind: "json",
				status: 200,
				obj: {
					ok: true,
					events
				}
			};
		}
		if (rest === "menu/click") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			return {
				kind: "json",
				status: 200,
				obj: menuRegistry.click(parsed)
			};
		}
		if (rest === "models") {
			if (method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			try {
				const llm = ctx.llm;
				const named = (id, name) => {
					const pid = String(id ?? "");
					return {
						id: pid,
						name: String(name ?? "") || pid
					};
				};
				let providers = (typeof llm?.listProviders === "function" ? llm.listProviders() : []).map((p) => named(p?.id, p?.name));
				if (providers.length === 0 && typeof llm?.listConfigurableProviders === "function") providers = llm.listConfigurableProviders().map((p) => named(p?.provider, p?.displayName));
				providers = providers.filter((p) => p.id);
				const catalog = await Promise.all(providers.map(async (p) => {
					let models = [];
					try {
						const list = await llm?.listModels?.(p.id);
						models = (Array.isArray(list) ? list : []).map((m) => named(m?.id, m?.name)).filter((m) => m.id);
					} catch {}
					return {
						...p,
						models
					};
				}));
				return {
					kind: "json",
					status: 200,
					obj: { providers: catalog }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 500,
					obj: { error: e instanceof Error ? e.message : String(e) }
				};
			}
		}
		if (rest === "state") {
			if (method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			const headers = { "cache-control": "no-cache, no-store" };
			const parsed = parseStateWaitQuery(url.searchParams.get("since"), url.searchParams.get("timeout"));
			if (parsed.kind === "error") return {
				kind: "json",
				status: 400,
				obj: { error: parsed.error }
			};
			const current = state.read();
			if (parsed.kind === "none" || current.counter !== parsed.since) return {
				kind: "json",
				status: 200,
				obj: current,
				headers
			};
			const since = parsed.since;
			return await new Promise((resolveWait) => {
				let settled = false;
				/** 收尾：只认第一次（唤醒 / 超时 / 取消 / 调用方断开 都可能先后到达） */
				const settle = (result) => {
					if (settled) return;
					settled = true;
					resolveWait(result);
				};
				const cancel = state.wait({
					since,
					timeoutMs: parsed.timeoutMs,
					onWake: () => settle({
						kind: "json",
						status: 200,
						obj: state.read(),
						headers
					})
				});
				const onAbort = () => {
					cancel();
					settle({ kind: "none" });
				};
				if (signal?.aborted) {
					onAbort();
					return;
				}
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
		if (rest === "work-status") {
			if (method === "DELETE") {
				if (workStatus.clear(EXTERNAL_WORK_SESSION)) publishWorkStatus();
				return {
					kind: "text",
					status: 204,
					body: ""
				};
			}
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			if (Buffer.byteLength(body ?? "", "utf8") > 8 * 1024) return {
				kind: "json",
				status: 413,
				obj: { error: "body too large" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {
				kind: "json",
				status: 400,
				obj: { error: "invalid JSON body" }
			};
			const payload = parsed;
			const state$1 = payload.state;
			if (typeof state$1 !== "string" || !HOST_WORK_STATUS_STATES.includes(state$1)) return {
				kind: "json",
				status: 400,
				obj: { error: "invalid state" }
			};
			let task;
			if (Object.prototype.hasOwnProperty.call(payload, "task")) if (payload.task === null) task = null;
			else if (typeof payload.task === "string") {
				const trimmed = payload.task.trim();
				if (trimmed === "") task = null;
				else if (Array.from(trimmed).length > TASK_TEXT_MAX) return {
					kind: "json",
					status: 400,
					obj: { error: `task too long (max ${TASK_TEXT_MAX} code points)` }
				};
				else task = trimmed;
			} else return {
				kind: "json",
				status: 400,
				obj: { error: "invalid task" }
			};
			externalWorkSeq += 1;
			workStatus.setState(EXTERNAL_WORK_SESSION, state$1, externalWorkSeq);
			if (task !== void 0) workStatus.setTask(EXTERNAL_WORK_SESSION, task);
			publishWorkStatus();
			return {
				kind: "json",
				status: 200,
				obj: {
					state: workStatus.stateOf(EXTERNAL_WORK_SESSION) ?? state$1,
					task: workStatus.taskOf(EXTERNAL_WORK_SESSION)
				}
			};
		}
		if (rest === "balance") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			await refreshBalance(true);
			return {
				kind: "json",
				status: 200,
				obj: { ok: true }
			};
		}
		if (rest === "lock" || rest === "lock/release") {
			const isRelease = rest === "lock/release";
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "null");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const o = parsed && typeof parsed === "object" ? parsed : {};
			try {
				const who = requirePet(url.searchParams, () => readAllConfig(configPaths), { surface: !isRelease });
				if (!who.ok) return who.res;
				const petId$1 = who.petId;
				if (isRelease) {
					const d$1 = lock.release({
						petId: petId$1,
						lockId: o.lockId,
						force: o.force
					});
					if (!d$1.ok) {
						const obj$1 = {
							ok: false,
							reason: d$1.reason,
							message: d$1.message
						};
						if (d$1.reason === "lock-lost") obj$1.cause = d$1.cause;
						return {
							kind: "json",
							status: 200,
							obj: obj$1
						};
					}
					return {
						kind: "json",
						status: 200,
						obj: { ok: true }
					};
				}
				const d = lock.acquire({
					petId: petId$1,
					lockId: o.lockId,
					ttl: o.ttl
				});
				if (!d.ok) {
					const obj$1 = {
						ok: false,
						reason: d.reason,
						message: d.message
					};
					if (d.reason === "locked") obj$1.expiresAt = d.expiresAt;
					if (d.reason === "lock-lost") obj$1.cause = d.cause;
					return {
						kind: "json",
						status: 200,
						obj: obj$1
					};
				}
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						lockId: d.lockId,
						petId: d.petId,
						expiresAt: d.expiresAt
					}
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "interactive/tick") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			const who = requirePet(url.searchParams, () => readAllConfig(configPaths), { surface: true });
			if (!who.ok) return who.res;
			const petId$1 = who.petId;
			if (interactiveInflight.has(petId$1)) return {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason: "busy",
					message: "上一次识屏还没结束"
				}
			};
			interactiveInflight.add(petId$1);
			try {
				const parsed = JSON.parse(body ?? "null") ?? {};
				const settings = await resolveVisionSettings(who.conf);
				if (!settings.apiKey) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "vision-missing",
						message: "未配置视觉模型 API Key（ZHIPU_API_KEY / interactiveVisionEnvFile）"
					}
				};
				let dataUrl = "";
				if (typeof parsed.imagePath === "string" && parsed.imagePath) {
					if (!isTempScreenshotPath(parsed.imagePath)) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							reason: "bad-request",
							message: "截图路径非法"
						}
					};
					try {
						dataUrl = await fileToDataUrl(parsed.imagePath);
					} finally {
						await rm(parsed.imagePath, { force: true }).catch(() => {});
					}
				} else if (typeof parsed.image === "string" && parsed.image.startsWith("data:image/")) {
					if (parsed.image.length > 8e6) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							reason: "bad-request",
							message: "截图过大"
						}
					};
					dataUrl = parsed.image;
				} else return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "bad-request",
						message: "缺少截图"
					}
				};
				const log = await readInteractiveLog(interactiveLogPath);
				const recent = (Array.isArray(log[petId$1]?.messages) ? log[petId$1].messages : []).slice(-3).map((m) => m.text);
				const result = await generateScreenComment({
					system: petSystemPrompt(who),
					imageDataUrl: dataUrl,
					settings,
					recent
				});
				if (!result.ok) return {
					kind: "json",
					status: 200,
					obj: result
				};
				const ts = Date.now();
				state.writePet(petId$1, "say", { text: result.text });
				await appendInteractiveMessage(interactiveLogPath, petId$1, result.text, ts).catch(() => {});
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						text: result.text,
						ts
					}
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			} finally {
				interactiveInflight.delete(petId$1);
			}
		}
		if (rest === "whisper") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			try {
				const who = requirePet(url.searchParams, () => readAllConfig(configPaths), { surface: true });
				if (!who.ok) return who.res;
				const r = await publishWhisper(who.petId);
				if (r.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						text: r.text,
						...r.image ? { image: r.image } : {}
					}
				};
				const obj$1 = {
					ok: false,
					reason: r.reason
				};
				if (r.message) obj$1.message = r.message;
				return {
					kind: "json",
					status: 200,
					obj: obj$1
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "broadcast") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "null");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const o = parsed && typeof parsed === "object" ? parsed : {};
			if (!normalizeBroadcastText(o.text)) return {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason: "bad-request",
					message: "text 为空"
				}
			};
			const duration = normalizeBroadcastDuration(o.duration);
			if (duration === null) return {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason: "bad-request",
					message: "duration 必须是 ≥0 的有限数字（毫秒）"
				}
			};
			const anim = normalizeBroadcastAnim(o.anim);
			try {
				const cfg = readAllConfig(configPaths);
				const d = decideBroadcast({
					cfg,
					requested: String(url.searchParams.get("pet") ?? ""),
					text: o.text,
					image: o.image,
					url: o.url,
					duration,
					anim,
					memeDirs: memeDirsFor
				});
				if (!d.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: d.reason,
						message: d.message
					}
				};
				const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
				if (noSurface) return noSurface;
				const blocked = lockBlocked(d.petId, url.searchParams);
				if (blocked) return blocked;
				const pic = d.url !== void 0 ? { url: d.url } : d.image !== void 0 ? { image: d.image } : {};
				state.writePet(d.petId, "say", {
					text: d.text,
					...pic,
					duration: d.duration,
					anim: d.anim
				});
				return {
					kind: "json",
					status: 200,
					obj: { ok: true }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "bubble/clear") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			try {
				const cfg = readAllConfig(configPaths);
				const d = decideBubbleClear({
					cfg,
					requested: String(url.searchParams.get("pet") ?? "")
				});
				if (!d.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: d.reason,
						message: d.message
					}
				};
				const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
				if (noSurface) return noSurface;
				const blocked = lockBlocked(d.petId, url.searchParams);
				if (blocked) return blocked;
				state.writePet(d.petId, "say", { clear: true });
				return {
					kind: "json",
					status: 200,
					obj: { ok: true }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "anim") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "null");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const o = parsed && typeof parsed === "object" ? parsed : {};
			try {
				const cfg = readAllConfig(configPaths);
				const d = decideAnim({
					cfg,
					requested: String(url.searchParams.get("pet") ?? ""),
					name: o.name,
					url: o.url,
					facing: o.facing
				});
				if (!d.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: d.reason,
						message: d.message
					}
				};
				const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
				if (noSurface) return noSurface;
				const blocked = lockBlocked(d.petId, url.searchParams);
				if (blocked) return blocked;
				const record = playback.create(d.petId, d.url ?? d.name ?? "");
				state.writePet(d.petId, "anim", {
					...d.url !== void 0 ? { url: d.url } : { name: d.name },
					playbackId: record.playbackId,
					...d.facing === void 0 ? {} : { facing: d.facing }
				});
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						playbackId: record.playbackId
					}
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "position" || rest === "throw") {
			const isPosition = rest === "position";
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "null");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const o = parsed && typeof parsed === "object" ? parsed : {};
			try {
				const cfg = readAllConfig(configPaths);
				const requested = String(url.searchParams.get("pet") ?? "");
				if (isPosition) {
					const d$1 = decidePosition({
						cfg,
						requested,
						x: o.x,
						y: o.y,
						mode: o.mode,
						duration: o.duration
					});
					if (!d$1.ok) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							reason: d$1.reason,
							message: d$1.message
						}
					};
					const noSurface$1 = surfaceBlocked(cfg, d$1.petId, url.searchParams);
					if (noSurface$1) return noSurface$1;
					const blocked$1 = lockBlocked(d$1.petId, url.searchParams);
					if (blocked$1) return blocked$1;
					state.writePet(d$1.petId, "position", positionLeafData(d$1));
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							x: d$1.x,
							y: d$1.y
						}
					};
				}
				const d = decideThrow({
					cfg,
					requested,
					angle: o.angle,
					power: o.power
				});
				if (!d.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: d.reason,
						message: d.message
					}
				};
				const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
				if (noSurface) return noSurface;
				const blocked = lockBlocked(d.petId, url.searchParams);
				if (blocked) return blocked;
				state.writePet(d.petId, "throw", {
					angle: d.angle,
					power: d.power
				});
				return {
					kind: "json",
					status: 200,
					obj: { ok: true }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "pose" || rest === "pose/report") {
			const isReport = rest === "pose/report";
			if (isReport && method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			if (!isReport && method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsedPose;
			if (isReport) try {
				parsedPose = JSON.parse(body ?? "null");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			try {
				const who = requirePet(url.searchParams, () => readAllConfig(configPaths));
				if (!who.ok) return who.res;
				if (isReport) {
					const p = normalizePoseInput(parsedPose);
					if (!p.ok) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							reason: p.reason,
							message: p.message
						}
					};
					pose.set(who.petId, p.pose);
					return {
						kind: "json",
						status: 200,
						obj: { ok: true }
					};
				}
				const display = String(who.pet.display ?? "");
				if (!displayCovers("desktop", display)) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "pet-not-displayed",
						message: who.petId + " 的显示模式是 " + display + "；桌面端实况只对 display 含 desktop 的宠物有",
						display
					}
				};
				const snap = pose.get(who.petId);
				if (snap === void 0) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "pose-unavailable",
						message: "还没收到过这只宠物的桌面端实况（桌面端没起来，或刚重启还没来得及上报）"
					}
				};
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						petId: who.petId,
						...snap
					}
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		const playbackPath = rest === "playback" || rest.startsWith("playback/") ? parsePlaybackPath(rest) : void 0;
		if (playbackPath) {
			const playbackId = playbackPath.playbackId;
			if (playbackPath.isReport) {
				if (method !== "POST") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				let reported;
				try {
					reported = JSON.parse(body ?? "null");
				} catch {
					return {
						kind: "json",
						status: 400,
						obj: { error: "invalid JSON body" }
					};
				}
				const o = reported && typeof reported === "object" ? reported : {};
				const outcome = playback.report(playbackId, o.status, o.reason);
				if (outcome === "unknown") return {
					kind: "json",
					status: 404,
					obj: { error: "unknown playback" }
				};
				if (outcome === "invalid") return {
					kind: "json",
					status: 400,
					obj: { error: "invalid status" }
				};
				return {
					kind: "json",
					status: 200,
					obj: { ok: true }
				};
			}
			if (method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			const record = playback.get(playbackId);
			if (!record) return {
				kind: "json",
				status: 404,
				obj: { error: "unknown playback" }
			};
			const parsed = parseWaitQuery(url.searchParams.get("wait"), url.searchParams.get("timeout"));
			if (parsed.kind === "error") return {
				kind: "json",
				status: 400,
				obj: { error: parsed.error }
			};
			if (parsed.kind === "none") return {
				kind: "json",
				status: 200,
				obj: {
					...record,
					matched: false
				}
			};
			const { wait: waitList, timeoutMs } = parsed;
			if (waitList.includes(record.status)) return {
				kind: "json",
				status: 200,
				obj: {
					...record,
					matched: true
				}
			};
			return await new Promise((resolveWait) => {
				let settled = false;
				/** 收尾：只认第一次（唤醒 / 超时 / 取消 / 调用方断开 都可能先后到达） */
				const settle = (result) => {
					if (settled) return;
					settled = true;
					resolveWait(result);
				};
				const cancel = playback.wait({
					playbackId,
					wait: waitList,
					timeoutMs,
					onWake: (r, matched) => settle({
						kind: "json",
						status: 200,
						obj: {
							...r,
							matched
						}
					})
				});
				if (cancel === void 0) {
					settle({
						kind: "json",
						status: 404,
						obj: { error: "unknown playback" }
					});
					return;
				}
				const onAbort = () => {
					cancel();
					settle({ kind: "none" });
				};
				if (signal?.aborted) {
					onAbort();
					return;
				}
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
		if (rest === "chat") {
			if (method !== "GET" && method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			try {
				const roundsRaw = method === "GET" ? url.searchParams.get("rounds") : null;
				let roundsOverride = null;
				if (roundsRaw !== null && roundsRaw.trim() !== "") {
					const n = Number(roundsRaw);
					if (!Number.isInteger(n) || n < 0 || n > 200) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							reason: "bad-request",
							message: "rounds 必须是 0–200 的整数（不传则用配置）"
						}
					};
					roundsOverride = n;
				}
				let cfgCache;
				const cfg = () => cfgCache ??= readAllConfig(configPaths);
				const who = requirePet(url.searchParams, cfg, { surface: method === "POST" });
				if (!who.ok) return who.res;
				const petId$1 = who.petId;
				if (method === "GET") {
					const mem = await readMemory();
					const bucket = mem[who.entry] ?? {};
					const list = (bucket[petId$1]?.messages ?? []).slice();
					const rounds = roundsOverride ?? memoryRounds(who.conf);
					const messages = sliceMemoryRounds(list, rounds);
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							messages,
							rounds
						}
					};
				}
				if (method === "POST") {
					const parsed = JSON.parse(body ?? "null") ?? {};
					const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
					if (!text) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							reason: "bad-request",
							message: "消息为空"
						}
					};
					if (text.length > 2e3) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							reason: "bad-request",
							message: "消息过长（限 2000 字）"
						}
					};
					const result = await chatWithPet(petId$1, text);
					return {
						kind: "json",
						status: 200,
						obj: result
					};
				}
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		const [scope, ...restParts] = rest.split("/");
		if (scope === "font") {
			const fontRoot = join(PACKAGE_ROOT, "assets", "fonts");
			const fontFile = resolveExisting(fontRoot, restParts.join("/"));
			if (fontFile === void 0) return {
				kind: "text",
				status: 404,
				body: "dsh-pet: font not found"
			};
			const ext$1 = fontFile.slice(fontFile.lastIndexOf(".")).toLowerCase();
			return {
				kind: "file",
				file: fontFile,
				contentType: MIME[ext$1] ?? "application/octet-stream"
			};
		}
		if (scope === "pic") {
			if (restParts[0] === "memes") {
				const segs = restParts.slice(1);
				const scoped = segs.length >= 2;
				const assetRoot = scoped ? segs[0] : "main";
				if (scoped && (assetRoot.length > 64 || ID_FORBIDDEN.test(assetRoot))) return {
					kind: "text",
					status: 400,
					body: "dsh-pet: invalid asset root"
				};
				const rel = (scoped ? segs.slice(1) : segs).join("/");
				let picFile$1;
				for (const dir of memeDirsFor(assetRoot)) {
					picFile$1 = resolveExisting(dir, rel);
					if (picFile$1 !== void 0) break;
				}
				if (picFile$1 === void 0) return {
					kind: "text",
					status: 404,
					body: "dsh-pet: pic not found"
				};
				const ext$2 = picFile$1.slice(picFile$1.lastIndexOf(".")).toLowerCase();
				return {
					kind: "file",
					file: picFile$1,
					contentType: MIME[ext$2] ?? "application/octet-stream"
				};
			}
			const picRoot = join(PACKAGE_ROOT, "assets", "pic");
			const picFile = resolveExisting(picRoot, restParts.join("/"));
			if (picFile === void 0) return {
				kind: "text",
				status: 404,
				body: "dsh-pet: pic not found"
			};
			const ext$1 = picFile.slice(picFile.lastIndexOf(".")).toLowerCase();
			return {
				kind: "file",
				file: picFile,
				contentType: MIME[ext$1] ?? "application/octet-stream"
			};
		}
		if (scope !== "thumb") return {
			kind: "text",
			status: 400,
			body: "dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>"
		};
		const [petId, ...nameParts] = restParts;
		if (!petId || nameParts.length === 0) return {
			kind: "text",
			status: 400,
			body: "dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>"
		};
		if (ID_FORBIDDEN.test(petId)) return {
			kind: "text",
			status: 400,
			body: "dsh-pet: invalid pet id"
		};
		const fileName = nameParts.join("/");
		const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
		if (ext !== ".webm" && ext !== ".mov") return {
			kind: "text",
			status: 400,
			body: "dsh-pet: unsupported animation format (expected .webm or .mov)"
		};
		const extraAnimDir = resolveAsset(petConfigDir, petId + "-animation");
		/** 按扩展名查同名素材（专属目录优先；否则用户根 → 包内根） */
		const findAnim = (e) => {
			const name = fileName.replace(/\.(webm|mov)$/i, "") + e;
			return extraAnimDir !== void 0 && existsSync(extraAnimDir) ? resolveExisting(extraAnimDir, name) : resolveExisting(userRootFor(e), name) ?? resolveExisting(assetRootFor(e), name);
		};
		let file = findAnim(ext);
		let servedExt = ext;
		if (file === void 0 && ext === ".mov") {
			const fb = findAnim(".webm");
			if (fb !== void 0) {
				file = fb;
				servedExt = ".webm";
			}
		}
		if (file === void 0) return {
			kind: "text",
			status: 404,
			body: "dsh-pet: asset not found"
		};
		return {
			kind: "file",
			file,
			contentType: MIME[servedExt] ?? "application/octet-stream"
		};
	};
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			const abort = new AbortController();
			const onClose = () => abort.abort();
			res.on("close", onClose);
			try {
				const body = req.method === "PUT" || req.method === "POST" ? await readBody(req) : void 0;
				const result = await handlePetRoute(req.url ?? "/", req.method ?? "GET", body, abort.signal);
				res.off("close", onClose);
				if (result.kind === "json") sendJson$1(res, result.status, result.obj, result.headers);
				else if (result.kind === "text") sendText(res, result.status, result.body);
				else if (result.kind === "none") {} else sendFile(res, result.file, result.contentType);
			} catch (e) {
				res.off("close", onClose);
				if (!res.destroyed && !res.writableEnded) sendJson$1(res, 500, { error: e instanceof Error ? e.message : String(e) });
			}
		}
	}), "dsh-pet: /dsh-pet-7340 asset route");
	ctx.effect(() => {
		const dispose = ctx.on("session/event", (session, event) => {
			const type = event?.type;
			if (!type) return;
			const sessionId = String(session?.header?.id ?? session?.id ?? "unknown");
			if (type === "todo/write") {
				if (workStatus.has(sessionId)) {
					workStatus.setTask(sessionId, currentTaskFromTodo(event));
					publishWorkStatus();
				}
				return;
			}
			if (type === "user/message") {
				const source = event?.data?.source;
				if (source?.kind === "goal") {
					const flags = turnFlags.get(sessionId) ?? {
						goalRound: false,
						closing: null
					};
					flags.goalRound = true;
					turnFlags.set(sessionId, flags);
				}
				return;
			}
			if (type === "turn/start") {
				turnFlags.set(sessionId, {
					goalRound: false,
					closing: null
				});
				workStatus.setTask(sessionId, null);
				publishWorkStatus();
			}
			if (type === "tool/call" && String(event?.data?.name ?? "") === GOAL_UPDATE_TOOL) {
				const action = goalUpdateAction(String(event?.data?.arguments ?? ""));
				if (action) {
					const flags = turnFlags.get(sessionId) ?? {
						goalRound: false,
						closing: null
					};
					flags.closing = action;
					turnFlags.set(sessionId, flags);
				}
			}
			const next = reduceWorkStatus(event, turnFlags.get(sessionId));
			if (!next) {
				if (type === "turn/end") {
					turnFlags.delete(sessionId);
					cancelTerminalCleanup(sessionId);
					workStatus.clear(sessionId);
					publishWorkStatus();
				}
				return;
			}
			const seq = Number(event.seq ?? 0);
			if (!workStatus.setState(sessionId, next, seq)) return;
			publishWorkStatus();
			if (next === "success" || next === "error") scheduleTerminalCleanup(sessionId);
			else cancelTerminalCleanup(sessionId);
		});
		return () => {
			dispose();
			for (const t of terminalTimers.values()) clearTimeout(t);
			terminalTimers.clear();
		};
	}, "dsh-pet: work-status session events");
	ctx.effect(() => {
		const sessionDispose = ctx.on(
			"session/event",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(session, event) => {
				if (!shouldNotifySession(session)) return;
				if (isCompletionTurnEnd(event)) {
					scheduleCompletionNotify(sessionIdOf(session), event);
					return;
				}
				const frame = reduceNotifyFrame(event);
				if (frame) pushNotifyFrame(withSessionId(frame, sessionIdOf(session)));
			}
);
		const errorDispose = ctx.on(
			"agent/error",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(payload) => {
				pushNotifyFrame(agentErrorFrame(payload?.error));
			}
);
		return () => {
			for (const t of notifyActivityTimers.values()) clearTimeout(t);
			notifyActivityTimers.clear();
			sessionDispose();
			errorDispose();
		};
	}, "dsh-pet: notify frames");
	ctx.effect(() => ctx.commands.register({
		name: "balance",
		description: "手动触发桌宠余额显示（立即弹出余额气泡）",
		handler: () => {
			refreshBalance(true);
			return {
				kind: "success",
				text: "已触发桌宠余额显示"
			};
		}
	}), "dsh-pet: /balance command");
	ctx.effect(() => {
		let disposed$1 = false;
		let timer = null;
		function arm(sec) {
			if (disposed$1) return;
			timer = setTimeout(() => void tick(), Math.max(1e3, sec * 1e3));
		}
		async function tick() {
			let sec;
			try {
				const cfg = readAllConfig(configPaths);
				sec = balancePeriodSec(cfg);
				if (flattenPetList(cfg).some((p) => p.balanceEnabled === true)) await refreshBalance();
			} catch {
				return;
			}
			arm(sec);
		}
		tick();
		return () => {
			disposed$1 = true;
			if (timer !== null) clearTimeout(timer);
		};
	}, "dsh-pet: balance poll");
	ctx.effect(() => {
		let disposed$1 = false;
		let timer = null;
		function arm(sec) {
			if (disposed$1) return;
			timer = setTimeout(() => void tick(), Math.max(1e3, sec * 1e3));
		}
		function tick() {
			let next = 300;
			try {
				const cfg = readAllConfig(configPaths);
				const now = Date.now();
				let min = Infinity;
				for (const pet of flattenPetList(cfg)) {
					const petId = String(pet.id ?? "");
					if (!petId) continue;
					const found = findPetInstance(cfg, petId);
					if (!found) continue;
					const schedule = automaticWhisperSchedule(ctx.standaloneAi, pet.whisperEnabled === true, whisperPeriodSec(found.conf));
					if (!schedule.enabled) continue;
					const sec = schedule.periodSec;
					min = Math.min(min, sec);
					if (now - (lastWhisperAt.get(petId) ?? 0) < sec * 1e3) continue;
					if (lock.locked(petId)) continue;
					lastWhisperAt.set(petId, now);
					publishWhisper(petId).catch(() => {});
				}
				if (Number.isFinite(min)) next = min;
			} catch {
				return;
			}
			arm(next);
		}
		tick();
		return () => {
			disposed$1 = true;
			if (timer !== null) clearTimeout(timer);
		};
	}, "dsh-pet: whisper poll");
	ctx.effect(() => ctx.commands.register({
		name: "pet",
		description: "选择桌宠（/chat 对话的目标；支持选择框或手输 id/名字）",
		input: { hint: "[宠物 id 或名字]（留空查看当前）" },
		handler: ({ rawInput }) => {
			const arg = rawInput.trim();
			let eff;
			try {
				eff = effectivePetList();
			} catch {
				eff = [];
			}
			if (!arg) {
				const cur = resolveActivePetId();
				const found = eff.find((p) => String(p.id) === cur);
				return {
					kind: "success",
					text: "当前桌宠：" + (found ? petDisplayName(found) : cur || "（无可交互桌宠）")
				};
			}
			const byId = eff.find((p) => String(p.id) === arg);
			if (byId) {
				activePetId = String(byId.id);
				return {
					kind: "success",
					text: "已选择桌宠：" + petDisplayName(byId)
				};
			}
			const byName = eff.filter((p) => petDisplayName(p) === arg);
			if (byName.length === 1) {
				activePetId = String(byName[0].id);
				return {
					kind: "success",
					text: "已选择桌宠：" + petDisplayName(byName[0])
				};
			}
			if (byName.length > 1) return {
				kind: "error",
				text: "「" + arg + "」有 " + byName.length + " 只桌宠（id：" + byName.map((p) => String(p.id)).join("、") + "），请用 id 指定"
			};
			return {
				kind: "error",
				text: "找不到桌宠「" + arg + "」（id 或名字都行；/pet 回车可打开选择框）"
			};
		}
	}), "dsh-pet: /pet command");
	ctx.effect(() => ctx.commands.register({
		name: "chat",
		description: "与桌宠对话：留空 = 碎碎念一句；输入消息 = 正常对话",
		input: { hint: "[消息]（留空 = 碎碎念）" },
		handler: ({ rawInput }) => {
			const petId = resolveActivePetId();
			if (!petId) return {
				kind: "error",
				text: "没有可交互的桌宠"
			};
			const text = rawInput.trim();
			if (!text) {
				publishWhisper(petId).catch((e) => console.warn("[dsh-pet] 碎碎念异常：" + (e instanceof Error ? e.message : String(e))));
				return {
					kind: "success",
					text: "已让桌宠碎碎念一句"
				};
			}
			if (text.length > 2e3) return {
				kind: "error",
				text: "消息过长（限 2000 字）"
			};
			chatWithPet(petId, text).then((r) => {
				if (!r.ok) console.warn("[dsh-pet] 对话失败 reason=" + r.reason + (r.message ? " " + r.message : ""));
			});
			return {
				kind: "success",
				text: "已发送，桌宠马上回应"
			};
		}
	}), "dsh-pet: /chat command");
	ctx.effect(() => () => {
		disposed = true;
		if (workFlushTimer !== null) {
			clearTimeout(workFlushTimer);
			workFlushTimer = null;
		}
		lock.releaseAll();
		playback.cancelAll();
		state.cancelAll();
		stopHelper("dsh-host-stop");
	});
	startHelper();
}

//#endregion
//#region src/standalone/request-security.ts
function rejectRequest(res, status, error) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify({ error }));
	return false;
}
function publicRead(req) {
	if (req.method !== "GET" && req.method !== "HEAD") return false;
	let path;
	try {
		path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
	} catch {
		return false;
	}
	if (["/standalone-ai/settings", "/shutdown"].includes(path)) return false;
	if (/^\/dsh-pet-\d+\/(?:whisper|chat)(?:\/|$)/.test(path)) return false;
	return [
		"/",
		"/health",
		"/standalone-ai/",
		"/standalone-ai/settings.js",
		"/standalone-ai/settings.css"
	].includes(path) || /^\/dsh-pet-\d+\//.test(path);
}
function createRequestSecurity() {
	const token = randomBytes(32).toString("base64url");
	return {
		token,
		authenticatedUrl(baseUrl) {
			const base = new URL(baseUrl);
			if (base.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(base.hostname) || base.username || base.password) throw new Error("设置地址必须是本机 HTTP 地址");
			return `${base.origin}/standalone-ai/#token=${token}`;
		},
		authorize(req, res) {
			const host = req.headers.host;
			const port = req.socket.localPort;
			if (!port || host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return rejectRequest(res, 403, "仅允许当前本机地址");
			if (req.headers.origin !== void 0 && req.headers.origin !== `http://${host}` || req.headers["sec-fetch-site"] === "cross-site") return rejectRequest(res, 403, "不允许跨站请求");
			try {
				if (publicRead(req)) return true;
			} catch {
				return rejectRequest(res, 400, "请求地址无效");
			}
			const supplied = req.headers["x-dsh-pet-token"];
			if (typeof supplied !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return rejectRequest(res, 403, "请从桌宠菜单重新打开设置");
			return true;
		}
	};
}
function secureResponse(res, pathname) {
	const writeHead = res.writeHead.bind(res);
	const isPublicOp = pathname === "/" || pathname === "/health";
	res.writeHead = (status, ...args) => {
		const filtered = isPublicOp ? args : args.map((value) => {
			if (Array.isArray(value)) return value.reduce((result, item, index) => {
				if (index % 2 === 0 && !String(item).toLowerCase().startsWith("access-control-")) return [
					...result,
					String(item),
					String(value[index + 1])
				];
				return result;
			}, []);
			if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([name]) => !name.toLowerCase().startsWith("access-control-")));
			return value;
		});
		if (!isPublicOp) {
			for (const name of res.getHeaderNames()) if (name.toLowerCase().startsWith("access-control-")) res.removeHeader(name);
		}
		res.setHeader("x-content-type-options", "nosniff");
		res.setHeader("referrer-policy", "no-referrer");
		res.setHeader("cache-control", "no-store");
		return Reflect.apply(writeHead, res, [status, ...filtered]);
	};
}

//#endregion
//#region src/standalone/request-body.ts
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_SETTINGS_BYTES = 16 * 1024;
const BODY_TIMEOUT_MS = 5e3;
async function boundedRequest(req, res, limit, timeoutMs = BODY_TIMEOUT_MS) {
	const length = req.headers["content-length"];
	if (length !== void 0 && (!/^\d+$/.test(length) || Number(length) > limit)) {
		rejectRequest(res, 413, "请求正文过大");
		return void 0;
	}
	const chunks = [];
	const body = await new Promise((resolve$1) => {
		let size = 0;
		const finish = (status) => {
			clearTimeout(timer);
			req.off("data", onData);
			req.off("end", onEnd);
			req.off("error", onError);
			req.off("aborted", onError);
			if (status !== void 0) {
				req.pause();
				if (!res.writableEnded && !res.destroyed) rejectRequest(res, status, status === 408 ? "读取请求超时" : "请求正文无效或过大");
				resolve$1(void 0);
			} else resolve$1(Buffer.concat(chunks));
		};
		const onData = (chunk) => {
			size += chunk.length;
			if (size > limit) finish(413);
			else chunks.push(Buffer.from(chunk));
		};
		const onEnd = () => finish();
		const onError = () => finish(400);
		const timer = setTimeout(() => finish(408), timeoutMs);
		timer.unref();
		req.on("data", onData);
		req.once("end", onEnd);
		req.once("error", onError);
		req.once("aborted", onError);
	});
	if (body === void 0) return void 0;
	return Object.assign(Readable.from([body]), {
		method: req.method,
		url: req.url,
		headers: req.headers,
		rawHeaders: req.rawHeaders,
		socket: req.socket,
		httpVersion: req.httpVersion
	});
}

//#endregion
//#region src/standalone/settings.ts
const endpoint = z.string().max(2048).refine((value) => {
	if (value === "") return true;
	try {
		const url = new URL(value);
		return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
	} catch {
		return false;
	}
}, "接口地址必须是 HTTP(S) 地址，且不能含账号、查询参数或片段");
const settingsSchema = z.object({
	protocol: z.enum(["openai-compatible", "anthropic"]).optional(),
	baseUrl: endpoint.optional(),
	model: z.string().max(200).optional(),
	apiKey: z.string().max(8192).optional(),
	clearApiKey: z.boolean().optional(),
	enabled: z.boolean().optional(),
	automaticWhispers: z.boolean().optional(),
	whisperIntervalSec: z.number().int().min(60).max(86400).optional(),
	maxTokens: z.number().int().min(128).max(4096).optional(),
	timeoutMs: z.number().int().min(1e3).max(6e4).optional()
}).strict();
function validateSettings$1(input) {
	const result = settingsSchema.safeParse(input);
	if (!result.success) throw new Error("设置无效：请检查协议、接口地址、间隔（至少 60 秒）和输出上限（128–4096）");
	return result.data;
}
const publicNames = [
	"protocol",
	"baseUrl",
	"model",
	"enabled",
	"automaticWhispers",
	"whisperIntervalSec",
	"maxTokens",
	"timeoutMs",
	"hasKey"
];
function publicSettings(input) {
	if (input === null || typeof input !== "object") return {};
	const record = input;
	return Object.fromEntries(publicNames.filter((name) => Object.prototype.hasOwnProperty.call(record, name)).map((name) => [name, record[name]]));
}

//#endregion
//#region src/standalone/settings-page.ts
const settingsPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>桌宠 AI 设置</title><link rel="stylesheet" href="/standalone-ai/settings.css">
<script src="/standalone-ai/settings.js" defer></script></head><body>
<main><header><span class="fish" aria-hidden="true">🐾</span><p class="local">独立桌宠 / 本机设置</p>
<h1>桌宠 AI 设置</h1><p class="intro">配置你的大模型 API 接口，开启桌面聊天与碎碎念。<br>所有设置仅保存在本机，支持即时测试连接。</p></header>
<form id="settings" aria-describedby="privacy">
<fieldset><legend>模型连接</legend>
<label for="protocol">接口协议</label><select id="protocol" name="protocol"><option value="openai-compatible">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select>
<label for="baseUrl">接口地址（Base URL）</label><input id="baseUrl" name="baseUrl" type="url" placeholder="https://example.com/v1" maxlength="2048" spellcheck="false" aria-describedby="endpoint-note"><p class="hint" id="endpoint-note">填写服务商提供的基础接口地址（支持 HTTP 与 HTTPS，通常以 /v1 结尾）。不要把密钥放进地址。</p>
<label for="model">模型名称</label><input id="model" name="model" type="text" maxlength="200" placeholder="填写服务商的模型 ID，例如 deepseek-chat" spellcheck="false">
<div class="key-heading"><label for="apiKey">API 密钥</label><span id="key-state" class="hint">尚未读取</span></div>
<input id="apiKey" name="apiKey" type="password" autocomplete="new-password" maxlength="8192" placeholder="留空保留已保存的密钥" aria-describedby="key-note">
<p id="key-note" class="hint">密钥只写入本机配置，不会回显。留空不会删除旧密钥。</p>
<label class="check clear"><input id="clearApiKey" type="checkbox">清除已保存的密钥，并关闭 AI</label>
<label class="check enabled"><input id="enabled" type="checkbox">启用 AI 对话</label>
<div class="test-row"><button id="test-btn" type="button">测试连接</button><span id="test-result" class="test-result" role="status" aria-live="polite"></span></div>
</fieldset>
<fieldset><legend>定时自动碎碎念</legend>
<label class="check"><input id="automaticWhispers" type="checkbox" aria-describedby="cost">开启自动碎碎念</label>
<p id="cost" class="notice">开启后，桌宠会按设定间隔定时调用模型并在桌面上说话冒泡（产生 API 费用）。默认关闭；右键菜单中的手动对话与手动碎碎念不受此开关限制。</p>
<div class="pair"><div><label for="whisperIntervalSec">碎碎念间隔（秒）</label><input id="whisperIntervalSec" type="number" min="60" max="86400" step="1" value="300" required></div>
<div><label for="maxTokens">单次输出上限（tokens）</label><input id="maxTokens" type="number" min="128" max="4096" step="1" value="1024" required></div></div>
<p class="hint">间隔至少 60 秒，默认 300 秒。输出上限越小，单次回复越简短。</p>
</fieldset>
<footer><p id="privacy">所有配置与密钥仅保存在当前机器。<br>关闭 AI 后，桌宠仍可正常显示、移动与互动。</p><button id="save" type="submit" disabled>保存到本机</button></footer>
<p id="status" role="status" aria-live="polite">正在读取本机设置…</p>
</form><noscript>需要启用 JavaScript 才能保存设置。请从桌宠菜单打开本页。</noscript></main></body></html>`;
const settingsStyle = `
:root{color-scheme:light;--ink:#203b4b;--muted:#526a78;--blue:#12618b;--line:#cbdce5;--paper:#fff;--water:#edf5fa}
*{box-sizing:border-box}body{margin:0;background:var(--water);color:var(--ink);font:16px/1.6 "Microsoft YaHei UI","PingFang SC",sans-serif}
main{max-width:720px;margin:48px auto;padding:0 24px 32px}header{padding:0 12px 28px}.fish{display:block;font:700 29px/1.3 Georgia,serif;color:var(--blue);letter-spacing:2px;margin-bottom:24px}.local{font-size:13px;color:var(--muted);margin:0 0 10px}h1{font-size:32px;line-height:1.3;letter-spacing:-1px;margin:0 0 16px;font-weight:700}.intro{margin:0;color:var(--muted)}
form{background:var(--paper);border:1px solid var(--line);border-radius:16px 16px 6px 6px;padding:28px 32px 20px}fieldset{padding:0 0 28px;margin:0 0 24px;border:0;border-bottom:1px solid var(--line);min-width:0}legend{font-size:19px;font-weight:700;margin-bottom:18px;padding:0}label{display:block;font-weight:600;font-size:14px;margin:14px 0 6px}input:not([type=checkbox]),select{display:block;width:100%;min-height:44px;border:1px solid #a5bdcb;border-radius:6px;background:#fff;color:var(--ink);padding:9px 12px;font:inherit;font-size:15px}input::placeholder{color:#6a7e8b}input[type=checkbox]{accent-color:var(--blue);width:18px;height:18px;flex-shrink:0;margin:0}.check{display:flex;align-items:center;gap:10px;min-height:32px;cursor:pointer}.enabled{margin-top:24px}.clear{font-weight:400;color:var(--muted);font-size:13px}.hint{font-size:12px;line-height:1.6;color:var(--muted);margin:7px 0 0}.key-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px}.key-heading label{margin:0 0 6px}.key-heading .hint{margin:0 0 6px}.notice{font-size:13px;color:#704b13;background:#fff7e7;border-left:3px solid #c18e36;margin:12px 0 16px;padding:12px 14px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}footer{display:flex;align-items:center;justify-content:space-between;gap:18px}footer p{font-size:12px;color:var(--muted);margin:0}button{border:0;border-radius:7px;min-height:44px;padding:10px 20px;background:var(--blue);color:#fff;font:600 15px/1.5 inherit;white-space:nowrap;cursor:pointer}button:hover{background:#0b4e73}button:disabled{opacity:.55;cursor:wait}:focus-visible{outline:3px solid #3a94c4;outline-offset:3px}#status{font-size:13px;min-height:24px;margin:18px 0 0;color:var(--blue)}#status[data-error=true]{color:#a13b30}
.test-row{display:flex;align-items:center;gap:14px;margin:20px 0 6px;flex-wrap:wrap}#test-btn{background:#fff;color:var(--blue);border:1.5px solid var(--blue);min-height:38px;padding:6px 18px;font-size:14px;border-radius:6px;cursor:pointer;font-weight:600}#test-btn:hover{background:#edf5fa}#test-btn:disabled{opacity:.6;cursor:wait}.test-result{font-size:13px;line-height:1.5;min-height:22px;flex:1 1 200px}.test-success{color:#1a7f37;font-weight:600}.test-error{color:#cf222e}.reply-preview{display:block;color:var(--muted);font-weight:normal;font-size:12px;margin-top:4px;word-break:break-all}
@media(max-width:560px){main{margin:24px auto;padding:0 14px 24px}header{padding:0 8px 24px}h1{font-size:28px}form{padding:24px 20px 16px}.pair{grid-template-columns:1fr;gap:0}footer{align-items:stretch;flex-direction:column}button{width:100%}.fish{margin-bottom:18px}}
`;
const settingsScript = `
'use strict';
(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  history.replaceState(null, '', location.pathname);
  const get = id => document.getElementById(id);
  const form = get('settings');
  const status = get('status');
  const save = get('save');
  const testBtn = get('test-btn');
  const testResult = get('test-result');
  function message(text, error = false) { status.textContent = text; status.dataset.error = String(error); }
  async function request(method, body) {
    const response = await fetch('/standalone-ai/settings', {
      method, credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { 'X-DSH-Pet-Token': token, ...(body ? {'Content-Type': 'application/json'} : {}) },
      ...(body ? {body: JSON.stringify(body)} : {})
    });
    if (!response.ok) {
      if (response.status === 403) throw new Error('打开凭据已失效。请从桌宠菜单重新打开设置。');
      if (response.status === 429) throw new Error('保存过于频繁，请稍等一分钟再试。');
      throw new Error('设置未保存。请检查接口地址、模型名称与密钥，再重试。');
    }
    return response.json();
  }
  function populate(data) {
    for (const id of ['protocol','baseUrl','model','whisperIntervalSec','maxTokens']) {
      if (data[id] !== undefined) get(id).value = String(data[id]);
    }
    for (const id of ['enabled','automaticWhispers']) get(id).checked = data[id] === true;
    get('key-state').textContent = data.hasKey ? '已保存 · 不回显' : '尚未设置';
    get('apiKey').value = '';
    get('clearApiKey').checked = false;
  }
  get('clearApiKey').addEventListener('change', () => {
    get('apiKey').disabled = get('clearApiKey').checked;
    if (get('clearApiKey').checked) {
      get('apiKey').value = '';
      get('enabled').checked = false;
      get('automaticWhispers').checked = false;
    }
  });
  if (testBtn && testResult) {
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      testResult.className = 'test-result';
      testResult.textContent = '正在测试连接，请稍候…';
      const input = {
        protocol: get('protocol').value,
        baseUrl: get('baseUrl').value.trim(),
        model: get('model').value.trim(),
        apiKey: get('apiKey').value.trim(),
      };
      try {
        const response = await fetch('/standalone-ai/test', {
          method: 'POST',
          credentials: 'omit',
          cache: 'no-store',
          headers: {
            'X-DSH-Pet-Token': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(input),
        });
        const data = await response.json();
        if (data.ok) {
          testResult.className = 'test-result test-success';
          testResult.textContent = '✓ ' + data.message;
          if (data.reply) {
            const preview = document.createElement('span');
            preview.className = 'reply-preview';
            preview.textContent = '回复: ' + data.reply;
            testResult.appendChild(preview);
          }
        } else {
          testResult.className = 'test-result test-error';
          testResult.textContent = '✗ ' + (data.message || data.error || '测试失败');
        }
      } catch (error) {
        testResult.className = 'test-result test-error';
        testResult.textContent = '✗ 请求异常：' + (error && error.message ? error.message : String(error));
      } finally {
        testBtn.disabled = false;
      }
    });
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    save.disabled = true;
    message('正在保存到本机…');
    const input = {
      protocol: get('protocol').value, baseUrl: get('baseUrl').value.trim(), model: get('model').value.trim(),
      apiKey: get('apiKey').value, clearApiKey: get('clearApiKey').checked,
      enabled: get('enabled').checked, automaticWhispers: get('automaticWhispers').checked,
      whisperIntervalSec: Number(get('whisperIntervalSec').value), maxTokens: Number(get('maxTokens').value)
    };
    get('apiKey').value = '';
    try {
      populate(await request('POST', input));
      get('apiKey').disabled = false;
      message('已保存到本机。');
    } catch (error) { message(error.message, true); }
    finally { save.disabled = false; }
  });
  if (!token) { message('请从桌宠菜单或本机启动器打开设置，以获得本次运行的访问凭据。', true); return; }
  request('GET').then(data => { populate(data); save.disabled = false; message('设置只在本机保存。'); })
    .catch(error => message(error.message, true));
})();
`;

//#endregion
//#region src/standalone/server.ts
const DEFAULT_STANDALONE_PORT = 3080;
const PORT_SCAN_LIMIT = 25;
function matches(route, pathname) {
	if (route.kind === "exact") return pathname === route.path;
	return pathname === route.path || pathname.startsWith(`${route.path}/`);
}
function sendJson(res, status, body, cors = false) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
		...cors ? { "access-control-allow-origin": "*" } : {}
	});
	res.end(payload);
}
function sendAsset(res, body, type) {
	res.writeHead(200, {
		"content-type": `${type}; charset=utf-8`,
		"content-length": Buffer.byteLength(body),
		"content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
		"x-frame-options": "DENY"
	});
	res.end(body);
}
function fail(res, _error, logger) {
	logger.error("独立模式路由处理失败（详细内容已省略以保护凭据）");
	if (res.headersSent) res.destroy();
	else sendJson(res, 500, { error: "本机服务暂时无法处理请求" });
}
function settingsHandler(ai) {
	let windowStart = Date.now();
	let count = 0;
	return async (req, res) => {
		if (!ai) {
			rejectRequest(res, 503, "本机 AI 设置尚未就绪");
			return;
		}
		if (req.method === "GET") {
			sendJson(res, 200, publicSettings(ai.getSettings()));
			return;
		}
		if (req.method !== "POST") {
			rejectRequest(res, 405, "仅支持 GET 或 POST");
			return;
		}
		if (Date.now() - windowStart >= 6e4) {
			windowStart = Date.now();
			count = 0;
		}
		count += 1;
		if (count > 20) {
			rejectRequest(res, 429, "保存过于频繁，请稍后再试");
			return;
		}
		if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
			rejectRequest(res, 415, "请使用 JSON 保存设置");
			return;
		}
		try {
			const chunks = [];
			await new Promise((resolve$1, reject) => {
				req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				req.once("end", resolve$1);
				req.once("error", reject);
			});
			const input = validateSettings$1(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			sendJson(res, 200, publicSettings(await ai.saveSettings(input)));
		} catch {
			rejectRequest(res, 400, "设置未保存：请检查接口地址、模型名称、密钥和数值范围");
		}
	};
}
function testHandler(ai) {
	return async (req, res) => {
		if (req.method !== "POST") {
			rejectRequest(res, 405, "仅支持 POST");
			return;
		}
		try {
			const chunks = [];
			await new Promise((resolve$1, reject) => {
				req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				req.once("end", resolve$1);
				req.once("error", reject);
			});
			const bodyStr = Buffer.concat(chunks).toString("utf8");
			const input = bodyStr ? JSON.parse(bodyStr) : {};
			if (ai?.testConnection) {
				const result = await ai.testConnection(input);
				sendJson(res, 200, result);
			} else sendJson(res, 200, {
				ok: false,
				message: "当前环境未配置测试能力"
			});
		} catch {
			sendJson(res, 400, {
				ok: false,
				message: "请求格式无效"
			});
		}
	};
}
function dispatch(options, shutdownSecurity) {
	const settings = settingsHandler(options.ai);
	const tester = testHandler(options.ai);
	return (req, res, pathname) => {
		const method = req.method ?? "GET";
		if (method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}
		if (pathname === "/" || pathname === "/health") {
			if (method !== "GET" && method !== "HEAD") {
				rejectRequest(res, 405, "仅支持 GET");
				return;
			}
			sendJson(res, 200, options.status?.() ?? { name: "dsh-pet-standalone" }, true);
			return;
		}
		if (pathname === "/shutdown") {
			if (method !== "POST") {
				rejectRequest(res, 405, "停机请使用 POST");
				return;
			}
			if (shutdownSecurity) {
				const supplied = req.headers["x-dsh-pet-token"];
				if (typeof supplied !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(shutdownSecurity.token))) {
					rejectRequest(res, 403, "停机需要提供令牌");
					return;
				}
			}
			sendJson(res, 200, {
				ok: true,
				stopping: true
			});
			queueMicrotask(() => options.onShutdown?.());
			return;
		}
		const assets = {
			"/standalone-ai/": [settingsPage, "text/html"],
			"/standalone-ai/settings.js": [settingsScript, "text/javascript"],
			"/standalone-ai/settings.css": [settingsStyle, "text/css"]
		};
		const asset = assets[pathname];
		if (asset) {
			if (method !== "GET" && method !== "HEAD") {
				rejectRequest(res, 405, "仅支持 GET");
				return;
			}
			sendAsset(res, asset[0], asset[1]);
			return;
		}
		if (pathname === "/standalone-ai/settings") {
			settings(req, res).catch((error) => fail(res, error, options.logger));
			return;
		}
		if (pathname === "/standalone-ai/test") {
			tester(req, res).catch((error) => fail(res, error, options.logger));
			return;
		}
		const route = options.routes.find((candidate) => matches(candidate, pathname));
		if (!route) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end(`dsh-pet-standalone: 没有匹配的路由（已注册：${options.routes.map((item) => item.path).join(", ") || "无"}）`);
			return;
		}
		try {
			Promise.resolve(route.handler(req, res)).catch((error) => fail(res, error, options.logger));
		} catch (error) {
			fail(res, error, options.logger);
		}
	};
}
function createRequestListener(options, injectedSecurity) {
	const security = options.security ?? injectedSecurity;
	const route = dispatch(options, security);
	return (req, res) => {
		let pathname;
		try {
			pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
		} catch {
			rejectRequest(res, 400, "请求地址无效");
			return;
		}
		secureResponse(res, pathname);
		if (security && !security.authorize(req, res)) return;
		options.logger.debug("收到本机 HTTP 请求");
		const hasBody = req.headers["transfer-encoding"] !== void 0 || Number(req.headers["content-length"] ?? 0) > 0;
		const bodyMethod = [
			"POST",
			"PUT",
			"PATCH",
			"DELETE"
		].includes(req.method ?? "");
		if ((hasBody || bodyMethod) && typeof req.on === "function") {
			const limit = pathname === "/standalone-ai/settings" ? MAX_SETTINGS_BYTES : MAX_REQUEST_BYTES;
			boundedRequest(req, res, limit, options.bodyTimeoutMs).then((bounded) => {
				if (bounded) route(bounded, res, pathname);
			}).catch((error) => fail(res, error, options.logger));
		} else route(req, res, pathname);
	};
}
async function bindFirstFree(server, preferred, logger) {
	for (let port = preferred; port < preferred + PORT_SCAN_LIMIT; port += 1) try {
		await new Promise((accept, reject) => {
			const onError = (error) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				accept();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(port, "127.0.0.1");
		});
		const address = server.address();
		const bound = typeof address === "object" && address !== null ? address.port : port;
		if (preferred > 0 && bound !== preferred) logger.warn(`端口 ${preferred} 被占用，改用 ${bound}`);
		return bound;
	} catch (error) {
		if (error.code !== "EADDRINUSE") throw error;
	}
	throw new Error(`从 ${preferred} 起连续 ${PORT_SCAN_LIMIT} 个端口都被占用`);
}
async function listenStandaloneServer(options) {
	const security = options.security;
	const server = createServer(createRequestListener(options, security));
	server.requestTimeout = 1e4;
	server.headersTimeout = 1e4;
	server.on("clientError", (_error, socket) => socket.destroy());
	const port = await bindFirstFree(server, options.port ?? DEFAULT_STANDALONE_PORT, options.logger);
	options.logger.info(`独立模式服务已监听 http://127.0.0.1:${port}/`);
	return {
		port,
		security: security ?? createRequestSecurity(),
		async close() {
			server.closeAllConnections();
			await new Promise((accept) => server.close(() => accept()));
		}
	};
}

//#endregion
//#region src/standalone/options.ts
const USAGE = `dsh-pet 独立模式（不需要 DSH）

用法：dsh-pet-standalone [选项]

选项：
  --port <端口>   监听端口（默认 ${DEFAULT_STANDALONE_PORT}；被占用时自动向后顺延）
  --check         只体检：打印配置来源、宠物清单与 Electron 状态，不启动窗口
  -h, --help      显示本帮助

说明：
  桌宠在独立模式下以「透明置顶小窗」运行；浏览器内浮层需要有 DSH 网页，独立模式不提供。
  对话与碎碎念可在本机 AI 设置页配置 API 后显式启用；未配置时不发送模型请求。
  余额 / DSH 会话工作状态 / 系统通知仍需要 DSH 宿主。
`;
function parseArgs(argv) {
	const options = {
		port: DEFAULT_STANDALONE_PORT,
		check: false,
		help: false
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		if (arg === "--check") options.check = true;
		else if (arg === "-h" || arg === "--help") options.help = true;
		else if (arg === "--port" || arg.startsWith("--port=")) {
			const raw = arg === "--port" ? String(argv[index + 1] ?? "") : arg.slice(7);
			if (arg === "--port") index += 1;
			const value = Number(raw);
			if (!Number.isInteger(value) || value < 1 || value > 65535) return { error: `--port 需要 1..65535 的整数端口，收到 ${JSON.stringify(raw)}` };
			options.port = value;
		} else return { error: `未知参数：${arg}` };
	}
	return { options };
}
function configPathsFor(root, home) {
	const userRoot = join(home, "dsh-pet");
	return {
		defaultFile: join(root, "assets", "config.jsonc"),
		userFile: join(userRoot, "main-config.jsonc"),
		legacyUserFile: join(userRoot, "main-config.json"),
		petDir: join(userRoot, "pet")
	};
}
function describePets(pets) {
	if (pets.length === 0) return "（没有宠物：配置里 pets 为空）";
	return pets.map((pet) => `${String(pet.id ?? "?")}(size=${String(pet.size ?? "?")}, display=${String(pet.display ?? "?")})`).join("  ");
}
function isDesktopVisible(pet) {
	const display = pet.display;
	return display === "desktop" || display === "both";
}

//#endregion
//#region src/standalone/check.ts
function packageVersion(root) {
	try {
		const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		return typeof parsed.version === "string" ? parsed.version : "unknown";
	} catch {
		return "unknown";
	}
}
function runCheck(logger) {
	const home = dshHomeDir();
	const paths = configPathsFor(packageRoot, home);
	const electron = resolveElectronPath();
	const lines = [
		`Node            ${process.version}（${process.platform}-${process.arch}）`,
		`插件            dsh-pet@${packageVersion(packageRoot)}  ${packageRoot}`,
		`DSH_HOME        ${home}`,
		`用户配置        ${paths.userFile}${existsSync(paths.userFile) ? "" : "（不存在 → 用包内默认）"}`,
		`文件宠物目录    ${paths.petDir}${existsSync(paths.petDir) ? "" : "（不存在）"}`,
		`内置默认配置    ${paths.defaultFile}${existsSync(paths.defaultFile) ? "" : "  ✗ 缺失"}`,
		`Electron        ${electron ?? `未发现（首次运行会下载到 ${electronLandingDir()}）`}`,
		`图形显示环境    ${hasGraphicalDisplay() ? "有" : "无（桌面小窗会跳过；远程桌面/Xvfb 可设 DSH_PET_DESKTOP_FORCE=1）"}`
	];
	const fail$1 = (message) => {
		for (const line of lines) logger.info(line);
		logger.error(message);
		return 1;
	};
	if (!existsSync(paths.defaultFile)) return fail$1("包内默认配置读不到：很可能是在**直接跑源码**（包根被解析成了 src/）。独立模式请用构建产物：npm run bundle 后 node lib/standalone.js，或 npm run standalone。");
	try {
		const merged = readAllConfig(paths);
		const entries = Object.keys(merged);
		lines.push(`配置条目        ${entries.length} 个：${entries.join(", ") || "（空）"}`);
		for (const entry of entries) {
			const conf = merged[entry] ?? {};
			const pets = Array.isArray(conf.pets) ? conf.pets : [];
			const animations = conf.animations;
			const idle = Array.isArray(animations?.idle) ? animations.idle.length : 0;
			lines.push(`  条目 ${entry}：宠物 ${pets.length} 只  ${describePets(pets)}｜idle 动画 ${idle} 个`);
		}
		const desktopVisible = flattenPetList(merged).filter(isDesktopVisible);
		lines.push(`桌面小窗        ${desktopVisible.length} 只${desktopVisible.length === 0 ? "（display 需要 desktop 或 both，否则独立模式没有可显示的宠物）" : ""}`);
		for (const line of lines) logger.info(line);
		logger.info("结论：配置与 Electron 就绪，可以直接启动（npm run standalone）。");
		return 0;
	} catch (error) {
		return fail$1(`读配置失败：${error instanceof Error ? error.message : String(error)}`);
	}
}

//#endregion
//#region src/standalone/ai-storage.ts
const MAX_CONFIG_BYTES = 32768;
/** Never pass a shell command, account name, or an unvalidated SID to icacls. */
function restrictFile(path) {
	if (process.platform !== "win32") {
		chmodSync(path, 384);
		return;
	}
	const identity = execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"), [
		"/user",
		"/fo",
		"csv",
		"/nh"
	], {
		encoding: "utf8",
		windowsHide: true
	});
	const sid = identity.match(/\bS-1-\d+(?:-\d+)+\b/)?.[0];
	if (!sid) throw new Error("Cannot identify file owner");
	execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [
		path,
		"/inheritance:r",
		"/grant:r",
		`*${sid}:F`
	], {
		stdio: "pipe",
		windowsHide: true
	});
}
function configPath(home) {
	const directory = join(home, "dsh-pet");
	if (!existsSync(directory)) mkdirSync(directory, {
		recursive: true,
		mode: 448
	});
	const info = lstatSync(directory);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe settings directory");
	return join(directory, "standalone-ai.json");
}
function readAiSettings(home) {
	const path = configPath(home);
	if (!existsSync(path)) return void 0;
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) throw new Error("Unsafe settings file");
	if (process.platform === "win32") {
		const acl = execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [path], {
			encoding: "utf8",
			windowsHide: true
		});
		if (/\b(?:Everyone|BUILTIN\\Users|Authenticated Users)\s*:/i.test(acl)) throw new Error("Unsafe settings permissions");
	}
	restrictFile(path);
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		if (fstatSync(fd).size > MAX_CONFIG_BYTES) throw new Error("Settings file too large");
		return JSON.parse(readFileSync(fd, "utf8"));
	} finally {
		closeSync(fd);
	}
}
function writeAiSettings(home, settings) {
	writePrivateJson(configPath(home), settings);
}
function writePrivateJson(path, settings) {
	const directory = lstatSync(dirname(path));
	if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe private file directory");
	if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error("Unsafe settings file");
	const temporary = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 384);
	try {
		restrictFile(temporary);
		writeFileSync(fd, JSON.stringify(settings), { encoding: "utf8" });
		fsyncSync(fd);
		closeSync(fd);
	} catch (error) {
		closeSync(fd);
		unlinkSync(temporary);
		throw error;
	}
	try {
		renameSync(temporary, path);
	} catch (error) {
		unlinkSync(temporary);
		throw error;
	}
}

//#endregion
//#region src/standalone/ai-config.ts
const DEFAULT_AI_SETTINGS = Object.freeze({
	protocol: "openai-compatible",
	baseUrl: "",
	model: "",
	enabled: false,
	automaticWhispers: false,
	whisperIntervalSec: 300,
	maxTokens: 1024,
	timeoutMs: 3e4,
	apiKey: ""
});
function safeEndpoint(value) {
	if (!value) return true;
	if (value !== value.trim() || /[\s\\]/.test(value)) return false;
	try {
		const url = new URL(value);
		if (url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#")) return false;
		return ["http:", "https:"].includes(url.protocol);
	} catch {
		return false;
	}
}
function containsControlChar(s) {
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code >= 0 && code <= 31 || code === 127) return true;
	}
	return false;
}
const fields = {
	protocol: z.enum(["openai-compatible", "anthropic"]),
	baseUrl: z.string().max(2048).refine(safeEndpoint),
	model: z.string().trim().max(200).refine((s) => !containsControlChar(s)),
	enabled: z.boolean(),
	automaticWhispers: z.boolean(),
	whisperIntervalSec: z.number().int().min(60).max(86400),
	maxTokens: z.number().int().min(128).max(4096),
	timeoutMs: z.number().int().min(1e3).max(6e4),
	apiKey: z.string().max(4096).refine((s) => !containsControlChar(s) && !/\s/.test(s))
};
const persistedSchema = z.object(fields).strict();
const patchSchema = persistedSchema.partial().extend({ clearApiKey: z.boolean().optional() }).strict();
function validateSettings(input, previous) {
	try {
		const patch = patchSchema.parse(input);
		if (patch.clearApiKey && patch.apiKey) throw new Error("Conflicting key changes");
		const { clearApiKey,...values } = patch;
		const apiKey = clearApiKey ? "" : values.apiKey || previous.apiKey;
		const next = persistedSchema.parse({
			...previous,
			...values,
			apiKey
		});
		if (next.enabled && (!next.model || !next.baseUrl || !next.apiKey)) throw new Error("Incomplete settings");
		return next;
	} catch {
		throw new Error("Invalid standalone AI settings.");
	}
}
function redact(settings) {
	const { apiKey,...publicFields } = settings;
	return {
		...publicFields,
		hasKey: apiKey.length > 0
	};
}
function createAiConfig(home) {
	let settings = DEFAULT_AI_SETTINGS;
	try {
		const loaded = readAiSettings(home);
		if (loaded !== void 0) settings = Object.freeze(validateSettings(persistedSchema.parse(loaded), DEFAULT_AI_SETTINGS));
	} catch {
		throw new Error("Cannot securely load standalone AI settings.");
	}
	return {
		current: () => settings,
		publicSettings: () => redact(settings),
		async save(input) {
			const next = validateSettings(input, settings);
			try {
				writeAiSettings(home, next);
			} catch {
				throw new Error("Cannot securely save standalone AI settings.");
			}
			settings = Object.freeze(next);
			return redact(settings);
		}
	};
}

//#endregion
//#region src/standalone/ai-transport.ts
const quiet = {
	debug() {},
	info() {},
	warn() {},
	error() {}
};
function isolatedFetch(settings, fetcher) {
	const base = settings.baseUrl.replace(/\/+$/, "");
	const expected = base + (settings.protocol === "anthropic" ? "/v1/messages" : "/chat/completions");
	return async (url, init) => {
		const beta = settings.protocol === "anthropic" && new URL(base).origin === "https://api.anthropic.com" && settings.model === "claude-opus-5-5";
		const urlStr = String(url);
		const validOpenAi = settings.protocol === "openai-compatible" && (urlStr === expected || urlStr === base + "/chat/completions" || urlStr === base + "/v1/chat/completions");
		const validAnthropic = settings.protocol === "anthropic" && (urlStr === expected + (beta ? "?beta=true" : "") || urlStr === base + "/messages" || urlStr === base + "/v1/messages" + (beta ? "?beta=true" : ""));
		if (!validOpenAi && !validAnthropic) throw new Error("Unexpected standalone AI endpoint.");
		const headers = new Headers({
			"content-type": "application/json",
			accept: "application/json"
		});
		if (settings.protocol === "anthropic") {
			headers.set("x-api-key", settings.apiKey);
			headers.set("anthropic-version", "2023-06-01");
			if (new URL(base).origin === "https://api.anthropic.com" && settings.model === "claude-opus-5-5") headers.set("anthropic-beta", "server-side-fallback-2026-07-01");
		} else headers.set("authorization", `Bearer ${settings.apiKey}`);
		return fetcher(url, {
			method: "POST",
			body: init?.body,
			headers,
			signal: init?.signal,
			redirect: "error"
		});
	};
}
async function* sdkTextStream(settings, request, signal, fetcher) {
	const shared = {
		apiKey: settings.apiKey,
		baseURL: settings.baseUrl.replace(/\/+$/, ""),
		maxRetries: 0,
		timeout: settings.timeoutMs,
		fetch: isolatedFetch(settings, fetcher),
		logger: quiet,
		logLevel: "off"
	};
	if (settings.protocol === "openai-compatible") {
		const client$1 = new OpenAI({
			...shared,
			organization: null,
			project: null,
			webhookSecret: null
		});
		const messages = [...request.system ? [{
			role: "system",
			content: request.system
		}] : [], ...request.messages];
		const stream$1 = await client$1.chat.completions.create({
			model: settings.model,
			messages,
			stream: true,
			max_tokens: settings.maxTokens,
			n: 1
		}, { signal });
		for await (const event of stream$1) {
			const delta = event.choices.find((choice) => choice.index === 0)?.delta;
			if (delta?.refusal) yield { refusal: true };
			if (delta?.content) yield { text: delta.content };
		}
		return;
	}
	const client = new Anthropic({
		...shared,
		authToken: null,
		webhookKey: null
	});
	const opus = settings.model === "claude-opus-5-5";
	const firstParty = new URL(settings.baseUrl).origin === "https://api.anthropic.com";
	const parameters = {
		model: settings.model,
		max_tokens: settings.maxTokens,
		system: request.system,
		messages: request.messages,
		stream: true,
		...opus ? {
			thinking: { type: "adaptive" },
			output_config: { effort: "low" }
		} : {}
	};
	const stream = opus && firstParty ? await client.beta.messages.create({
		...parameters,
		betas: ["server-side-fallback-2026-07-01"],
		fallbacks: "default"
	}, { signal }) : await client.messages.create(parameters, { signal });
	for await (const event of stream) {
		if (event.type === "message_delta" && event.delta.stop_reason === "refusal") yield { refusal: true };
		if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield { text: event.delta.text };
	}
}
function isAuthenticationFailure(error) {
	return error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError || error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError;
}
function isRateLimitFailure(error) {
	return error instanceof OpenAI.RateLimitError || error instanceof Anthropic.RateLimitError;
}

//#endregion
//#region src/standalone/ai-provider.ts
const PROVIDER = "standalone";
const MAX_INPUT_CHARS = 32768;
const MAX_OUTPUT_CHARS = 16384;
const MAX_EVENTS = 4096;
const REQUESTS_PER_MINUTE = 6;
const RATE_WINDOW_MS = 6e4;
const textBlock = z.object({
	type: z.literal("text"),
	text: z.string().max(MAX_INPUT_CHARS)
});
const messageSchema = z.object({
	role: z.enum(["user", "assistant"]),
	content: z.union([z.string().max(MAX_INPUT_CHARS), z.array(z.unknown()).max(128)])
});
const inputSchema = z.object({
	provider: z.literal(PROVIDER),
	model: z.string().max(200),
	system: z.string().max(MAX_INPUT_CHARS).optional(),
	messages: z.array(messageSchema).min(1).max(64),
	signal: z.custom((value) => value instanceof AbortSignal).optional()
});
function parseRequest(options, model) {
	const parsed = inputSchema.safeParse(options);
	if (!parsed.success || parsed.data.model !== model) throw new Error("Invalid standalone AI model selection or input.");
	const { data } = parsed;
	const messages = data.messages.map((message) => ({
		role: message.role,
		content: typeof message.content === "string" ? message.content : message.content.map((block) => {
			if (typeof block !== "object" || block === null || !("type" in block) || block.type !== "text") return "";
			const result = textBlock.safeParse(block);
			if (!result.success) throw new Error("Invalid standalone AI text input.");
			return result.data.text;
		}).join("")
	})).filter((message) => message.content.trim().length > 0);
	const system = data.system ?? "";
	const size = system.length + messages.reduce((sum, message) => sum + message.content.length, 0);
	if (size > MAX_INPUT_CHARS || messages.length === 0 || messages[0].role !== "user" || messages[messages.length - 1]?.role !== "user") throw new Error("Standalone AI input is empty or exceeds limits.");
	return {
		request: {
			system,
			messages
		},
		signal: data.signal
	};
}
function abortable(promise, signal) {
	if (signal.aborted) return Promise.reject(new Error("Standalone AI request cancelled."));
	return new Promise((resolve$1, reject) => {
		const abort = () => reject(new Error("Standalone AI request cancelled."));
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve$1, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
function createStandaloneAi(home, logger, dependencies = {}) {
	let store;
	try {
		store = createAiConfig(home);
	} catch {
		logger.error("Cannot securely load standalone AI settings.");
		throw new Error("Cannot securely load standalone AI settings.");
	}
	const fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
	const now = dependencies.now ?? Date.now;
	let disposed = false;
	let paused = false;
	let saving = false;
	let requests = [];
	let active;
	const ready = () => !disposed && !paused && !saving && store.current().enabled && !!store.current().model && !!store.current().baseUrl && !!store.current().apiKey;
	const selection = () => ({
		provider: PROVIDER,
		model: ready() ? store.current().model : ""
	});
	async function* stream(options) {
		if (!ready()) throw new Error("Standalone AI is not ready. Configure and enable the model first.");
		const settings = store.current();
		const { request, signal: callerSignal } = parseRequest(options, settings.model);
		if (callerSignal?.aborted) throw new Error("Standalone AI request cancelled.");
		if (active) throw new Error("Standalone AI is busy. Please wait.");
		const recent = requests.filter((time) => now() - time < RATE_WINDOW_MS);
		if (recent.length >= REQUESTS_PER_MINUTE) throw new Error("Standalone AI rate limit reached. Please wait.");
		requests = [...recent, now()];
		const controller = new AbortController();
		active = controller;
		const abort = () => controller.abort();
		callerSignal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(abort, settings.timeoutMs);
		const iterator = sdkTextStream(settings, request, controller.signal, fetcher)[Symbol.asyncIterator]();
		let emitted = 0;
		let events = 0;
		try {
			while (true) {
				const part = await abortable(iterator.next(), controller.signal);
				if (controller.signal.aborted || !ready()) throw new Error("Standalone AI request cancelled.");
				if (part.done) break;
				if (++events > MAX_EVENTS) throw new Error("Standalone AI response exceeds limits.");
				if (part.value.refusal) throw new Error("Standalone AI could not answer this request.");
				const text = part.value.text;
				if (!text) continue;
				emitted += text.length;
				if (emitted > MAX_OUTPUT_CHARS) throw new Error("Standalone AI response exceeds limits.");
				yield {
					type: "text",
					text
				};
			}
			if (emitted === 0) throw new Error("Standalone AI returned no text.");
		} catch (error) {
			if (isAuthenticationFailure(error)) {
				paused = true;
				logger.warn("Standalone AI authentication failed; save settings again to resume.");
				throw new Error("Standalone AI authentication failed. Check credentials and save settings again.", { cause: error });
			}
			if (controller.signal.aborted) throw new Error("Standalone AI request cancelled or timed out.", { cause: error });
			if (isRateLimitFailure(error)) throw new Error("Standalone AI provider rate limit reached. Please wait.", { cause: error });
			if (error instanceof Error && [
				"Standalone AI could not answer this request.",
				"Standalone AI returned no text.",
				"Standalone AI response exceeds limits."
			].includes(error.message)) throw error;
			logger.warn("Standalone AI request failed.");
			throw new Error("Standalone AI request failed. Check the endpoint and model settings.", { cause: error });
		} finally {
			clearTimeout(timer);
			callerSignal?.removeEventListener("abort", abort);
			controller.abort();
			if (active === controller) active = void 0;
			iterator.return?.().catch(() => logger.debug("Standalone AI transport closed."));
		}
	}
	return {
		currentSelection: selection,
		listProviders: () => ready() ? [{
			id: PROVIDER,
			name: "Standalone AI"
		}] : [],
		listModels: async (provider) => ready() && provider === PROVIDER ? [{
			id: settingsModel(),
			name: settingsModel()
		}] : [],
		resolveModelInfo: async (provider = PROVIDER, model = settingsModel(), signal) => ready() && !signal?.aborted && provider === PROVIDER && model === settingsModel() ? {
			id: model,
			name: model
		} : void 0,
		stream,
		getSettings: () => store.publicSettings(),
		async saveSettings(input) {
			if (disposed) throw new Error("Standalone AI is disposed.");
			if (saving) throw new Error("Standalone AI settings are being saved.");
			saving = true;
			active?.abort();
			try {
				const result = await store.save(input);
				if (!disposed) paused = false;
				return result;
			} catch (error) {
				paused = true;
				throw error;
			} finally {
				saving = false;
			}
		},
		isReady: ready,
		async testConnection(input) {
			if (disposed) return {
				ok: false,
				message: "服务已关闭"
			};
			const current = store.current();
			const protocol = input.protocol === "anthropic" ? "anthropic" : input.protocol ?? current.protocol;
			const baseUrl = (input.baseUrl !== void 0 ? input.baseUrl : current.baseUrl).trim();
			const model = (input.model !== void 0 ? input.model : current.model).trim();
			const apiKey = (input.apiKey !== void 0 && input.apiKey !== "" ? input.apiKey : current.apiKey).trim();
			if (!baseUrl) return {
				ok: false,
				message: "请先填写接口地址（Base URL）"
			};
			if (!model) return {
				ok: false,
				message: "请先填写模型名称"
			};
			if (!apiKey) return {
				ok: false,
				message: "请先填写 API 密钥"
			};
			const testSettings = {
				protocol,
				baseUrl,
				model,
				apiKey,
				enabled: true,
				automaticWhispers: false,
				whisperIntervalSec: 300,
				maxTokens: 32,
				timeoutMs: 15e3
			};
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 15e3);
			try {
				const testStream = sdkTextStream(testSettings, {
					system: "",
					messages: [{
						role: "user",
						content: "hi"
					}]
				}, controller.signal, fetcher);
				let reply = "";
				for await (const chunk of testStream) {
					if (chunk.refusal) return {
						ok: false,
						message: "模型拒绝回答该测试请求"
					};
					if (chunk.text) {
						reply += chunk.text;
						if (reply.length >= 40) break;
					}
				}
				if (!reply.trim()) return {
					ok: true,
					message: "连接成功！接口已成功响应。",
					reply: "(模型返回了空白内容)"
				};
				return {
					ok: true,
					message: "连接成功！模型响应正常。",
					reply: reply.trim()
				};
			} catch (error) {
				if (controller.signal.aborted) return {
					ok: false,
					message: "连接超时（15 秒未响应）：请检查网络连通性或服务器状态"
				};
				if (isAuthenticationFailure(error)) return {
					ok: false,
					message: "身份验证失败 (HTTP 401/403)：请检查 API 密钥是否正确"
				};
				if (isRateLimitFailure(error)) return {
					ok: false,
					message: "请求受限或配额超限 (HTTP 429)：请检查 API 账户余额或调用频率"
				};
				const rawMsg = error instanceof Error ? error.message : String(error);
				if (rawMsg.includes("404")) return {
					ok: false,
					message: "接口路径或模型不存在 (HTTP 404)：请检查接口地址（通常以 /v1 结尾）与模型名称"
				};
				if (rawMsg.includes("ECONNREFUSED") || rawMsg.includes("fetch failed")) return {
					ok: false,
					message: "无法连接到目标服务器：请检查地址与端口是否正确、服务器是否正在运行"
				};
				return {
					ok: false,
					message: `连接失败：${rawMsg}`
				};
			} finally {
				clearTimeout(timer);
			}
		},
		canWhisper: () => ready() && store.current().automaticWhispers,
		dispose() {
			disposed = true;
			active?.abort();
		}
	};
	function settingsModel() {
		return store.current().model;
	}
}

//#endregion
//#region src/standalone/runtime-state.ts
function writeStandaloneRuntime(home, details) {
	const directory = join(home, "dsh-pet");
	mkdirSync(directory, { recursive: true });
	const file = join(directory, "standalone-runtime.json");
	try {
		writePrivateJson(file, {
			name: "dsh-pet-standalone",
			pid: process.pid,
			startedAt: new Date().toISOString(),
			...details
		});
	} catch (error) {
		throw new Error("无法安全写入桌宠运行状态，请检查数据目录的访问权限。", { cause: error });
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		try {
			const current = JSON.parse(readFileSync(file, "utf8"));
			if (current.pid === process.pid && current.token === details.token) unlinkSync(file);
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw new Error("清理桌宠运行状态失败；请检查数据目录，未删除其他进程的状态。", { cause: error });
		}
	};
}

//#endregion
//#region src/standalone/context.ts
const STANDALONE_PROVIDER = "standalone";
function createStandaloneLogger() {
	const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
	const write = (level, message) => {
		console.log(`[dsh-pet-standalone ${stamp()}] ${level} ${message}`);
	};
	return {
		info: (message) => write("INFO ", message),
		warn: (message) => write("WARN ", message),
		error: (message) => write("ERROR", message),
		debug: (message) => {
			if (process.env.DSH_PET_STANDALONE_DEBUG === "1") write("DEBUG", message);
		}
	};
}
function createStandaloneContext(options) {
	const { logger, ai } = options;
	const routes = options.routes ?? [];
	const failures = [];
	/** effect 释放函数（后注册先释放，与 Cordis 的逆序释放一致） */
	const disposers = [];
	/** 插件通过 ctx.provide 挂出去的服务（独立模式没有其他插件，通常为空） */
	const services = new Map();
	let disposed = false;
	const portOf = () => typeof options.port === "function" ? options.port() : options.port;
	const webServer = {
		get port() {
			return portOf();
		},
		register(spec) {
			routes.push({
				kind: spec.kind,
				path: spec.path,
				handler: spec.handler
			});
			return () => {
				const index = routes.findIndex((route) => route.handler === spec.handler);
				if (index >= 0) routes.splice(index, 1);
			};
		}
	};
	const context = {
		effect(fn) {
			try {
				const dispose = fn();
				if (typeof dispose === "function") disposers.push(dispose);
				return dispose;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push(message);
				logger.error(`初始化某项失败（已跳过）：${message}`);
				return void 0;
			}
		},
		provide(name, value) {
			services.set(name, value);
			return () => {
				if (services.get(name) === value) services.delete(name);
			};
		},
		get(name) {
			return services.get(name);
		},
		on() {
			return () => {};
		},
		logger,
		webServer,
		connection: { authenticatedUrl: options.authenticatedUrl ?? ((baseUrl) => baseUrl) },
		...ai ? { standaloneAi: {
			isReady: () => ai.isReady(),
			canWhisper: () => ai.canWhisper(),
			whisperIntervalSec: () => ai.getSettings().whisperIntervalSec
		} } : {},
		commands: { register: () => () => {} },
		agentDefaultModel: { currentSelection: () => ai?.currentSelection() ?? {
			provider: STANDALONE_PROVIDER,
			model: ""
		} },
		credentials: { resolve: async () => void 0 },
		llm: ai ? {
			listProviders: () => ai.listProviders(),
			listModels: (provider) => ai.listModels(provider),
			resolveModelInfo: (provider, model, signal) => ai.resolveModelInfo(provider, model, signal),
			stream: (request) => ai.stream(request)
		} : {
			listProviders: () => [],
			listModels: async () => [],
			resolveModelInfo: async () => void 0,
			stream: () => ({ [Symbol.asyncIterator]() {
				return { next: async () => {
					throw new Error("dsh-pet standalone: 独立模式未接入模型（碎碎念/对话不可用）");
				} };
			} })
		}
	};
	return {
		ctx: context,
		routes,
		failures,
		async dispose() {
			if (disposed) return;
			disposed = true;
			ai?.dispose();
			for (const dispose of disposers.splice(0).reverse()) try {
				await dispose();
			} catch (error) {
				logger.warn(`释放某项失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}
	};
}

//#endregion
//#region src/standalone/cli.ts
/** 启动独立模式：先起服务拿到端口，再 `apply`（插件据此拼桌面 Helper 的 configUrl） */
async function run(logger, options) {
	const home = dshHomeDir();
	const paths = configPathsFor(packageRoot, home);
	if (!existsSync(paths.defaultFile)) {
		logger.error(`包内默认配置缺失：${paths.defaultFile}。若你是在直接跑源码（包根被解析成了 src/），请改用构建产物：npm run bundle 后 node lib/standalone.js（或 npm run standalone）。`);
		process.exitCode = 1;
		return;
	}
	const routes = [];
	const portRef = { value: options.port };
	const ai = createStandaloneAi(home, logger);
	const security = createRequestSecurity();
	const context = createStandaloneContext({
		port: () => portRef.value,
		logger,
		routes,
		ai,
		authenticatedUrl: security.authenticatedUrl
	});
	let forwardShutdown = () => {};
	const server = await listenStandaloneServer({
		routes,
		logger,
		port: options.port,
		security,
		ai,
		status: () => ({
			name: "dsh-pet-standalone",
			pid: process.pid,
			pluginRoot: packageRoot,
			plugin: {
				root: packageRoot,
				version: packageVersion(packageRoot)
			},
			port: portRef.value,
			uptimeSec: Math.round(process.uptime())
		}),
		onShutdown: () => forwardShutdown()
	});
	portRef.value = server.port;
	let releaseRuntime;
	try {
		releaseRuntime = writeStandaloneRuntime(home, {
			port: server.port,
			token: security.token,
			settingsUrl: security.authenticatedUrl(`http://127.0.0.1:${server.port}`),
			pluginRoot: packageRoot
		});
	} catch (error) {
		await context.dispose();
		await server.close();
		throw error;
	}
	let shuttingDown = false;
	const shutdown = async (reason) => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info(`收尾（${reason}）…`);
		try {
			await context.dispose();
		} finally {
			await server.close();
			releaseRuntime();
		}
		logger.info("已退出。");
	};
	const requestShutdown = (reason) => {
		shutdown(reason).then(() => process.exit(0)).catch((error) => {
			logger.error(`收尾失败：${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		});
	};
	forwardShutdown = () => requestShutdown("POST /shutdown");
	process.on("SIGINT", () => requestShutdown("SIGINT"));
	process.on("SIGTERM", () => requestShutdown("SIGTERM"));
	apply(context.ctx);
	let pets = [];
	let configSource = paths.userFile;
	try {
		pets = flattenPetList(readAllConfig(paths));
		if (!existsSync(paths.userFile)) configSource = `${paths.userFile}（不存在 → 用包内默认）`;
	} catch (error) {
		logger.warn(`读配置失败（服务照常运行，相关端点会显式报错）：${error instanceof Error ? error.message : String(error)}`);
	}
	const desktopVisible = pets.filter(isDesktopVisible);
	for (const line of [
		"",
		"===== dsh-pet 独立模式（不需要 DSH）=====",
		`  插件        dsh-pet@${packageVersion(packageRoot)}  ${packageRoot}`,
		`  路由        http://127.0.0.1:${server.port}/dsh-pet-7340/`,
		`  配置        ${configSource}`,
		`  宠物        ${describePets(pets)}`,
		desktopVisible.length === 0 ? "  桌面小窗    0 只：display 需要 desktop 或 both 才会出现透明小窗（服务仍在运行）" : `  桌面小窗    ${desktopVisible.length} 只`,
		ai.isReady() ? "  AI          本机 API 已启用；自动碎碎念遵循设置页开关" : "  AI          未配置或未启用，不发送模型请求；右键“打开 AI 设置”后在本机填写",
		"  不可用      余额 / 会话工作状态 / DSH 系统通知",
		"  退出        Ctrl+C，或 POST /shutdown",
		""
	]) logger.info(line);
	if (context.failures.length > 0) logger.warn(`初始化期间有 ${context.failures.length} 项失败（见上方日志）；路由仍可用，相关端点会显式报错`);
}
/** CLI 入口 */
async function main() {
	const parsed = parseArgs(process.argv.slice(2));
	if ("error" in parsed) {
		console.error(`dsh-pet-standalone: ${parsed.error}\n`);
		console.error(USAGE);
		return 2;
	}
	const { options } = parsed;
	if (options.help) {
		console.log(USAGE);
		return 0;
	}
	const logger = createStandaloneLogger();
	if (options.check) return runCheck(logger);
	await run(logger, options);
	return 0;
}
main().then((code) => {
	if (code !== 0) process.exit(code);
}).catch((error) => {
	console.error(`dsh-pet-standalone: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.exit(1);
});

//#endregion