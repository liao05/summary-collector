// ============================================================================
// 摘要收集器 —— 大总结系统提示词来源(v1.2.0)
// ----------------------------------------------------------------------------
// 两种可选来源(参考 story-oracle-outline 的「系统提示词来源」设计,零侵入实现):
//   custom —— 用户自己写的系统提示词:作为 system 消息置顶;
//   preset —— 接酒馆 Chat Completion 预设:读取预设的提示词块,保 role 逐块组装
//             (marker 块 = 本结论文的落位槽;其余块前后环绕;每块宏替换);
//             预设块前立身份头,防"扮演/续写"类指令污染归纳任务。
// 官方接口:getContext().getPresetManager('openai')(getPresetList / getCompletionPresetByName)、
//            getContext().substituteParams。不使用 unsafe.eval、不依赖酒馆助手。
// ============================================================================

import { SYSPROMPT_IDENTITY_HEADER } from './constants.js';

function getCtx() {
    return globalThis.SillyTavern.getContext();
}

/** 列出酒馆 Chat Completion 预设名(官方预设管理器) */
export function listChatPresets() {
    try {
        const pm = getCtx().getPresetManager?.('openai');
        if (!pm) return [];
        const list = pm.getPresetList();
        const names = Array.isArray(list?.preset_names)
            ? list.preset_names
            : Object.keys(list?.preset_names ?? {});
        return names.filter(Boolean);
    } catch (err) {
        console.warn('[摘要收集器] 读取酒馆预设列表失败:', err);
        return [];
    }
}

/** 读取指定预设对象(含 prompts 数组),失败返回 null */
export function getPresetByName(name) {
    try {
        const pm = getCtx().getPresetManager?.('openai');
        return pm?.getCompletionPresetByName?.(name) ?? null;
    } catch (err) {
        console.warn('[摘要收集器] 读取酒馆预设失败:', err);
        return null;
    }
}

/**
 * 把预设的提示词块分成槽前 / 槽后两组(纯函数,可单测)。
 * - marker 块(chatHistory/对话示例等)视为"本论内容落位槽",不产出消息;首个槽位之后的内容归入槽后;
 * - 空内容跳过;role 仅接受 system/user/assistant,其余归为 system。
 * @param {Array<{role?: string, content?: string, system_prompt?: string, marker?: boolean}>} items 预设 prompts
 * @param {(text: string) => string} substitute 宏替换函数
 * @returns {{pre: Array<{role: string, content: string}>, post: Array<{role: string, content: string}>, sawSlot: boolean}}
 */
export function splitPresetBlocks(items, substitute) {
    const pre = [];
    const post = [];
    let sawSlot = false;
    let slotOpen = false;
    for (const item of Array.isArray(items) ? items : []) {
        if (!item || typeof item !== 'object') continue;
        if (item.marker === true) {
            if (!sawSlot) { sawSlot = true; slotOpen = true; }
            continue;
        }
        const raw = String(item.content ?? item.system_prompt ?? '');
        let content = raw;
        try { content = substitute ? substitute(raw) : raw; } catch { /* 宏替换失败保留原文 */ }
        if (!content.trim()) continue;
        const role = ['system', 'user', 'assistant'].includes(item.role) ? item.role : 'system';
        (slotOpen ? post : pre).push({ role, content });
    }
    return { pre, post, sawSlot };
}

/**
 * 按配置组装"系统提示词来源"对应的消息列表(custom / preset;none 返回空数组)。
 * @param {object} settings 插件配置(sysPromptSource / sysPromptCustom / sysPromptPresetName)
 * @returns {Array<{role: string, content: string}>} 置于总结请求最前的消息(不含总结正文 prompt 本身)
 */
export function buildSystemMessages(settings) {
    const source = settings?.sysPromptSource ?? 'none';
    if (source === 'custom') {
        const text = String(settings.sysPromptCustom ?? '').trim();
        if (!text) return [];
        return [
            { role: 'system', content: SYSPROMPT_IDENTITY_HEADER },
            { role: 'system', content: text },
        ];
    }
    if (source === 'preset') {
        const name = String(settings.sysPromptPresetName ?? '').trim();
        if (!name) return [];
        const preset = getPresetByName(name);
        if (!preset || !Array.isArray(preset.prompts) || !preset.prompts.length) return [];
        const ctx = getCtx();
        const substitute = (text) => (typeof ctx.substituteParams === 'function' ? ctx.substituteParams(text) : text);
        const { pre, post } = splitPresetBlocks(preset.prompts, substitute);
        return [
            { role: 'system', content: SYSPROMPT_IDENTITY_HEADER },
            ...pre,
            ...post,
        ];
    }
    return [];
}
