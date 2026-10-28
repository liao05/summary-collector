// ============================================================================
// 摘要收集器 —— 大总结独立 API 请求层(v0.4.0)
// ----------------------------------------------------------------------------
// 两种模式:
//   current —— 随主插件:官方 generateQuietPrompt,跟随酒馆当前激活的 API 连接
//   custom  —— 自定义API:在插件内自行填写 端点 + API 密钥 + 模型,请求与模型列表
//              均经酒馆后端转发(ChatCompletionService / /api/backends/chat-completions
//              的官方路由,custom 源),无浏览器 CORS 问题,密钥以显式
//              Authorization 头随请求送出(custom 源豁免缺密钥守卫)
// 零侵入:全部为酒馆官方导出服务与官方服务端路由,不拦截、不改写酒馆任何请求。
// 纯函数(normalizeEndpointUrl / modelsUrlFromEndpoint / buildChatCompletionBody /
// extractChatCompletionContent / errChainMessage)不依赖酒馆运行时,可独立单测;
// 涉及上下文的函数在调用时经 globalThis.SillyTavern.getContext() 取上下文
// (与 window.SillyTavern.getContext 为同一函数)。
// ============================================================================

import { buildSystemMessages } from './sysprompt.js';

/** 连接模式取值 */
export const API_MODE = {
    CURRENT: 'current',
    CUSTOM: 'custom',
};

function getCtx() {
    return globalThis.SillyTavern.getContext();
}

/**
 * 端点 URL 规范化(镜像 story-oracle 的 normalizeUrl 规则)。纯函数。
 *   - 已是完整路径(以 /chat/completions 结尾)→ 原样
 *   - 以 /v1、/v2… 结尾 → 追加 /chat/completions
 *   - rawUrl=true(地址原样使用)→ 裸地址直接追加 /chat/completions
 *   - 其余(裸域名 / base)→ 追加 /v1/chat/completions
 */
export function normalizeEndpointUrl(endpoint, rawUrl) {
    const u = String(endpoint ?? '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (/\/chat\/completions$/.test(u)) return u;
    if (/\/v\d+$/.test(u)) return u + '/chat/completions';
    if (rawUrl) return u + '/chat/completions';
    return u + '/v1/chat/completions';
}

/** 由端点推导模型列表地址(GET /models)。纯函数。 */
export function modelsUrlBase(endpoint, rawUrl) {
    return normalizeEndpointUrl(endpoint, rawUrl).replace(/\/chat\/completions$/, '');
}

/** 构造 OpenAI 兼容 chat/completions 请求体。纯函数。 */
export function buildChatCompletionBody(prompt, { model, maxTokens } = {}) {
    return {
        model: String(model ?? ''),
        messages: [{ role: 'user', content: prompt }],
        max_tokens: Number(maxTokens) || undefined,
        stream: false,
    };
}

/** 从 chat/completions 响应 JSON 提取文本,缺失时抛错。纯函数。 */
export function extractChatCompletionContent(data) {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw new Error('响应缺少 choices[0].message.content');
    }
    return content;
}

/** 从模型列表响应提取模型 id 数组;兼容 {data:[{id}]},裸数组,{models:[{name}]},条目 id/name/model 键。纯函数。 */
export function extractModelIds(data) {
    const list = Array.isArray(data)
        ? data
        : Array.isArray(data?.data)
            ? data.data
            : Array.isArray(data?.models)
                ? data.models
                : [];
    const ids = list
        .map(m => (typeof m === 'string' ? m : (m?.id ?? m?.name ?? m?.model)))
        .map(id => (typeof id === 'string' ? id.trim() : id))
        .filter(Boolean);
    if (!ids.length) throw new Error('模型列表为空');
    return ids;
}

/** 把任意值转成可读错误文字(对象 JSON 化,嵌套 error.message 递归挖掘) */
function describeValue(v, depth = 0) {
    if (v == null || depth > 3) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v instanceof Error) {
        // message 本身可能是对象(如 new Error(后端JSON)),递归挖掘
        const m = v.message;
        if (typeof m === 'string' && m) return m;
        if (m != null && typeof m === 'object') {
            const dug = describeValue(m, depth + 1);
            if (dug) return dug;
        }
        return v.name || 'Error';
    }
    try {
        if (v && typeof v === 'object') {
            if (typeof v.message === 'string' && v.message) return v.message;
            if (v.error && typeof v.error === 'object' && typeof v.error.message === 'string') return v.error.message;
            const json = JSON.stringify(v);
            return json && json !== '{}' ? json : Object.prototype.toString.call(v);
        }
    } catch { /* 循环引用等,走兜底 */ }
    return String(v);
}

/**
 * 错误 cause 链展开(借鉴 story-oracle 的 errChainMessage):官方服务会把底层失败
 * 重新包装进 Error.cause(可能是对象而非 Error,如酒馆后端返回的 {error:{message}})。
 * 纯函数:逐层收集(去重、上限 4 层),用 ← 连接。
 */
export function errChainMessage(err) {
    const parts = [];
    const seen = new Set();
    let cur = err;
    for (let depth = 0; cur != null && depth < 4; depth++) {
        const msg = describeValue(cur);
        if (msg && !seen.has(msg)) {
            seen.add(msg);
            parts.push(msg);
        }
        cur = typeof cur === 'object' ? (cur.cause ?? null) : null;
    }
    return parts.join(' ← ') || '未知错误';
}

/** 自定义API 请求头:密钥以显式 Authorization 头送出(custom 源豁免缺密钥守卫) */
function customAuthHeaders(apiKey) {
    const headers = {};
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    return headers;
}

/**
 * 自定义API 模式:经酒馆后端转发生成(官方 ChatCompletionService,custom 源)。
 * payload 形状镜像 story-oracle 的 buildBackendForwardPayload;
 * 注意 ChatCompletionService.processRequest 的 options 参数在 1.14/1.19 均无默认值,
 * 必须显式传 {};signal 用于超时中止。
 */
async function callCustomApi(prompt, settings, signal, sysMsgs = []) {
    const service = getCtx().ChatCompletionService;
    if (!service) throw new Error('当前酒馆未提供 ChatCompletionService,请改用「随主插件」模式');
    const chatUrl = normalizeEndpointUrl(settings.customEndpoint, settings.customRawUrl);
    if (!chatUrl) throw new Error('自定义API 端点 URL 为空,请在插件设置中填写');
    if (!settings.customModel) throw new Error('模型名为空,请在「大总结 API」中填写或拉取模型');
    // 注意:显式按字段名传参,勿直接透传 settings(其键名是 customModel/customApiKey/customRawUrl)
    const body = buildChatCompletionBody(prompt, { model: settings.customModel, maxTokens: settings.maxTokens });
    const result = await service.processRequest({
        chat_completion_source: 'custom',
        custom_url: chatUrl.replace(/\/chat\/completions\/?$/, ''),
        custom_include_headers: JSON.stringify(customAuthHeaders(settings.customApiKey)),
        model: body.model,
        messages: [...sysMsgs, ...body.messages],
        max_tokens: body.max_tokens,
        stream: false,
    }, {}, true, signal ?? null);
    const content = result?.content ?? result;
    if (typeof content !== 'string' || !content.trim()) throw new Error('自定义API 模式返回内容为空');
    return content;
}

/**
 * 自定义API 模式:经酒馆后端 /status 路由拉取模型列表(custom 源,服务端代发无 CORS)。
 * 返回模型 id 数组;原始响应要点会输出到 console 便于诊断。
 */
export async function fetchCustomModels(endpoint, apiKey, rawUrl) {
    const base = modelsUrlBase(endpoint, rawUrl);
    if (!base) throw new Error('自定义API 端点 URL 为空');
    const ctx = getCtx();
    const res = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({
            chat_completion_source: 'custom',
            custom_url: base,
            custom_include_headers: JSON.stringify(customAuthHeaders(apiKey)),
            api_type: 'chat',
        }),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}:${raw.slice(0, 200)}`);
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('模型列表响应不是有效 JSON:' + raw.slice(0, 120)); }
    const ids = extractModelIds(data);
    console.log(`[摘要收集器] 拉取到 ${ids.length} 个模型:`, ids.slice(0, 20).join(', '), ids.length > 20 ? `…(共 ${ids.length})` : '');
    return ids;
}

/** 系统提示词(预设块)总长保护:预设整份可能很长,超出上限截断,防止大总结请求 token 失控 */
const SYS_MESSAGES_MAX_CHARS = 12000;
function limitSysMessages(messages) {
    let total = 0;
    const out = [];
    for (const m of Array.isArray(messages) ? messages : []) {
        const len = String(m.content ?? '').length;
        if (total + len > SYS_MESSAGES_MAX_CHARS) {
            const remain = Math.max(0, SYS_MESSAGES_MAX_CHARS - total);
            if (remain > 0) {
                out.push({ ...m, content: String(m.content).slice(0, remain) + '\n…(系统提示词超出长度上限,已截断)' });
            }
            console.warn(`[摘要收集器] 系统提示词超出长度上限(${SYS_MESSAGES_MAX_CHARS} 字符),已截断`);
            break;
        }
        out.push(m);
        total += len;
    }
    return out;
}

/** 给请求包一层超时:到时抛 TimeoutError 并释放调用方(race 不中止底层请求,自定义API 模式另有 AbortSignal 真中止) */
function withTimeout(promise, seconds, label) {
    const sec = Number(seconds) || 0;
    if (sec <= 0) return promise;
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error(`${label}超时(${sec} 秒)`);
            err.name = 'TimeoutError';
            reject(err);
        }, sec * 1000);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 大总结生成入口:按配置的 API 模式发送提示词,返回模型文本。受 apiTimeoutSec 超时保护。
 * @param {string} prompt 已填充占位符的大总结提示词
 * @param {{apiMode?: string, apiTimeoutSec?: number}} settings 插件配置
 */
export async function generateSummaryText(prompt, settings) {
    const sec = Number(settings.apiTimeoutSec) || 0;
    const sysMsgs = limitSysMessages(buildSystemMessages(settings));
    switch (settings.apiMode) {
        case API_MODE.CUSTOM: {
            // AbortSignal 让底层请求真正中止(不只释放锁)
            const signal = sec > 0 ? AbortSignal.timeout(sec * 1000) : undefined;
            try {
                return await withTimeout(callCustomApi(prompt, settings, signal, sysMsgs), sec, '自定义API请求');
            } catch (err) {
                // AbortSignal 超时的报错是 'signal timed out',统一转成可读文案
                if (err?.name === 'TimeoutError' || /signal timed out/i.test(err?.message ?? '')) {
                    throw new Error(`请求超时(${sec} 秒),可在设置中调整`);
                }
                throw err;
            }
        }
        default: {
            const task = (async () => {
                const merged = sysMsgs.length
                    ? sysMsgs.map(m => m.content).join('\n\n') + '\n\n' + prompt
                    : prompt;
                if (sysMsgs.length) console.log('[摘要收集器] 随主插件模式:系统提示词以文本形式前置(role 不保留)');
                const result = await getCtx().generateQuietPrompt({ quietPrompt: merged });
                return Array.isArray(result) ? result[0] : result;
            })();
            return await withTimeout(task, sec, '随主插件请求');
        }
    }
}
