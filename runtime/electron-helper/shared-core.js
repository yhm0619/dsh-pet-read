var PetShared = (function(exports) {

"use strict";

//#region src/shared/constants.ts
const CANVAS_H = 360;
const FEET_Y = 330;
const HIT_BOX = {
	x0: 200,
	y0: 50,
	x1: 440,
	y1: 335
};
const DRAG_THRESHOLD = 5;
const SLINGSHOT_DOUBLE_MS = 200;
const PET_REF_WIDTH = 462;
const ANIMATION_EXT = ".webm";

//#endregion
//#region src/shared/pickers.ts
const pick = (pool, exclude) => {
	const entries = exclude ? pool.filter((n) => n !== exclude) : pool;
	const src = entries.length ? entries : pool;
	return src[Math.floor(Math.random() * src.length)];
};
const pickSlot = (slot, exclude) => {
	if (typeof slot === "string") return slot;
	const entries = exclude === void 0 ? slot : slot.filter((n) => n !== exclude);
	const src = entries.length ? entries : slot;
	return src[Math.floor(Math.random() * src.length)];
};
const slotIncludes = (slot, anim) => typeof slot === "string" ? slot === anim : slot.includes(anim);
const poolIncludes = (pool, anim) => pool.some((slot) => slotIncludes(slot, anim));
const isEventAnim = (events, anim) => events ? Object.values(events).some((pool) => poolIncludes(pool, anim)) : false;
const nextWorkStatusAnim = (pool, current) => {
	const idx = pool.findIndex((slot$1) => slotIncludes(slot$1, current));
	if (idx === -1) return null;
	const slot = pool[idx];
	if (!Array.isArray(slot) || slot.length <= 1) return null;
	return pickSlot(slot, current);
};
const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min));
const pickWeightedCategory = (categories, facing) => {
	const cats = categories.filter((c) => c.actions.length > 0);
	if (!cats.length) return null;
	const filtered = cats.filter((c) => !(c.noMirror && facing === "right"));
	const eligible = filtered.length ? filtered : cats;
	const totalW = eligible.reduce((s, c) => s + c.weight, 0) || 1;
	let t = Math.random() * totalW;
	for (const c of eligible) {
		t -= c.weight;
		if (t <= 0) return c;
	}
	return eligible[eligible.length - 1];
};
const rollKind = (roll, w, opts) => {
	const turn = opts?.fixed ? 0 : w.turn;
	const move = opts?.fixed ? 0 : w.move;
	const topEnd = (w.idle + turn + move) / 100;
	if (roll < w.idle / 100) return "idle";
	if (roll < (w.idle + turn) / 100) return "turn";
	if (roll < topEnd) return "move";
	return "action";
};
const pickCategoryAction = (categories, idlePool, facing, current) => {
	const cat = pickWeightedCategory(categories, facing);
	if (!cat) return {
		id: "FALLBACK",
		name: pick(idlePool, current)
	};
	return {
		id: cat.id,
		name: pick(cat.actions, current)
	};
};

//#endregion
//#region src/shared/displays.ts
const rectRight = (r) => r.x + r.width;
const rectBottom = (r) => r.y + r.height;
const boundingRect = (rects) => {
	if (rects.length === 0) return {
		x: 0,
		y: 0,
		width: 0,
		height: 0
	};
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const r of rects) {
		x0 = Math.min(x0, r.x);
		y0 = Math.min(y0, r.y);
		x1 = Math.max(x1, rectRight(r));
		y1 = Math.max(y1, rectBottom(r));
	}
	return {
		x: x0,
		y: y0,
		width: x1 - x0,
		height: y1 - y0
	};
};
const pointInRect = (r, x, y) => x >= r.x && x < rectRight(r) && y >= r.y && y < rectBottom(r);
const rectAtPoint = (rects, x, y) => {
	for (const r of rects) if (pointInRect(r, x, y)) return r;
	return null;
};
const indexAtPoint = (rects, x, y) => {
	for (let i = 0; i < rects.length; i++) if (pointInRect(rects[i], x, y)) return i;
	return -1;
};
const distToRectSq = (r, x, y) => {
	const dx = Math.max(r.x - x, 0, x - rectRight(r));
	const dy = Math.max(r.y - y, 0, y - rectBottom(r));
	return dx * dx + dy * dy;
};
const nearestIndex = (rects, x, y) => {
	let best = -1;
	let bestD = Infinity;
	for (let i = 0; i < rects.length; i++) {
		const d = distToRectSq(rects[i], x, y);
		if (d < bestD) {
			bestD = d;
			best = i;
		}
	}
	return best;
};
const resolveRect = (rects, x, y) => {
	const hit = rectAtPoint(rects, x, y);
	if (hit) return hit;
	const i = nearestIndex(rects, x, y);
	return i < 0 ? null : rects[i];
};
const clampPointInRect = (r, x, y) => ({
	x: Math.min(Math.max(x, r.x), rectRight(r) - 1),
	y: Math.min(Math.max(y, r.y), rectBottom(r) - 1)
});
const clampPointToRegion = (rects, x, y) => {
	if (rectAtPoint(rects, x, y)) return {
		x,
		y
	};
	const i = nearestIndex(rects, x, y);
	return i < 0 ? {
		x,
		y
	} : clampPointInRect(rects[i], x, y);
};
const regionArea = (rects) => rects.reduce((s, r) => s + r.width * r.height, 0);
const regionHoleRatio = (rects) => {
	const hull = boundingRect(rects);
	const hullArea = hull.width * hull.height;
	if (hullArea <= 0) return 0;
	return Math.max(0, 1 - regionArea(rects) / hullArea);
};
const translateRects = (rects, dx, dy) => rects.map((r) => ({
	x: r.x + dx,
	y: r.y + dy,
	width: r.width,
	height: r.height
}));

//#endregion
//#region src/shared/motion.ts
const planMove = (o) => {
	const side = o.sideAllow ?? 0;
	const distance = randomBetween(o.minDist, o.maxDist);
	const target = o.cx + o.dir * distance;
	if (o.areas && o.areas.length > 0) {
		const bodyHalf = o.halfW - side;
		if (!rectAtPoint(o.areas, target - bodyHalf - o.margin, o.cy)) return null;
		if (!rectAtPoint(o.areas, target + bodyHalf + o.margin, o.cy)) return null;
	} else {
		const leftBound = o.margin + o.halfW - side;
		const rightBound = o.W - o.margin - o.halfW + side;
		if (target < leftBound || target > rightBound) return null;
	}
	return {
		startRatio: o.cx / o.W,
		startYRatio: o.cy / o.H,
		targetRatio: target / o.W,
		totalRatio: Math.abs(target - o.cx) / o.W
	};
};
const anchorPixel = (o) => {
	const height = o.size * 9 / 16;
	const a = o.area ?? {
		x: 0,
		y: 0,
		width: o.W,
		height: o.H
	};
	const left = a.x + o.marginX;
	const top = a.y + o.marginY;
	const right = a.x + a.width - o.size - o.marginX;
	const bottom = a.y + a.height - height - o.marginY;
	switch (o.corner) {
		case "top-left": return {
			x: left,
			y: top
		};
		case "top-right": return {
			x: right,
			y: top
		};
		case "bottom-left": return {
			x: left,
			y: bottom
		};
		case "bottom-right": return {
			x: right,
			y: bottom
		};
	}
};

//#endregion
//#region src/shared/balance/tone.ts
const QUOTA_WARN_PERCENT = 70;
const QUOTA_CRIT_PERCENT = 90;
function quotaTone(percent) {
	if (percent >= QUOTA_CRIT_PERCENT) return "crit";
	if (percent >= QUOTA_WARN_PERCENT) return "warn";
	return "ok";
}

//#endregion
//#region src/shared/balance/parse.ts
/**
* 可选数字：缺省 → undefined；出现但非法 → null（调用方据此整拍跳过——不把 NaN/字符串送进展示层）。
*/
function optNum(value) {
	if (value === void 0 || value === null) return void 0;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}
function toBalanceState(raw) {
	if (!raw || typeof raw !== "object") return null;
	const r = raw;
	const provider = String(r.provider ?? "unknown");
	if (r.ok !== true) {
		const reason = r.reason === "unsupported" || r.reason === "credential-missing" || r.reason === "fetch-error" ? r.reason : "fetch-error";
		return {
			provider,
			ok: false,
			reason,
			message: typeof r.message === "string" ? r.message : void 0
		};
	}
	const d = r.data;
	if (!d || typeof d !== "object") return null;
	if (r.shape === "windows") {
		const monthly = optNum(d.monthly);
		const rolling = optNum(d.rolling);
		const weekly = optNum(d.weekly);
		const rollingCapUsd = optNum(d.rollingCapUsd);
		const weeklyCapUsd = optNum(d.weeklyCapUsd);
		const monthlyCapUsd = optNum(d.monthlyCapUsd);
		if (monthly === void 0 || monthly === null) return null;
		if (rolling === null || weekly === null || rollingCapUsd === null || weeklyCapUsd === null || monthlyCapUsd === null) return null;
		return {
			provider,
			shape: "windows",
			ok: true,
			rolling,
			weekly,
			monthly,
			rollingCapUsd,
			weeklyCapUsd,
			monthlyCapUsd,
			rollingLabel: typeof d.rollingLabel === "string" && d.rollingLabel.length > 0 ? d.rollingLabel : void 0,
			rollingResetsAt: typeof d.rollingResetsAt === "string" ? d.rollingResetsAt : void 0,
			weeklyResetsAt: typeof d.weeklyResetsAt === "string" ? d.weeklyResetsAt : void 0,
			monthlyResetsAt: typeof d.monthlyResetsAt === "string" ? d.monthlyResetsAt : void 0
		};
	}
	if (r.shape === "money") {
		const raw$1 = Array.isArray(d.wallets) ? d.wallets : [];
		const wallets = [];
		for (const item of raw$1) {
			if (!item || typeof item !== "object") continue;
			const w = item;
			if (typeof w.currency !== "string" || w.currency.length === 0) continue;
			if (typeof w.total !== "string" || w.total.length === 0) continue;
			wallets.push({
				currency: w.currency,
				total: w.total,
				granted: typeof w.granted === "string" && w.granted.length > 0 ? w.granted : "0.00",
				toppedUp: typeof w.toppedUp === "string" && w.toppedUp.length > 0 ? w.toppedUp : "0.00",
				fullBalance: typeof w.fullBalance === "string" && w.fullBalance.length > 0 ? w.fullBalance : void 0
			});
		}
		if (wallets.length === 0) return null;
		return {
			provider,
			shape: "money",
			ok: true,
			wallets,
			tier: d.tier === "peak" || d.tier === "idle" ? d.tier : void 0
		};
	}
	if (r.shape === "points") {
		if (typeof d.unit !== "string" || d.unit.length === 0) return null;
		if (typeof d.total !== "string" || d.total.length === 0) return null;
		return {
			provider,
			shape: "points",
			ok: true,
			points: {
				unit: d.unit,
				total: d.total,
				full: typeof d.full === "string" && d.full.length > 0 ? d.full : void 0
			}
		};
	}
	return null;
}

//#endregion
//#region src/shared/balance/handlers/money.ts
/**
* money：各币种按**自己的基准**（`fullBalance`）算「剩余比例」，再相加折算成已用百分比。
* 没有基准的币种跳过（不参与折算，不替它猜一个）；一个带基准的都没有 → undefined（不播档位）。
*/
function moneyPercent(v) {
	let remaining = 0;
	let based = 0;
	for (const w of v.wallets ?? []) {
		const total = Number(w.total);
		const full = Number(w.fullBalance);
		if (!Number.isFinite(total) || !Number.isFinite(full) || full <= 0) continue;
		remaining += total / full;
		based++;
	}
	if (based === 0) return void 0;
	return Math.max(0, Math.min(100, 100 - remaining * 100));
}
/**
* money：一行「余额（峰/谷）¥x.xx」。
*
* 只显示 `total !== 0` 的币种（**负数要显示**——透支是真的欠钱；正好 0 的不占地方），
* CNY 优先，用符号拼、`/` 分隔；全都为 0 时兜底显示主币种 ¥0.00（否则气泡会空一行）。
* 档位装饰（峰/谷）只有提供该计价规则的服务商才有；没有就不加括号那一段。
*/
function moneyRows(v) {
	const visible = (v.wallets ?? []).filter((w) => Number(w.total) !== 0).sort((a, b) => (a.currency === "CNY" ? 0 : 1) - (b.currency === "CNY" ? 0 : 1));
	const amount = visible.length > 0 ? visible.map((w) => (w.currency === "USD" ? "$" : "¥") + w.total).join("/") : "¥0.00";
	if (!v.tier) return [{
		role: "label",
		text: "余额 " + amount
	}];
	return [
		{
			role: "label",
			text: "余额（"
		},
		{
			role: "tier",
			tier: v.tier,
			text: v.tier === "peak" ? "峰" : "谷"
		},
		{
			role: "label",
			text: "）" + amount
		}
	];
}
const moneyHandler = {
	percent: moneyPercent,
	rows: moneyRows
};

//#endregion
//#region src/shared/balance/handlers/points.ts
/**
* points：与 money 同一套「按基准折算」的数学，数据来自 `points` 而非 `wallets`。
* 没有基准 / 基准非法 → undefined（不播档位，不替服务商猜一个）。
*/
function pointsPercent(v) {
	const total = Number(v.points?.total);
	const full = Number(v.points?.full);
	if (!Number.isFinite(total) || !Number.isFinite(full) || full <= 0) return void 0;
	return Math.max(0, Math.min(100, 100 - total / full * 100));
}
/**
* points：一行「余额 800 积分」。
* 单位是数据带出的后缀，**绝不套货币符号**（`currency` 那套 $/¥ 判断只属于 money）。
* 0 也照常显示：0 积分是真实读数。
*/
function pointsRows(v) {
	const p = v.points;
	if (!p) return [{
		role: "label",
		text: "积分数据不可用"
	}];
	return [{
		role: "label",
		text: "余额 " + p.total + " " + p.unit
	}];
}
const pointsHandler = {
	percent: pointsPercent,
	rows: pointsRows
};

//#endregion
//#region src/shared/balance/handlers/windows.ts
const WINDOW_LABELS = {
	weekly: "周",
	monthly: "月"
};
const DEFAULT_ROLLING_LABEL = "5h";
/** 窗口展示名：滚动窗取服务商自报值（缺省 5h），周/月走固定表 */
function windowLabel(v, w) {
	if (w === "rolling") return v.rollingLabel ?? DEFAULT_ROLLING_LABEL;
	return WINDOW_LABELS[w];
}
/** 各窗口的满额度（USD）：全部来自数据（展示层不写死任何服务商的额度） */
function windowQuotas(v) {
	return {
		rolling: v.rollingCapUsd,
		weekly: v.weeklyCapUsd,
		monthly: v.monthlyCapUsd
	};
}
function urgentWindow(v) {
	if (v.shape !== "windows") return void 0;
	const quotas = windowQuotas(v);
	const resets = {
		rolling: v.rollingResetsAt,
		weekly: v.weeklyResetsAt,
		monthly: v.monthlyResetsAt
	};
	const present = [
		"rolling",
		"weekly",
		"monthly"
	].filter((w) => v[w] !== void 0);
	if (present.length === 0) return void 0;
	const allQuotas = present.every((w) => {
		const quota = quotas[w];
		return quota !== void 0 && quota > 0;
	});
	let best;
	for (const w of present) {
		const percent = v[w] ?? 0;
		const quota = quotas[w];
		const cand = {
			label: windowLabel(v, w),
			percent,
			quotaUsd: quota,
			remainingUsd: allQuotas && quota !== void 0 ? quota * (100 - percent) / 100 : void 0,
			resetsAt: resets[w]
		};
		if (best === void 0) {
			best = cand;
			continue;
		}
		const moreUrgent = allQuotas ? (cand.remainingUsd ?? 0) < (best.remainingUsd ?? 0) : cand.percent > best.percent;
		if (moreUrgent) best = cand;
	}
	return best;
}
function resetInText(iso) {
	if (!iso) return "";
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return "";
	const delta = t - Date.now();
	if (delta <= 0) return "已重置";
	const hoursF = delta / 36e5;
	if (hoursF >= 96) return (Math.round(hoursF / 24 * 10) / 10).toFixed(1) + " 天";
	return Math.max(.1, Math.round(hoursF * 10) / 10).toFixed(1) + " 小时";
}
/** windows：三窗口取最大（只有月窗口时就是它自己） */
function windowsPercent(v) {
	return Math.max(v.rolling ?? 0, v.weekly ?? 0, v.monthly ?? 0);
}
/** windows：两行 —— 最紧迫窗口的「已用 N%」+ 重置倒计时 */
function windowsRows(v) {
	const w = urgentWindow(v);
	if (!w) return [{
		role: "label",
		text: "额度数据不可用"
	}];
	const reset = resetInText(w.resetsAt);
	return [{
		role: "label",
		text: w.label + "额度已用 " + Math.round(w.percent) + "%"
	}, {
		role: "sub",
		text: reset ? reset + "重置" : "已重置"
	}];
}
/**
* windows：展开态每个存在窗口一行 —— 窗口名 + 进度条 + 已用百分比 + 重置倒计时。
* 只列**存在**的窗口：`rolling` / `weekly` 缺省 = 该服务商没有这个窗口，不补 0、不画空条。
*/
function windowsDetail(v) {
	const resets = {
		rolling: v.rollingResetsAt,
		weekly: v.weeklyResetsAt,
		monthly: v.monthlyResetsAt
	};
	const rows = [];
	for (const w of [
		"rolling",
		"weekly",
		"monthly"
	]) {
		const percent = v[w];
		if (percent === void 0) continue;
		const reset = resetInText(resets[w]);
		const usedText = Math.round(percent) + "%";
		const resetText = reset === "" ? "已重置" : reset + "重置";
		rows.push({
			role: "quota",
			text: windowLabel(v, w) + " " + usedText + " " + resetText,
			label: windowLabel(v, w),
			percent,
			tone: quotaTone(percent),
			usedText,
			resetText
		});
	}
	return rows.length > 0 ? rows : windowsRows(v);
}
const windowsHandler = {
	percent: windowsPercent,
	rows: windowsRows,
	detail: windowsDetail
};

//#endregion
//#region src/shared/balance/handlers/index.ts
const HANDLERS = {
	windows: windowsHandler,
	money: moneyHandler,
	points: pointsHandler
};

//#endregion
//#region src/shared/balance/percent.ts
function balancePercent(v) {
	return HANDLERS[v.shape].percent(v);
}
function balanceEventIndex(p) {
	if (p === 100) return 5;
	const i = Math.floor(p / 20);
	return i < 5 ? i : 4;
}

//#endregion
//#region src/shared/balance/view.ts
/** 不可用状态的气泡行（显式说明原因，绝不伪造数字）：
*  - unsupported：服务商未登记查询接口（配置事实，不是故障）→ 报出 provider id，便于自查"当前到底是谁"
*  - credential-missing：缺凭证 → 次要行放 host 报的凭证名（不含 message 时不留空行）
*  - fetch-error：抓取失败 → 次要行放底层错误
* 次要行为空的会被剔除：空 div 在气泡里会白占一行高度。 */
function unavailableRows(state) {
	const rows = state.reason === "unsupported" ? [{
		role: "error",
		text: "当前服务商暂不支持余额查询"
	}, {
		role: "sub",
		text: "当前服务商：" + state.provider
	}] : state.reason === "credential-missing" ? [{
		role: "error",
		text: "缺少余额查询凭证"
	}, {
		role: "sub",
		text: state.message ?? ""
	}] : [{
		role: "error",
		text: "余额查询失败"
	}, {
		role: "sub",
		text: state.message ?? ""
	}];
	return rows.filter((r) => r.role !== "quota" && r.text !== "");
}
function balanceBubbleView(state) {
	if (!state.ok) return unavailableRows(state);
	return HANDLERS[state.shape].rows(state);
}
function balanceDetailView(state) {
	if (!state.ok) return unavailableRows(state);
	const handler = HANDLERS[state.shape];
	return handler.detail ? handler.detail(state) : handler.rows(state);
}

//#endregion
//#region src/shared/balance/notice.ts
function decideBalanceNotice(state, lastKey, explicit) {
	if (state.ok) return {
		show: false,
		key: null
	};
	const key = state.reason + ":" + state.provider;
	return {
		show: explicit || key !== lastKey,
		key
	};
}

//#endregion
//#region src/shared/whisper.ts
function whisperBubbleView(state) {
	if (state.ok) return [{
		role: "label",
		text: state.text
	}];
	const msg = state.reason === "provider-missing" ? "当前对话未配置模型，碎碎念不可用" : "碎碎念生成失败" + (state.message ? "：" + state.message : "");
	return [{
		role: "label",
		text: msg
	}];
}
function memeImageUrl(name, base = "/dsh-pet-7340", assetRoot = "") {
	const root = String(assetRoot ?? "").trim();
	const prefix = root ? "/pic/memes/" + encodeURIComponent(root) : "/pic/memes";
	return base + prefix + "/" + encodeURIComponent(name) + ".png";
}
const MEME_IMG_CLASS = "pet-bub-img";
const MEME_BUBBLE_CLASS = "has-img";
const MEME_BUBBLE_CSS = [".pet-bub-img{--m:var(--f,calc(var(--dsh-pet-size,var(--pet-size,462px))*0.0455));display:block;width:calc(var(--m)*7.4725);max-width:100%;height:auto;border-radius:calc(var(--m)*0.5714);margin:0 auto calc(var(--m)*0.3736);object-fit:cover;pointer-events:none;user-select:none}", ".pet-bubble.has-img,.dsh-pet-bubble.has-img{min-width:0}"].join("");
/** 只注入一次（两端共用；页面已有同一标记则跳过） */
let memeCssInjected = false;
function injectMemeBubbleCss() {
	if (memeCssInjected || typeof document === "undefined") return;
	memeCssInjected = true;
	if (document.querySelector("style[data-plugin-css=\"dsh-pet/meme-bubble\"]") !== null) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-pet";
	tag.dataset.pluginCss = "dsh-pet/meme-bubble";
	tag.textContent = MEME_BUBBLE_CSS;
	document.head.appendChild(tag);
}
function createMemeImage(name, base = "/dsh-pet-7340", assetRoot = "") {
	const key = String(name ?? "").trim();
	if (!key) return null;
	injectMemeBubbleCss();
	const img = document.createElement("img");
	img.className = MEME_IMG_CLASS;
	img.src = memeImageUrl(key, base, assetRoot);
	img.alt = key;
	return img;
}
function createMemeImageFromUrl(url) {
	const href = String(url ?? "").trim();
	if (!href) return null;
	injectMemeBubbleCss();
	const img = document.createElement("img");
	img.className = MEME_IMG_CLASS;
	img.src = href;
	img.alt = "";
	return img;
}

//#endregion
//#region src/shared/config.ts
const PET_DISPLAYS = [
	"web",
	"desktop",
	"both",
	"none"
];
const isWebVisible = (display) => display === "web" || display === "both";
const isDesktopVisible = (display) => display === "desktop" || display === "both";
function flattenConfigPets(merged) {
	const out = [];
	for (const [entry, conf] of Object.entries(merged)) {
		const list = Array.isArray(conf?.pets) ? conf.pets : [];
		for (const p of list) out.push({
			...p,
			animations: conf.animations,
			animationWeights: conf.animationWeights,
			eventsRefreshSec: conf.eventsRefreshSec,
			physics: conf.physics,
			font: conf.font,
			confineToScreen: conf.confineToScreen,
			workStatusTexts: conf.workStatusTexts,
			whisperModel: conf.whisperModel,
			chatModel: conf.chatModel,
			interactiveIntervalSec: typeof conf.interactiveIntervalSec === "number" ? conf.interactiveIntervalSec : void 0,
			interactiveMaxChars: typeof conf.interactiveMaxChars === "number" ? conf.interactiveMaxChars : void 0,
			assetRoot: entry,
			extra: entry !== "main"
		});
	}
	return out;
}

//#endregion
//#region src/shared/fonts.ts
const FONT_PRESETS = [
	{
		id: "candy",
		stack: "\"ShangshouSoftCandy\",\"Yuanti SC\",\"YouYuan\",\"幼圆\",\"Comic Sans MS\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif"
	},
	{
		id: "yahei",
		stack: "\"Microsoft YaHei\",\"PingFang SC\",sans-serif"
	},
	{
		id: "youyuan",
		stack: "\"YouYuan\",\"Yuanti SC\",sans-serif"
	},
	{
		id: "kaiti",
		stack: "\"KaiTi\",\"STKaiti\",serif"
	},
	{
		id: "simsun",
		stack: "\"SimSun\",\"Songti SC\",serif"
	},
	{
		id: "comic",
		stack: "\"Comic Sans MS\",\"Comic Sans\",cursive"
	},
	{
		id: "system",
		stack: "system-ui,sans-serif"
	}
];
const FONT_SIZE_MIN = 4;
const FONT_SIZE_MAX = 200;
const DEFAULT_FONT = {
	family: "candy",
	size: 21,
	followPet: true
};
function fontStackOf(id) {
	return (FONT_PRESETS.find((p) => p.id === id) ?? FONT_PRESETS[0]).stack;
}
const FONT_REF_SIZE = 462;
const BUBBLE_FONT_BASE_PX = .0455 * FONT_REF_SIZE;
const TIP_FONT_BASE_PX = .026 * FONT_REF_SIZE;
function resolveFontPx(font, size) {
	const own = Number(font?.size);
	const ratio = Number.isFinite(own) && own > 0 ? own / DEFAULT_FONT.size : 1;
	const w = Number(size);
	const follow = font?.followPet !== false;
	const scale = follow && Number.isFinite(w) && w > 0 ? w / FONT_REF_SIZE : 1;
	return {
		bubble: BUBBLE_FONT_BASE_PX * ratio * scale,
		tip: TIP_FONT_BASE_PX * ratio * scale
	};
}
const BUBBLE_OVERLAP_RATIO = .108;
const BUBBLE_METRICS = {
	lineHeight: 1.6,
	padY: .4835,
	subScale: .7692,
	imgWidth: 7.4725,
	imgMargin: .3736,
	imgMaxRatio: 1
};
function bubbleMaxHeightPx(font, size) {
	const f = resolveFontPx(font, size).bubble;
	const m = BUBBLE_METRICS;
	return m.padY * 2 * f + m.lineHeight * f + m.lineHeight * m.subScale * f + m.imgWidth * m.imgMaxRatio * f + m.imgMargin * f;
}
function bubbleTopMarginPx(font, size) {
	const overlap = (Number(size) || 0) * BUBBLE_OVERLAP_RATIO;
	return Math.max(0, Math.ceil(bubbleMaxHeightPx(font, size) - overlap));
}

//#endregion
//#region src/shared/notify.ts
const NOTIFY_ICONS = {
	done: "notify-done",
	error: "notify-error",
	truncated: "notify-truncated",
	approval: "notify-approval",
	question: "notify-question",
	test: "notify-test"
};
const MAX_BODY = 80;
function truncate(text) {
	return text.length > MAX_BODY ? text.slice(0, MAX_BODY) + "…" : text;
}
function frameToToast(frame) {
	switch (frame.type) {
		case "session/event": {
			const ev = frame.event ?? {};
			if (ev.type !== "turn/end") return null;
			const kind = ev.data?.reason?.kind;
			if (kind === "completed") return {
				title: "对话完成",
				body: "",
				icon: NOTIFY_ICONS.done
			};
			if (kind === "error") return {
				title: "生成失败",
				body: ev.data?.reason?.error?.message ?? "",
				icon: NOTIFY_ICONS.error
			};
			if (kind === "max-tokens") return {
				title: "输出被截断",
				body: "已达到输出 token 上限",
				icon: NOTIFY_ICONS.truncated
			};
			return null;
		}
		case "approval/requested": {
			const toolName = typeof frame.toolName === "string" ? frame.toolName : "";
			const reason = typeof frame.reason === "string" && frame.reason ? frame.reason : "";
			return {
				title: "正在申请权限",
				body: (toolName ? "工具「" + toolName + "」" : "") + (reason ? "：" + reason : ""),
				icon: NOTIFY_ICONS.approval
			};
		}
		case "question/requested": {
			const q = Array.isArray(frame.questions) && frame.questions[0]?.question || "";
			return {
				title: "模型在等你回答",
				body: q,
				icon: NOTIFY_ICONS.question
			};
		}
		case "host/agent-error": return {
			title: "生成失败",
			body: typeof frame.message === "string" ? frame.message : "",
			icon: NOTIFY_ICONS.error
		};
		default: return null;
	}
}

//#endregion
//#region src/shared/menu.ts
const displayMenuBranch = () => ({
	label: "显示位置",
	children: [
		{
			label: "仅网页",
			action: "set-display",
			display: "web"
		},
		{
			label: "仅桌面",
			action: "set-display",
			display: "desktop"
		},
		{
			label: "两者",
			action: "set-display",
			display: "both"
		},
		{
			label: "都不",
			action: "set-display",
			display: "none"
		}
	]
});
const MORE_MENU_LABEL = "更多";
function readMenuItems(data) {
	if (!data || typeof data !== "object") return [];
	const items = data.items;
	if (!Array.isArray(items)) return [];
	const out = [];
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const owner = item.owner;
		const label = item.label;
		if (typeof owner === "string" && owner !== "" && typeof label === "string" && label !== "") out.push({
			owner,
			label
		});
	}
	return out;
}
function buildMoreBranch(items) {
	const groups = new Map();
	for (const item of items) {
		const list = groups.get(item.owner);
		if (list) list.push(item.label);
		else groups.set(item.owner, [item.label]);
	}
	const children = [];
	for (const [owner, labels] of groups) if (labels.length === 1) children.push({
		label: labels[0],
		action: "third-party",
		owner
	});
	else children.push({
		label: owner,
		children: labels.map((label) => ({
			label,
			action: "third-party",
			owner
		}))
	});
	return children.length > 0 ? {
		label: MORE_MENU_LABEL,
		children
	} : null;
}
/** 事件名 → 分类标签（无映射时用事件名本身） */
const EVENT_LABELS = {
	balance: "余额档位",
	whisper: "碎碎念",
	workStatus: "工作状态"
};
const leaf = (anim) => ({
	label: anim,
	anim
});
function buildMenuTree(animations) {
	const groups = [];
	const pools = [
		["待机", animations.idle],
		["转向", animations.turn],
		["拖拽", animations.drag],
		["点击回应", animations.clicks],
		["移动", animations.moves.actions.map((m) => m.name)]
	];
	for (const [label, pool] of pools) if (pool.length) groups.push({
		label,
		children: pool.map(leaf)
	});
	const cats = (animations.categories ?? []).filter((c) => c.actions.length > 0);
	for (const c of cats) groups.push({
		label: c.id,
		children: c.actions.map(leaf)
	});
	const events = animations.events ?? {};
	for (const key of Object.keys(events)) {
		const pool = events[key] ?? [];
		const names = [];
		for (const slot of pool) if (typeof slot === "string") names.push(slot);
		else names.push(...slot);
		if (names.length) groups.push({
			label: EVENT_LABELS[key] ?? key,
			children: names.map(leaf)
		});
	}
	if (!groups.length) return [];
	return [{
		label: "动作",
		children: groups
	}];
}
function isNoMirrorAnimation(categories, anim) {
	return (categories ?? []).some((c) => c.noMirror === true && c.actions.includes(anim));
}
const MENU_CSS = [
	".dsh-pet-menu{position:fixed;left:0;top:0;z-index:2147483000;color:#2b2b2b;font-size:13px;line-height:1.5;",
	"font-family:'Microsoft YaHei UI','Segoe UI','PingFang SC',sans-serif;user-select:none;pointer-events:auto}",
	".dsh-pet-menu,.dsh-pet-menu *{box-sizing:border-box}",
	".dsh-pet-menu-column{position:absolute;min-width:150px;max-width:300px;padding:4px;",
	"background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:8px;",
	"box-shadow:0 8px 28px rgba(0,0,0,.2);max-height:min(62vh,460px);overflow-y:auto;",
	"scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.22) transparent}",
	".dsh-pet-menu-column::-webkit-scrollbar{width:8px;height:8px}",
	".dsh-pet-menu-column::-webkit-scrollbar-track{background:transparent}",
	".dsh-pet-menu-column::-webkit-scrollbar-thumb{background:rgba(0,0,0,.16);border-radius:4px;",
	"border:2px solid transparent;background-clip:content-box}",
	".dsh-pet-menu-column::-webkit-scrollbar-thumb:hover{background:rgba(43,99,255,.4);",
	"border:2px solid transparent;background-clip:content-box}",
	".dsh-pet-menu-column::-webkit-scrollbar-corner{background:transparent}",
	".dsh-pet-menu-item{position:relative;display:flex;align-items:center;justify-content:space-between;",
	"gap:14px;padding:5px 12px;border-radius:6px;white-space:nowrap;cursor:default}",
	".dsh-pet-menu-item:hover{background:rgba(43,99,255,.14)}",
	".dsh-pet-menu-item>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis}",
	".dsh-pet-menu-hint{color:#9aa0a6;font-size:12px;flex:none;white-space:nowrap}",
	".dsh-pet-menu-arrow{color:#9aa0a6;font-size:12px;flex:none}"
].join("");
function isBranchNode(n) {
	return "children" in n && Array.isArray(n.children);
}
function mountContextMenu(opts) {
	const { tree, x, y, onAction, onClose, clamp } = opts;
	const c = clamp && Number.isFinite(clamp.x + clamp.y + clamp.w + clamp.h) ? clamp : {
		x: 0,
		y: 0,
		w: window.innerWidth,
		h: window.innerHeight
	};
	const root = document.createElement("div");
	root.className = "dsh-pet-menu";
	root.style.left = "0px";
	root.style.top = "0px";
	root.addEventListener("contextmenu", (e) => e.preventDefault());
	let closed = false;
	/** 每个面板当前展开的子面板（无 = 未展开）；hideChain 会沿链清除 */
	const openChild = new Map();
	/** 指针整体离开菜单树的兜底关闭定时器（root mouseover 重新进入即取消） */
	let leaveTimer = null;
	/** 关闭某面板及其后代面板整条链（display:none + 清 openChild 链） */
	const hideChain = (panel) => {
		panel.style.display = "none";
		const child = openChild.get(panel);
		if (child) {
			openChild.delete(panel);
			hideChain(child);
		}
	};
	/** 把面板显示在触发项旁边：右缘展开，贴右/下边缘自动翻转夹取（在 clamp 矩形内） */
	const showPanel = (panel, item) => {
		const rect = item.getBoundingClientRect();
		panel.style.left = "";
		panel.style.top = "";
		panel.style.display = "block";
		let left = rect.right + 4;
		if (left + panel.offsetWidth > c.x + c.w - 4) left = rect.left - panel.offsetWidth - 4;
		left = Math.max(c.x + 4, left);
		let top = rect.top;
		if (top + panel.offsetHeight > c.y + c.h - 4) top = Math.max(c.y + 4, c.y + c.h - 4 - panel.offsetHeight);
		panel.style.left = left + "px";
		panel.style.top = top + "px";
	};
	/** 构建一层面板（nodes 列表）；分支项的子面板**平级**挂到 root 下，不嵌套。
	*  面板自身先入 DOM、子面板随后入 → 层级越深绘制越靠上（子菜单盖在父菜单上层）。 */
	const buildPanel = (nodes) => {
		const panel = document.createElement("div");
		panel.className = "dsh-pet-menu-column";
		panel.style.display = "none";
		if (clamp) panel.style.maxHeight = Math.min(460, Math.max(120, c.h - 16)) + "px";
		root.appendChild(panel);
		for (const node of nodes) {
			const item = document.createElement("div");
			item.className = "dsh-pet-menu-item";
			if (isBranchNode(node)) {
				item.classList.add("dsh-pet-menu-branch");
				const label = document.createElement("span");
				label.textContent = node.label;
				const arrow = document.createElement("span");
				arrow.className = "dsh-pet-menu-arrow";
				arrow.textContent = "▸";
				item.appendChild(label);
				item.appendChild(arrow);
				const childPanel = buildPanel(node.children);
				item.addEventListener("mouseenter", () => {
					const prev = openChild.get(panel);
					if (prev && prev !== childPanel) hideChain(prev);
					openChild.set(panel, childPanel);
					showPanel(childPanel, item);
				});
			} else {
				const label = document.createElement("span");
				label.textContent = node.label;
				item.appendChild(label);
				if (node.hint) {
					const hint = document.createElement("span");
					hint.className = "dsh-pet-menu-hint";
					hint.textContent = node.hint;
					item.appendChild(hint);
				}
				item.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					close();
					onAction(node);
				});
			}
			panel.appendChild(item);
		}
		return panel;
	};
	const rootPanel = buildPanel(tree);
	rootPanel.style.display = "block";
	document.body.appendChild(root);
	rootPanel.style.left = "";
	rootPanel.style.top = "";
	const rw = rootPanel.offsetWidth;
	const rh = rootPanel.offsetHeight;
	rootPanel.style.left = Math.max(c.x + 4, Math.min(x, c.x + c.w - rw - 4)) + "px";
	rootPanel.style.top = Math.max(c.y + 4, Math.min(y, c.y + c.h - rh - 4)) + "px";
	root.addEventListener("mouseleave", () => {
		if (leaveTimer !== null) window.clearTimeout(leaveTimer);
		leaveTimer = window.setTimeout(() => {
			leaveTimer = null;
			close();
		}, 200);
	});
	root.addEventListener("mouseover", () => {
		if (leaveTimer !== null) {
			window.clearTimeout(leaveTimer);
			leaveTimer = null;
		}
	});
	const onDocPointerDown = (e) => {
		if (closed) return;
		if (root.contains(e.target)) return;
		close();
	};
	const onDocKeyDown = (e) => {
		if (closed) return;
		if (e.key === "Escape") close();
	};
	document.addEventListener("mousedown", onDocPointerDown, true);
	document.addEventListener("keydown", onDocKeyDown, true);
	const close = () => {
		if (closed) return;
		closed = true;
		if (leaveTimer !== null) window.clearTimeout(leaveTimer);
		leaveTimer = null;
		document.removeEventListener("mousedown", onDocPointerDown, true);
		document.removeEventListener("keydown", onDocKeyDown, true);
		root.remove();
		if (onClose) onClose();
	};
	return {
		el: root,
		close
	};
}

//#endregion
//#region src/shared/chat.ts
const SEND_TIMEOUT_MS = 6e4;
async function sendChat(baseUrl, text) {
	const res = await fetch(baseUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
		signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
	});
	const raw = await res.json().catch(() => null);
	if (!raw || typeof raw !== "object") throw new Error("dsh-pet: 对话响应非法");
	const o = raw;
	if (o.ok !== true) return {
		ok: false,
		reason: o.reason === "provider-missing" || o.reason === "generate-error" || o.reason === "config-error" ? o.reason : "bad-request",
		message: typeof o.message === "string" ? o.message : void 0
	};
	return { ok: true };
}
const CHAT_CSS = [
	".dsh-pet-chat{position:fixed;z-index:2147483001;width:160px;max-width:80vw;",
	"background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:10px;",
	"box-shadow:0 10px 32px rgba(0,0,0,.22);color:#2b2b2b;font-size:14px;line-height:1.5;",
	"font-family:var(--dsh-pet-font-family,'ShangshouSoftCandy','Yuanti SC','YouYuan','幼圆','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif);",
	"user-select:none}",
	".dsh-pet-chat *{box-sizing:border-box}",
	".dsh-pet-chat-input{display:block;width:100%;border:none;outline:none;background:transparent;",
	"padding:8px 11px 9px;font-size:14px;line-height:1.45;color:#2b2b2b;font-family:inherit;",
	"resize:none;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}",
	".dsh-pet-chat-input::placeholder{color:rgba(43,43,43,.45)}",
	".dsh-pet-chat-input:disabled{opacity:.55}",
	".dsh-pet-chat-err{color:#d94f3d;font-size:12px;padding:0 12px 8px;white-space:pre-wrap;overflow-wrap:anywhere}"
].join("");
/** 输入框宽度自适应参数：初始小宽 → 随文本增宽 → 封顶后折行增高 */
const CHAT_MIN_W = 160;
const CHAT_MAX_W = 340;
const CHAT_H_PAD = 22;
let chatCssInjected = false;
function injectChatCss() {
	if (chatCssInjected || typeof document === "undefined") return;
	chatCssInjected = true;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-pet";
	tag.dataset.pluginCss = "dsh-pet/chat";
	tag.textContent = CHAT_CSS;
	document.head.appendChild(tag);
}
function mountChatDialog(opts) {
	injectChatCss();
	const { petId, surface, x, y, onSent, onClose, clamp } = opts;
	const baseUrl = opts.baseUrl ?? "/dsh-pet-7340/chat";
	const withPet = baseUrl + "?pet=" + encodeURIComponent(petId) + "&surface=" + surface;
	const c = clamp && Number.isFinite(clamp.x + clamp.y + clamp.w + clamp.h) ? clamp : {
		x: 0,
		y: 0,
		w: window.innerWidth,
		h: window.innerHeight
	};
	const root = document.createElement("div");
	root.className = "dsh-pet-chat";
	const input = document.createElement("textarea");
	input.className = "dsh-pet-chat-input";
	input.placeholder = "说点什么…";
	input.maxLength = 2e3;
	input.rows = 1;
	let measureCtx = null;
	const measureText = (text) => {
		const ctx = measureCtx ?? (measureCtx = document.createElement("canvas").getContext("2d"));
		ctx.font = getComputedStyle(input).font;
		return ctx.measureText(text).width;
	};
	const resizeInput = () => {
		const textW = measureText(input.value || " ");
		const w = Math.max(CHAT_MIN_W, Math.min(Math.ceil(textW + CHAT_H_PAD), CHAT_MAX_W));
		root.style.width = w + "px";
		input.style.height = "auto";
		input.style.height = Math.max(input.scrollHeight, 22) + "px";
	};
	input.addEventListener("input", resizeInput);
	resizeInput();
	const err = document.createElement("div");
	err.className = "dsh-pet-chat-err";
	err.style.display = "none";
	root.appendChild(input);
	root.appendChild(err);
	document.body.appendChild(root);
	resizeInput();
	const rr = root.getBoundingClientRect();
	root.style.left = Math.max(c.x + 4, Math.min(x, c.x + c.w - rr.width - 4)) + "px";
	root.style.top = Math.max(c.y + 4, Math.min(y, c.y + c.h - rr.height - 4)) + "px";
	let closed = false;
	let sending = false;
	const close = () => {
		if (closed) return;
		closed = true;
		document.removeEventListener("mousedown", onDocPointerDown, true);
		document.removeEventListener("keydown", onDocKeyDown, true);
		root.remove();
		if (onClose) onClose();
	};
	const onDocPointerDown = (e) => {
		if (closed) return;
		if (root.contains(e.target)) return;
		close();
	};
	const onDocKeyDown = (e) => {
		if (closed) return;
		if (e.key === "Escape") close();
	};
	document.addEventListener("mousedown", onDocPointerDown, true);
	document.addEventListener("keydown", onDocKeyDown, true);
	const doSend = () => {
		if (closed || sending) return;
		const text = input.value.trim();
		if (!text) return;
		sending = true;
		input.disabled = true;
		sendChat(withPet, text).then((state) => {
			if (state.ok) {
				close();
				if (onSent) onSent();
			} else {
				err.textContent = "对话失败：" + (state.message ?? state.reason);
				err.style.display = "block";
			}
		}).catch((e) => {
			err.textContent = "对话异常：" + String(e && e.message ? e.message : e);
			err.style.display = "block";
		}).finally(() => {
			sending = false;
			input.disabled = false;
			if (!closed) input.focus();
		});
	};
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			doSend();
		}
	});
	input.focus();
	return {
		el: root,
		close
	};
}

//#endregion
//#region src/shared/physics.ts
const SPRING_K = 200;
const SPRING_C = 30;
const TRAIL_KEEP_MS = 200;
const RELEASE_WINDOW_MS = 150;
const RELEASE_STALE_MS = 150;
const MIN_SPAN_MS = 20;
const SEG_MIN_DT_MS = 8;
const DEAD_ZONE_SPEED = 500;
const MAX_THROW_SPEED = 3600;
const PEAK_WEIGHT = .5;
const ACCEL_REF = 8e3;
const ACCEL_GAIN_MAX = .6;
const GRAVITY = 1400;
const RESTITUTION = .78;
const GROUND_FRICTION = 2.5;
const DEFAULT_PHYSICS = {
	gravity: GRAVITY,
	restitution: RESTITUTION,
	groundFriction: GROUND_FRICTION,
	ceilingBounce: true,
	throwPower: 1,
	petCollision: false
};
const DEFAULT_THROW_POWER = 1;
const REST_VY = 40;
const REST_VX = 15;
const MAX_STEP_DT = .05;
const SQ_SQUASH = .55;
const SQ_DURATION_MS = 220;
const SQ_SOFT_SPEED = 300;
const SQ_HARD_SPEED = 1500;
const SQ_MAX_SQUASH = .55;
const landingSquash = (impactSpeed) => {
	const t = Math.min(Math.max((Math.abs(impactSpeed) - SQ_SOFT_SPEED) / (SQ_HARD_SPEED - SQ_SOFT_SPEED), 0), 1);
	return Math.min(.8, 1 - t * (1 - SQ_MAX_SQUASH));
};
const squashScale = (u, squash = SQ_SQUASH) => {
	if (u < .45) {
		const p$1 = u / .45;
		return 1 - (1 - squash) * p$1 * p$1;
	}
	const p = (u - .45) / .55;
	const c1 = 1.70158;
	const c3 = c1 + 1;
	const f = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
	return Math.min(1.12, squash + (1 - squash) * Math.max(f, 0));
};
const throwBounds = (o) => {
	const h = o.size * 9 / 16;
	return {
		minX: -o.sideAllow,
		minY: 0,
		maxX: o.W - o.size + o.sideAllow,
		maxY: o.H - h
	};
};
const throwBoundsIn = (area, size, sideAllow) => {
	const h = size * 9 / 16;
	return {
		minX: area.x - sideAllow,
		minY: area.y,
		maxX: rectRight(area) - size + sideAllow,
		maxY: rectBottom(area) - h
	};
};
const throwSpace = (o) => ({
	bounds: o.areas.map((a) => throwBoundsIn(a, o.size, o.sideAllow)),
	areas: o.areas,
	panels: o.panels && o.panels.length === o.areas.length ? o.panels : o.areas,
	size: o.size,
	sideAllow: o.sideAllow
});
const screenOfBox = (space, x, y) => {
	const cx = x + space.size / 2;
	const cy = y + space.size * 9 / 16 / 2;
	const hit = indexAtPoint(space.areas, cx, cy);
	return hit >= 0 ? hit : nearestIndex(space.areas, cx, cy);
};
const trimTrail = (trail, now) => {
	const cutoff = now - TRAIL_KEEP_MS;
	let i = 0;
	while (i < trail.length && trail[i].t < cutoff) i++;
	return i === 0 ? trail : trail.slice(i);
};
const springStep = (v, x, target, dt, power = DEFAULT_THROW_POWER) => v + ((target - x) * SPRING_K - v * SPRING_C) * power * dt;
const softClampSpeed = (speed) => {
	if (speed <= 0) return 0;
	return MAX_THROW_SPEED * (1 - Math.exp(-speed / MAX_THROW_SPEED));
};
const THROW_SPEED_ANCHOR = 1200;
const throwVelocity = (angleDeg, power) => {
	const speed = softClampSpeed(power * THROW_SPEED_ANCHOR);
	const rad = angleDeg * Math.PI / 180;
	return {
		vx: Math.cos(rad) * speed,
		vy: -Math.sin(rad) * speed
	};
};
const SLINGSHOT_REF_RATIO = .6;
const slingshotRefDist = (size) => size > 0 ? size * SLINGSHOT_REF_RATIO : 0;
const slingshotPower = (dist, size) => {
	const ref = slingshotRefDist(size);
	if (!(ref > 0) || !(dist > 0) || !Number.isFinite(dist)) return 0;
	return dist / ref;
};
const pullAngle = (pullX, pullY) => Math.atan2(pullY, -pullX) * 180 / Math.PI;
const slingshotVelocity = (angleDeg, power, throwPower = DEFAULT_THROW_POWER) => {
	const speed = THROW_SPEED_ANCHOR * Math.max(0, power) * Math.max(0, throwPower);
	if (speed === 0) return {
		vx: 0,
		vy: 0
	};
	const rad = angleDeg * Math.PI / 180;
	return {
		vx: Math.cos(rad) * speed,
		vy: -Math.sin(rad) * speed
	};
};
const estimateReleaseVelocity = (trail, now, physics = DEFAULT_PHYSICS) => {
	if (trail.length === 0) return null;
	const last = trail[trail.length - 1];
	if (now - last.t > RELEASE_STALE_MS) return null;
	const win = trail.filter((s) => now - s.t <= RELEASE_WINDOW_MS);
	if (win.length < 2) return null;
	const t0 = win[0].t;
	const x0 = win[0].x;
	const y0 = win[0].y;
	const t1 = win[win.length - 1].t;
	const x1 = win[win.length - 1].x;
	const y1 = win[win.length - 1].y;
	const spanMs = t1 - t0;
	if (spanMs < MIN_SPAN_MS) return null;
	const baseVx = (x1 - x0) / spanMs * 1e3;
	const baseVy = (y1 - y0) / spanMs * 1e3;
	const baseSpeed = Math.hypot(baseVx, baseVy);
	if (baseSpeed < 1e-6) return null;
	const segSpeeds = [];
	let px = x0;
	let py = y0;
	let pt = t0;
	for (const s of win.slice(1)) {
		const dt = s.t - pt;
		if (dt >= SEG_MIN_DT_MS) {
			segSpeeds.push({
				speed: Math.hypot(s.x - px, s.y - py) / dt * 1e3,
				tEnd: s.t
			});
			px = s.x;
			py = s.y;
			pt = s.t;
		}
	}
	const peakSpeed = segSpeeds.length ? Math.max(...segSpeeds.map((v) => v.speed)) : baseSpeed;
	let accel = 0;
	if (segSpeeds.length >= 2) {
		const lastSeg = segSpeeds[segSpeeds.length - 1];
		const firstSeg = segSpeeds[0];
		accel = (lastSeg.speed - firstSeg.speed) / Math.max((lastSeg.tEnd - firstSeg.tEnd) / 1e3, MIN_SPAN_MS / 1e3);
	}
	const speedBeforeClamp = ((1 - PEAK_WEIGHT) * baseSpeed + PEAK_WEIGHT * peakSpeed) * (1 + Math.min(Math.max(accel, 0) / ACCEL_REF, 1) * ACCEL_GAIN_MAX);
	const speed = softClampSpeed(speedBeforeClamp) * physics.throwPower;
	if (speed < DEAD_ZONE_SPEED) return null;
	return {
		vx: baseVx / baseSpeed * speed,
		vy: baseVy / baseSpeed * speed
	};
};
const throwStep = (s, dtRaw, b, physics = DEFAULT_PHYSICS) => {
	const dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT);
	let { x, y, vx, vy } = s;
	vy += physics.gravity * dt;
	x += vx * dt;
	y += vy * dt;
	let bounced = false;
	if (x < b.minX) {
		x = b.minX;
		vx = Math.abs(vx) * physics.restitution;
		bounced = true;
	} else if (x > b.maxX) {
		x = b.maxX;
		vx = -Math.abs(vx) * physics.restitution;
		bounced = true;
	}
	if (y < b.minY) {
		if (physics.ceilingBounce) {
			y = b.minY;
			vy = Math.abs(vy) * physics.restitution;
			bounced = true;
		}
	} else if (y >= b.maxY) {
		y = b.maxY;
		vx *= Math.max(0, 1 - physics.groundFriction * dt);
		if (Math.abs(vy) < REST_VY) vy = 0;
		else vy = -Math.abs(vy) * physics.restitution;
		bounced = true;
	}
	const speed = Math.hypot(vx, vy);
	const atRest = y >= b.maxY - 1 && Math.abs(vy) < 1 && Math.abs(vx) < REST_VX || bounced && speed < REST_VY && Math.abs(vy) < 1;
	return {
		x,
		y,
		vx,
		vy,
		bounced,
		atRest
	};
};
const throwStepRegion = (s, dtRaw, space, physics = DEFAULT_PHYSICS, lockScreen = -1) => {
	const dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT);
	let { x, y, vx, vy } = s;
	vy += physics.gravity * dt;
	x += vx * dt;
	y += vy * dt;
	if (space.areas.length === 0) return {
		x,
		y,
		vx,
		vy,
		screen: -1,
		bounced: false,
		atRest: false
	};
	const h = space.size * 9 / 16;
	let bounced = false;
	const locked = Number.isInteger(lockScreen) && lockScreen >= 0 && lockScreen < space.areas.length;
	/** 该用哪块屏的 AABB / 工作区 / 面板：锁定时恒为锁定屏，否则取身体中心所在屏 */
	const pick$1 = (i) => locked ? lockScreen : i;
	let cur = screenOfBox(space, x, y);
	let b = space.bounds[pick$1(cur)];
	let a = space.areas[pick$1(cur)];
	const pa = space.panels[pick$1(cur)] || a;
	const cy = y + h / 2;
	if (x < b.minX) {
		if (locked || indexAtPoint(space.panels, pa.x - 1, cy) < 0) {
			x = b.minX;
			vx = Math.abs(vx) * physics.restitution;
			bounced = true;
		}
	} else if (x > b.maxX) {
		if (locked || indexAtPoint(space.panels, rectRight(pa), cy) < 0) {
			x = b.maxX;
			vx = -Math.abs(vx) * physics.restitution;
			bounced = true;
		}
	}
	cur = screenOfBox(space, x, y);
	b = space.bounds[pick$1(cur)];
	a = space.areas[pick$1(cur)];
	const pa2 = space.panels[pick$1(cur)] || a;
	const cx = x + space.size / 2;
	if (y < b.minY) {
		if (physics.ceilingBounce && (locked || indexAtPoint(space.panels, cx, pa2.y - 1) < 0)) {
			y = b.minY;
			vy = Math.abs(vy) * physics.restitution;
			bounced = true;
		}
	} else if (y >= b.maxY) {
		if (locked || indexAtPoint(space.panels, cx, rectBottom(pa2)) < 0) {
			y = b.maxY;
			vx *= Math.max(0, 1 - physics.groundFriction * dt);
			if (Math.abs(vy) < REST_VY) vy = 0;
			else vy = -Math.abs(vy) * physics.restitution;
			bounced = true;
		}
	}
	cur = pick$1(screenOfBox(space, x, y));
	b = space.bounds[cur];
	const speed = Math.hypot(vx, vy);
	const atRest = y >= b.maxY - 1 && Math.abs(vy) < 1 && Math.abs(vx) < REST_VX || bounced && speed < REST_VY && Math.abs(vy) < 1;
	return {
		x,
		y,
		vx,
		vy,
		screen: cur,
		bounced,
		atRest
	};
};
const SUBSTEP_PX = 8;
const SUBSTEP_MAX = 64;
const throwSubsteps = (vx, vy, dt) => {
	const travel = Math.hypot(vx, vy) * Math.min(Math.max(dt, 0), MAX_STEP_DT);
	if (!(travel > SUBSTEP_PX)) return 1;
	return Math.min(SUBSTEP_MAX, Math.ceil(travel / SUBSTEP_PX));
};
const PET_BOUNCE_E = .995;
const bodyPixelBox = (o) => {
	const h = o.size * 9 / 16;
	return {
		left: o.x + HIT_BOX.x0 / 640 * o.size,
		top: o.y + o.bottomPad + HIT_BOX.y0 / 360 * h,
		right: o.x + HIT_BOX.x1 / 640 * o.size,
		bottom: o.y + o.bottomPad + HIT_BOX.y1 / 360 * h
	};
};
const rectsOverlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const collidePet = (fly, hit) => {
	const hf = fly.size * 9 / 16 / 2;
	const hh = hit.size * 9 / 16 / 2;
	const cx = hit.x + hit.size / 2 - (fly.x + fly.size / 2);
	const cy = hit.y + hh - (fly.y + hf);
	const dist = Math.hypot(cx, cy);
	if (dist < 1e-6) return null;
	const nx = cx / dist;
	const ny = cy / dist;
	const vrel = (fly.vx - hit.vx) * nx + (fly.vy - hit.vy) * ny;
	if (vrel <= 0) return null;
	const e = PET_BOUNCE_E;
	const m1 = fly.size * fly.size;
	const m2 = hit.size * hit.size;
	const v1n = fly.vx * nx + fly.vy * ny;
	const v2n = hit.vx * nx + hit.vy * ny;
	const v1n2 = ((m1 - e * m2) * v1n + (1 + e) * m2 * v2n) / (m1 + m2);
	const v2n2 = ((m2 - e * m1) * v2n + (1 + e) * m1 * v1n) / (m1 + m2);
	return {
		fvx: fly.vx - v1n * nx + v1n2 * nx,
		fvy: fly.vy - v1n * ny + v1n2 * ny,
		hvx: hit.vx - v2n * nx + v2n2 * nx,
		hvy: hit.vy - v2n * ny + v2n2 * ny
	};
};

//#endregion
//#region src/shared/score.ts
const SCORE_MIN_SPEED = 400;
/** 每 100 px/s 记 1 分（基准尺寸 462px 下） */
const SCORE_SPEED_PER_POINT = 100;
const clickScore = (speed, size) => {
	if (speed <= 0 || size <= 0) return 0;
	return Math.max(1, Math.round(speed / SCORE_SPEED_PER_POINT * (PET_REF_WIDTH / size)));
};

//#endregion
//#region src/shared/score-popup.ts
const SCORE_POPUP_DURATION_MS = 2200;
const SCORE_POPUP_CSS = [
	".dsh-pet-score{position:fixed;z-index:2147483002;min-width:120px;text-align:center;",
	"background:rgba(255,255,255,.97);border:1px solid rgba(255,179,0,.35);border-radius:12px;",
	"box-shadow:0 10px 32px rgba(0,0,0,.22);padding:8px 16px 9px;user-select:none;pointer-events:auto;",
	"font-family:var(--dsh-pet-font-family,'ShangshouSoftCandy','Yuanti SC','YouYuan','幼圆','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif);}",
	".dsh-pet-score.is-in{animation:dshPetScorePop .28s ease}",
	".dsh-pet-score-val{font-size:22px;line-height:1.25;font-weight:700;color:#ff8f00;font-variant-numeric:tabular-nums}",
	".dsh-pet-score-sub{font-size:11px;line-height:1.4;color:rgba(43,43,43,.6);margin-top:2px;white-space:nowrap}",
	".dsh-pet-score-burst{position:fixed;inset:0;pointer-events:none;z-index:2147483002}",
	".dsh-pet-score-particle{position:absolute;border-radius:50%;pointer-events:none}",
	"@keyframes dshPetScorePop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}"
].join("");
/** 粒子只注入一次（同 CHAT_CSS 的 injectChatCss 模式） */
let scoreCssInjected = false;
function injectScoreCss() {
	if (scoreCssInjected || typeof document === "undefined") return;
	scoreCssInjected = true;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-pet";
	tag.dataset.pluginCss = "dsh-pet/score";
	tag.textContent = SCORE_POPUP_CSS;
	document.head.appendChild(tag);
}
/** 粒子数量 */
const BURST_COUNT = 20;
/** 初速范围（px/s） */
const BURST_SPEED_MIN = 120;
const BURST_SPEED_MAX = 460;
/** 重力（px/s²）：粒子向上喷出后回落 */
const BURST_GRAVITY = 700;
/** 单粒子寿命范围（ms） */
const BURST_LIFE_MIN = 500;
const BURST_LIFE_MAX = 900;
/** 粒子半径范围（px） */
const BURST_RADIUS_MIN = 3;
const BURST_RADIUS_MAX = 7;
/** 暖色盘（积分/庆祝感） */
const BURST_COLORS = [
	"#ffb300",
	"#ff8f00",
	"#ff7043",
	"#f4511e",
	"#ffc400",
	"#ffd54f",
	"#ef5350"
];
function spawnScoreBurst(x, y) {
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	injectScoreCss();
	const root = document.createElement("div");
	root.className = "dsh-pet-score-burst";
	document.body.appendChild(root);
	const parts = [];
	for (let i = 0; i < BURST_COUNT; i++) {
		const angle = Math.random() * Math.PI * 2;
		const speed = BURST_SPEED_MIN + Math.random() * (BURST_SPEED_MAX - BURST_SPEED_MIN);
		const r = BURST_RADIUS_MIN + Math.random() * (BURST_RADIUS_MAX - BURST_RADIUS_MIN);
		const el = document.createElement("div");
		el.className = "dsh-pet-score-particle";
		el.style.left = x + "px";
		el.style.top = y + "px";
		el.style.width = r * 2 + "px";
		el.style.height = r * 2 + "px";
		el.style.background = BURST_COLORS[Math.floor(Math.random() * BURST_COLORS.length)];
		root.appendChild(el);
		parts.push({
			el,
			vx: Math.cos(angle) * speed,
			vy: Math.sin(angle) * speed - 80,
			t0: performance.now(),
			life: BURST_LIFE_MIN + Math.random() * (BURST_LIFE_MAX - BURST_LIFE_MIN)
		});
	}
	const step = () => {
		const now = performance.now();
		let alive = false;
		for (const p of parts) {
			const tSec = (now - p.t0) / 1e3;
			const lifeRatio = (now - p.t0) / p.life;
			if (lifeRatio >= 1) continue;
			alive = true;
			p.el.style.transform = "translate(" + p.vx * tSec + "px," + (p.vy * tSec + .5 * BURST_GRAVITY * tSec * tSec) + "px)";
			p.el.style.opacity = String(Math.max(0, 1 - lifeRatio));
		}
		if (alive) requestAnimationFrame(step);
		else root.remove();
	};
	requestAnimationFrame(step);
}
function mountScorePopup(opts) {
	injectScoreCss();
	const x = opts.x;
	const y = opts.y;
	const root = document.createElement("div");
	root.className = "dsh-pet-score";
	const val = document.createElement("div");
	val.className = "dsh-pet-score-val";
	val.textContent = "+" + opts.score;
	const sub = document.createElement("div");
	sub.className = "dsh-pet-score-sub";
	sub.textContent = "速度 " + Math.round(opts.speed) + " · 大小 " + Math.round(opts.size);
	root.appendChild(val);
	root.appendChild(sub);
	document.body.appendChild(root);
	const rr = root.getBoundingClientRect();
	root.style.left = Math.max(4, Math.min(x - rr.width / 2, window.innerWidth - rr.width - 4)) + "px";
	root.style.top = Math.max(4, y - rr.height - 14) + "px";
	root.offsetWidth;
	root.classList.add("is-in");
	let closed = false;
	let timer = null;
	const close = () => {
		if (closed) return;
		closed = true;
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
		document.removeEventListener("mousedown", onDocPointerDown, true);
		document.removeEventListener("keydown", onDocKeyDown, true);
		root.remove();
		if (opts.onClose) opts.onClose();
	};
	const mountedAt = performance.now();
	let graceConsumed = false;
	const onDocPointerDown = (e) => {
		if (closed) return;
		if (!graceConsumed) {
			graceConsumed = true;
			if (e.timeStamp - mountedAt < 300) return;
		}
		if (root.contains(e.target)) return;
		close();
	};
	const onDocKeyDown = (e) => {
		if (closed) return;
		if (e.key === "Escape") close();
	};
	document.addEventListener("mousedown", onDocPointerDown, true);
	document.addEventListener("keydown", onDocKeyDown, true);
	timer = window.setTimeout(close, SCORE_POPUP_DURATION_MS);
	return {
		el: root,
		close
	};
}

//#endregion
//#region src/shared/work-status.ts
const WORK_STATUS_STATES = [
	"thinking",
	"working",
	"result",
	"waiting",
	"success",
	"error"
];
const WORK_STATUS_INDEX = {
	thinking: 0,
	working: 1,
	result: 2,
	waiting: 3,
	success: 4,
	error: 5
};
function toWorkStatus(raw) {
	if (!raw || typeof raw !== "object") return null;
	const r = raw;
	const state = r.state === null || typeof r.state === "string" && WORK_STATUS_STATES.includes(r.state) ? r.state : null;
	return {
		state,
		task: typeof r.task === "string" ? r.task : null
	};
}

//#endregion
//#region src/shared/state.ts
/** 叶子规范化：形状不对（非对象 / counter 非数字）→ null（丢弃，不让脏数据进渲染层） */
function normLeaf(value) {
	if (!value || typeof value !== "object") return null;
	const leaf$1 = value;
	if (typeof leaf$1.counter !== "number" || !Number.isFinite(leaf$1.counter)) return null;
	return {
		counter: leaf$1.counter,
		data: leaf$1.data ?? null
	};
}
async function fetchState(baseUrl = "/dsh-pet-7340/state", wait) {
	try {
		const url = wait ? `${baseUrl}?since=${wait.since}&timeout=${wait.timeoutMs}` : baseUrl;
		const res = await fetch(url, { cache: "no-store" });
		if (!res.ok) return null;
		const raw = await res.json().catch(() => null);
		if (!raw || typeof raw !== "object") return null;
		const sections = {};
		const rawSections = raw.sections && typeof raw.sections === "object" ? raw.sections : {};
		for (const [name, value] of Object.entries(rawSections)) {
			const leaf$1 = normLeaf(value);
			if (leaf$1) sections[name] = leaf$1;
		}
		const pets = {};
		const rawPets = raw.pets && typeof raw.pets === "object" ? raw.pets : {};
		for (const [petId, entry] of Object.entries(rawPets)) {
			if (!entry || typeof entry !== "object") continue;
			const leaves = {};
			for (const [name, value] of Object.entries(entry)) {
				const leaf$1 = normLeaf(value);
				if (leaf$1) leaves[name] = leaf$1;
			}
			pets[petId] = leaves;
		}
		return {
			counter: typeof raw.counter === "number" && Number.isFinite(raw.counter) ? raw.counter : void 0,
			sections,
			pets
		};
	} catch {
		return null;
	}
}
/** 遍历 S 的所有叶子（顺序：sections 在前、pets 在后） */
function* walkLeaves(s) {
	for (const [name, leaf$1] of Object.entries(s.sections ?? {})) yield ["sections." + name, leaf$1];
	for (const [petId, leaves] of Object.entries(s.pets ?? {})) for (const [name, leaf$1] of Object.entries(leaves ?? {})) yield ["pets." + petId + "." + name, leaf$1];
}
function flattenCounters(s) {
	const out = {};
	for (const [path, leaf$1] of walkLeaves(s)) out[path] = leaf$1.counter;
	return out;
}
function takeChanged(s, baseline) {
	const out = [];
	for (const [path, leaf$1] of walkLeaves(s)) {
		if (baseline[path] === leaf$1.counter) continue;
		baseline[path] = leaf$1.counter;
		out.push({
			path,
			leaf: leaf$1
		});
	}
	return out;
}
function readBalance(leaf$1) {
	const state = toBalanceState(leaf$1.data);
	if (!state) return null;
	const manual = leaf$1.data.manual === true;
	return {
		state,
		manual
	};
}
function readSay(leaf$1) {
	if (!leaf$1.data || typeof leaf$1.data !== "object") return null;
	const d = leaf$1.data;
	if (d.clear === true) return { kind: "clear" };
	if (typeof d.text !== "string" || !d.text) return null;
	return {
		kind: "say",
		text: d.text,
		image: typeof d.image === "string" ? d.image : void 0,
		url: typeof d.url === "string" ? d.url : void 0,
		duration: typeof d.duration === "number" && Number.isFinite(d.duration) && d.duration >= 0 ? d.duration : void 0,
		anim: typeof d.anim === "boolean" ? d.anim : void 0
	};
}
function readWorkStatus(leaf$1) {
	return toWorkStatus(leaf$1.data);
}
function readAnim(leaf$1) {
	if (!leaf$1.data || typeof leaf$1.data !== "object") return null;
	const d = leaf$1.data;
	const name = typeof d.name === "string" && d.name ? d.name : void 0;
	const url = typeof d.url === "string" && d.url ? d.url : void 0;
	if (name === void 0 && url === void 0) return null;
	return {
		name,
		url,
		playbackId: typeof d.playbackId === "string" && d.playbackId ? d.playbackId : void 0,
		facing: d.facing === "left" || d.facing === "right" ? d.facing : void 0
	};
}
function readLock(leaf$1) {
	if (!leaf$1.data || typeof leaf$1.data !== "object") return null;
	const d = leaf$1.data;
	if (d.locked === false) return { locked: false };
	if (d.locked !== true) return null;
	if (typeof d.expiresAt !== "number" || !Number.isFinite(d.expiresAt)) return null;
	return {
		locked: true,
		expiresAt: d.expiresAt
	};
}
function readPosition(leaf$1) {
	if (!leaf$1.data || typeof leaf$1.data !== "object") return null;
	const d = leaf$1.data;
	if (typeof d.x !== "number" || !Number.isFinite(d.x)) return null;
	if (typeof d.y !== "number" || !Number.isFinite(d.y)) return null;
	if (d.mode !== "instant" && d.mode !== "spring" && d.mode !== "line") return null;
	if (d.mode === "line") {
		if (typeof d.duration !== "number" || !Number.isFinite(d.duration) || d.duration < 0) return null;
		return {
			x: d.x,
			y: d.y,
			mode: "line",
			duration: d.duration
		};
	}
	return {
		x: d.x,
		y: d.y,
		mode: d.mode,
		duration: 0
	};
}
function readThrow(leaf$1) {
	if (!leaf$1.data || typeof leaf$1.data !== "object") return null;
	const d = leaf$1.data;
	if (typeof d.angle !== "number" || !Number.isFinite(d.angle)) return null;
	if (typeof d.power !== "number" || !Number.isFinite(d.power) || d.power <= 0) return null;
	return {
		angle: d.angle,
		power: d.power
	};
}
async function postAction(baseUrl, body) {
	try {
		const res = await fetch(baseUrl, {
			method: "POST",
			...body === void 0 ? {} : {
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			}
		});
		if (!res.ok) return false;
		const data = await res.json().catch(() => null);
		return data?.ok === true;
	} catch {
		return false;
	}
}

//#endregion
//#region src/shared/tooltip.ts
const TOOLTIP_CLASS = "pet-tooltip";
const TOOLTIP_GAP_RATIO = .022;
function tooltipPlacement(cursor, tip, bounds, gap) {
	const clamp = (v, lo, hi) => hi < lo ? lo : Math.min(Math.max(v, lo), hi);
	const rightMax = bounds.x + bounds.w;
	const bottomMax = bounds.y + bounds.h;
	let x = cursor.x + gap;
	if (x + tip.w > rightMax) x = cursor.x - gap - tip.w;
	x = clamp(x, bounds.x, rightMax - tip.w);
	let y = cursor.y + gap;
	if (y + tip.h > bottomMax) y = cursor.y - gap - tip.h;
	y = clamp(y, bounds.y, bottomMax - tip.h);
	return {
		x,
		y
	};
}
const TOOLTIP_CSS = [
	".pet-tooltip{",
	"position:fixed;left:0;top:0;",
	"max-width:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.8);",
	"padding:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.010) calc(var(--dsh-pet-size,var(--pet-size,462px))*0.021);",
	"border-radius:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.016);",
	"background:rgba(255,255,255,.96);color:#1f1f1f;",
	"border:1px solid rgba(0,0,0,.12);",
	"font-family:var(--dsh-pet-font-family,\"ShangshouSoftCandy\",\"Yuanti SC\",\"YouYuan\",\"幼圆\",\"Comic Sans MS\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif);",
	"font-size:var(--dsh-pet-font-tip,calc(var(--dsh-pet-size,var(--pet-size,462px))*0.026));line-height:1.4;",
	"white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
	"box-shadow:0 calc(var(--dsh-pet-size,var(--pet-size,462px))*0.004) calc(var(--dsh-pet-size,var(--pet-size,462px))*0.013) rgba(0,0,0,.18);",
	"opacity:0;transition:opacity .12s ease;pointer-events:none;z-index:2}",
	".pet-tooltip.is-on{opacity:1}"
].join("");

//#endregion
exports.ACCEL_GAIN_MAX = ACCEL_GAIN_MAX
exports.ACCEL_REF = ACCEL_REF
exports.ANIMATION_EXT = ANIMATION_EXT
exports.BUBBLE_FONT_BASE_PX = BUBBLE_FONT_BASE_PX
exports.BUBBLE_METRICS = BUBBLE_METRICS
exports.BUBBLE_OVERLAP_RATIO = BUBBLE_OVERLAP_RATIO
exports.CANVAS_H = CANVAS_H
exports.CHAT_CSS = CHAT_CSS
exports.DEAD_ZONE_SPEED = DEAD_ZONE_SPEED
exports.DEFAULT_FONT = DEFAULT_FONT
exports.DEFAULT_PHYSICS = DEFAULT_PHYSICS
exports.DEFAULT_ROLLING_LABEL = DEFAULT_ROLLING_LABEL
exports.DEFAULT_THROW_POWER = DEFAULT_THROW_POWER
exports.DRAG_THRESHOLD = DRAG_THRESHOLD
exports.FEET_Y = FEET_Y
exports.FONT_PRESETS = FONT_PRESETS
exports.FONT_REF_SIZE = FONT_REF_SIZE
exports.FONT_SIZE_MAX = FONT_SIZE_MAX
exports.FONT_SIZE_MIN = FONT_SIZE_MIN
exports.GRAVITY = GRAVITY
exports.GROUND_FRICTION = GROUND_FRICTION
exports.HANDLERS = HANDLERS
exports.HIT_BOX = HIT_BOX
exports.MAX_BODY = MAX_BODY
exports.MAX_STEP_DT = MAX_STEP_DT
exports.MAX_THROW_SPEED = MAX_THROW_SPEED
exports.MEME_BUBBLE_CLASS = MEME_BUBBLE_CLASS
exports.MEME_BUBBLE_CSS = MEME_BUBBLE_CSS
exports.MEME_IMG_CLASS = MEME_IMG_CLASS
exports.MENU_CSS = MENU_CSS
exports.MIN_SPAN_MS = MIN_SPAN_MS
exports.MORE_MENU_LABEL = MORE_MENU_LABEL
exports.NOTIFY_ICONS = NOTIFY_ICONS
exports.PEAK_WEIGHT = PEAK_WEIGHT
exports.PET_BOUNCE_E = PET_BOUNCE_E
exports.PET_DISPLAYS = PET_DISPLAYS
exports.PET_REF_WIDTH = PET_REF_WIDTH
exports.QUOTA_CRIT_PERCENT = QUOTA_CRIT_PERCENT
exports.QUOTA_WARN_PERCENT = QUOTA_WARN_PERCENT
exports.RELEASE_STALE_MS = RELEASE_STALE_MS
exports.RELEASE_WINDOW_MS = RELEASE_WINDOW_MS
exports.RESTITUTION = RESTITUTION
exports.REST_VX = REST_VX
exports.REST_VY = REST_VY
exports.SCORE_MIN_SPEED = SCORE_MIN_SPEED
exports.SCORE_POPUP_CSS = SCORE_POPUP_CSS
exports.SCORE_POPUP_DURATION_MS = SCORE_POPUP_DURATION_MS
exports.SEG_MIN_DT_MS = SEG_MIN_DT_MS
exports.SLINGSHOT_DOUBLE_MS = SLINGSHOT_DOUBLE_MS
exports.SLINGSHOT_REF_RATIO = SLINGSHOT_REF_RATIO
exports.SPRING_C = SPRING_C
exports.SPRING_K = SPRING_K
exports.SQ_DURATION_MS = SQ_DURATION_MS
exports.SQ_HARD_SPEED = SQ_HARD_SPEED
exports.SQ_MAX_SQUASH = SQ_MAX_SQUASH
exports.SQ_SOFT_SPEED = SQ_SOFT_SPEED
exports.SQ_SQUASH = SQ_SQUASH
exports.SUBSTEP_MAX = SUBSTEP_MAX
exports.SUBSTEP_PX = SUBSTEP_PX
exports.THROW_SPEED_ANCHOR = THROW_SPEED_ANCHOR
exports.TIP_FONT_BASE_PX = TIP_FONT_BASE_PX
exports.TOOLTIP_CLASS = TOOLTIP_CLASS
exports.TOOLTIP_CSS = TOOLTIP_CSS
exports.TOOLTIP_GAP_RATIO = TOOLTIP_GAP_RATIO
exports.TRAIL_KEEP_MS = TRAIL_KEEP_MS
exports.WINDOW_LABELS = WINDOW_LABELS
exports.WORK_STATUS_INDEX = WORK_STATUS_INDEX
exports.WORK_STATUS_STATES = WORK_STATUS_STATES
exports.anchorPixel = anchorPixel
exports.balanceBubbleView = balanceBubbleView
exports.balanceDetailView = balanceDetailView
exports.balanceEventIndex = balanceEventIndex
exports.balancePercent = balancePercent
exports.bodyPixelBox = bodyPixelBox
exports.boundingRect = boundingRect
exports.bubbleMaxHeightPx = bubbleMaxHeightPx
exports.bubbleTopMarginPx = bubbleTopMarginPx
exports.buildMenuTree = buildMenuTree
exports.buildMoreBranch = buildMoreBranch
exports.clampPointInRect = clampPointInRect
exports.clampPointToRegion = clampPointToRegion
exports.clickScore = clickScore
exports.collidePet = collidePet
exports.createMemeImage = createMemeImage
exports.createMemeImageFromUrl = createMemeImageFromUrl
exports.decideBalanceNotice = decideBalanceNotice
exports.displayMenuBranch = displayMenuBranch
exports.distToRectSq = distToRectSq
exports.estimateReleaseVelocity = estimateReleaseVelocity
exports.fetchState = fetchState
exports.flattenConfigPets = flattenConfigPets
exports.flattenCounters = flattenCounters
exports.fontStackOf = fontStackOf
exports.frameToToast = frameToToast
exports.indexAtPoint = indexAtPoint
exports.injectMemeBubbleCss = injectMemeBubbleCss
exports.isDesktopVisible = isDesktopVisible
exports.isEventAnim = isEventAnim
exports.isNoMirrorAnimation = isNoMirrorAnimation
exports.isWebVisible = isWebVisible
exports.landingSquash = landingSquash
exports.memeImageUrl = memeImageUrl
exports.mountChatDialog = mountChatDialog
exports.mountContextMenu = mountContextMenu
exports.mountScorePopup = mountScorePopup
exports.nearestIndex = nearestIndex
exports.nextWorkStatusAnim = nextWorkStatusAnim
exports.pick = pick
exports.pickCategoryAction = pickCategoryAction
exports.pickSlot = pickSlot
exports.pickWeightedCategory = pickWeightedCategory
exports.planMove = planMove
exports.pointInRect = pointInRect
exports.poolIncludes = poolIncludes
exports.postAction = postAction
exports.pullAngle = pullAngle
exports.quotaTone = quotaTone
exports.randomBetween = randomBetween
exports.readAnim = readAnim
exports.readBalance = readBalance
exports.readLock = readLock
exports.readMenuItems = readMenuItems
exports.readPosition = readPosition
exports.readSay = readSay
exports.readThrow = readThrow
exports.readWorkStatus = readWorkStatus
exports.rectAtPoint = rectAtPoint
exports.rectBottom = rectBottom
exports.rectRight = rectRight
exports.rectsOverlap = rectsOverlap
exports.regionArea = regionArea
exports.regionHoleRatio = regionHoleRatio
exports.resetInText = resetInText
exports.resolveFontPx = resolveFontPx
exports.resolveRect = resolveRect
exports.rollKind = rollKind
exports.screenOfBox = screenOfBox
exports.sendChat = sendChat
exports.slingshotPower = slingshotPower
exports.slingshotRefDist = slingshotRefDist
exports.slingshotVelocity = slingshotVelocity
exports.slotIncludes = slotIncludes
exports.softClampSpeed = softClampSpeed
exports.spawnScoreBurst = spawnScoreBurst
exports.springStep = springStep
exports.squashScale = squashScale
exports.takeChanged = takeChanged
exports.throwBounds = throwBounds
exports.throwBoundsIn = throwBoundsIn
exports.throwSpace = throwSpace
exports.throwStep = throwStep
exports.throwStepRegion = throwStepRegion
exports.throwSubsteps = throwSubsteps
exports.throwVelocity = throwVelocity
exports.toBalanceState = toBalanceState
exports.toWorkStatus = toWorkStatus
exports.tooltipPlacement = tooltipPlacement
exports.translateRects = translateRects
exports.trimTrail = trimTrail
exports.truncate = truncate
exports.urgentWindow = urgentWindow
exports.whisperBubbleView = whisperBubbleView
exports.windowsHandler = windowsHandler
return exports;
})({});