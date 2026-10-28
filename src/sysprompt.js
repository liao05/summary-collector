// 摘要收集器 —— 大总结系统提示词来源(v1.4.0:内置事件级 V5)
// ----------------------------------------------------------------------------
// 三种可选来源(参考 story-oracle 的「系统提示词来源」设计,零侵入实现):
//   custom  —— 用户自己写的系统提示词:作为 system 消息置顶;
//   builtin —— 内置「事件级 V5」:固定文本,UI 不可编辑,跨模型通用;
//   preset  —— 接酒馆 Chat Completion 预设:先按预设的 prompt_order 还原真实块顺序,
//             由用户勾选/排序要保留的块,冻结成快照存进本插件配置;每次大总结按快照
//             逐块组装(保 role、marker 当落位槽、每块宏替换)。
// 快照一旦保存即与酒馆预设解耦:之后在酒馆里改预设不会影响已冻结的块(想更新就重新挑选)。
// 官方接口:getContext().getPresetManager('openai')(getPresetList / getCompletionPresetByName)、
//            getContext().substituteParams。不使用 unsafe.eval、不依赖酒馆助手。
// ============================================================================

import { SYSPROMPT_IDENTITY_HEADER, BUILTIN_EVENT_PROMPT } from './constants.js';

function getCtx() {
    return globalThis.SillyTavern?.getContext?.() ?? {};
}

/** 酒馆运行时注入的上下文插槽(预设里 marker:true 的块) */
const MARKER_IDS = new Set([
    'personaDescription', 'worldInfoBefore', 'charDescription', 'charPersonality',
    'scenario', 'worldInfoAfter', 'dialogueExamples', 'chatHistory',
]);

/** 列出酒馆 Chat Completion 预设名(官方预设管理器,兼容数组/映射/预设数组三种形态) */
export function listChatPresets() {
    try {
        const pm = getCtx().getPresetManager?.('openai');
        if (!pm) return [];
        const list = pm.getPresetList?.();
        if (!list) return [];
        const names = list.preset_names ?? list.presetNames;
        if (Array.isArray(names)) return names.filter(Boolean);
        if (names && typeof names === 'object') return Object.keys(names);
        if (Array.isArray(list.presets)) return list.presets.map(p => p?.name).filter(Boolean);
        return [];
    } catch (err) {
        console.warn('[摘要收集器] 读取酒馆预设列表失败:', err);
        return [];
    }
}

/** 读取指定预设对象(含 prompts / prompt_order),失败返回 null */
export function getPresetByName(name) {
    try {
        const pm = getCtx().getPresetManager?.('openai');
        if (!pm) return null;
        try {
            const p = pm.getCompletionPresetByName?.(name);
            if (p) return p;
        } catch { /* 下一级回退 */ }
        const list = pm.getPresetList?.();
        if (list && Array.isArray(list.presets)) {
            const names = list.preset_names ?? list.presetNames;
            if (names && typeof names === 'object' && !Array.isArray(names) && names[name] != null) {
                return list.presets[names[name]] ?? null;
            }
            return list.presets.find(p => p?.name === name) ?? null;
        }
        return null;
    } catch (err) {
        console.warn('[摘要收集器] 读取酒馆预设失败:', err);
        return null;
    }
}

/**
 * 把预设还原成「真实顺序的块列表」(纯函数,可单测)。
 * - 顺序来自 prompt_order(优先 character_id 100001,旧版 100000,再退最长/第一条);
 *   没有可用顺序时退回 prompts 数组本身。
 * - 停用的块也输出,enabledInOrder=false,由调用方标记与默认不勾选。
 * @returns {Array<{block: object, enabledInOrder: boolean}>}
 */
export function readPresetOrderedBlocks(preset) {
    if (!preset || !Array.isArray(preset.prompts)) return [];
    const byId = {};
    for (const p of preset.prompts) if (p && p.identifier) byId[p.identifier] = p;

    let entry = null;
    if (Array.isArray(preset.prompt_order) && preset.prompt_order.length) {
        const po = preset.prompt_order;
        entry = po.find(e => e && e.character_id === 100001)
            || po.find(e => e && e.character_id === 100000)
            || po.slice().sort((a, b) => (b?.order?.length || 0) - (a?.order?.length || 0))[0]
            || po[0];
    }
    const order = entry && Array.isArray(entry.order) ? entry.order : null;
    if (!order) {
        return preset.prompts.filter(Boolean).map(block => ({ block, enabledInOrder: true }));
    }
    const out = [];
    for (const o of order) {
        if (!o) continue;
        const block = byId[o.identifier];
        if (block) out.push({ block, enabledInOrder: o.enabled !== false });
    }
    return out;
}

/** 去掉所有 {{...}} 宏(迭代剥离嵌套)后的可见字面量 */
function visibleResidue(content) {
    let s = String(content || '');
    for (let i = 0; i < 6; i++) s = s.replace(/\{\{[^{}]*\}\}/g, '');
    return s.trim();
}

// 默认勾选只是启发式(用户逐行复核),命中这些名字的块默认不勾 / 默认勾
const DROP_NAME = /(cot|思维链|思考模式|字数|禁词|禁用词|防打断|抢话|杀八股|杀超雄|超雄|杀比拟|杀揭示|杀说明|杀声述|白描|微观|通感|占有|支配|转折词|模型选择|特化|破限|文风|人称|视角|草稿|prism|core|油腻|谄媚|揣测|语气描写|防情绪|防复述|转述|推剧情|极端|全知|反全知|生动化|加强|复述|抗过拟合|抗绝望|抗抢话|正文格式)/i;
const KEEP_NAME = /(人格|情感|基调|世界|world|角色|故事|设定|主提示|主提示词|lore|背景|场景|情景)/i;

/**
 * 单个块的默认勾选判定(纯函数,可单测)。
 * 规则只影响弹窗里的预勾选,用户始终是最终决定者。
 * @returns {{keep: boolean, category: string, note: string}}
 */
export function classifyBlock(block) {
    if (!block || typeof block !== 'object') return { keep: false, category: 'inert', note: '无效块' };
    if (block.marker === true || MARKER_IDS.has(block.identifier)) {
        return { keep: true, category: 'marker', note: '上下文插槽' };
    }
    const content = String(block.content ?? block.system_prompt ?? '');
    const role = block.role || 'system';
    const name = String(block.name || '');
    const residue = visibleResidue(content);
    const setCount = (content.match(/\{\{(setvar|setglobalvar)::/gi) || []).length;
    const hasSet = setCount > 0;
    const hasGet = /\{\{(getvar|getglobalvar)::/i.test(content);
    const hasLastMsg = /\{\{lastusermessage\}\}/i.test(content);
    const dropName = DROP_NAME.test(name);
    const keepName = KEEP_NAME.test(name);

    // 回显主聊天输入的块,对总结任务无意义
    if (hasLastMsg && residue.length <= 60) {
        return { keep: false, category: 'user-echo', note: '回显主聊天输入' };
    }
    // 宏替换后什么都不剩(隐形块)
    if (!residue) {
        // 变量初始化块是其它块 getvar 的前提,按结构识别(不靠名字)并保留
        if (hasSet && !hasGet && setCount >= 15) {
            return { keep: true, category: 'machinery', note: '变量初始化(隐形·必留)' };
        }
        if (dropName) return { keep: false, category: 'output', note: '输出/思维链/反模式(隐形)' };
        if (keepName) return { keep: true, category: 'story', note: '故事/世界/人格(隐形)' };
        if (hasSet) return { keep: true, category: 'machinery', note: '变量控制(隐形)' };
        if (hasGet) return { keep: true, category: 'wrapper', note: '结构变量(隐形)' };
        return { keep: false, category: 'inert', note: '注释/空块' };
    }
    // assistant/user 起手是正文预填,总结窗口里会诱导续写
    if (role === 'assistant' || role === 'user') {
        return { keep: false, category: 'prefill', note: `${role} 起手` };
    }
    // 短且带尖括号的可见文字,多半是包裹在插槽外的结构标签
    const looksStructural = residue.length <= 120 && /[<>[\]]/.test(residue);
    if (looksStructural && !dropName) return { keep: true, category: 'wrapper', note: '包裹标签' };

    if (block.identifier === 'main') return { keep: true, category: 'story', note: '主提示' };
    if (dropName) return { keep: false, category: 'output', note: '输出/思维链/反模式' };
    if (keepName) return { keep: true, category: 'story', note: '故事/世界/人格' };
    return { keep: true, category: 'review', note: '未分类·请确认' };
}

/**
 * 把一个预设展开成挑选清单的行模型(纯函数,可单测)。
 * 停用的块也出现在清单里(标记 disabled、默认不勾),用户仍可手动勾上。
 * @returns {Array<{identifier, name, role, kind, content, chars, keep, disabled, category, note}>}
 */
export function buildCurationRows(preset) {
    const rows = [];
    for (const { block, enabledInOrder } of readPresetOrderedBlocks(preset)) {
        if (!block) continue;
        const isMarker = block.marker === true || MARKER_IDS.has(block.identifier);
        const content = String(block.content ?? block.system_prompt ?? '');
        const c = classifyBlock(block);
        const disabled = enabledInOrder === false;
        rows.push({
            identifier: block.identifier || '',
            name: String(block.name || block.identifier || '').trim(),
            role: ['system', 'user', 'assistant'].includes(block.role) ? block.role : 'system',
            kind: isMarker ? 'marker' : 'text',
            content,
            chars: content.length,
            keep: disabled ? false : c.keep,
            disabled,
            category: c.category,
            note: c.note,
        });
    }
    return rows;
}

/** 冻结挑选结果:只留勾选行,按当前顺序;正文/角色一起冻结(纯函数,可单测) */
export function snapshotFromRows(rows) {
    const items = (Array.isArray(rows) ? rows : [])
        .filter(r => r && r.keep)
        .map(r => (r.kind === 'marker'
            ? { kind: 'marker', identifier: r.identifier, name: r.name }
            : {
                kind: 'text',
                identifier: r.identifier,
                name: r.name,
                role: ['system', 'user', 'assistant'].includes(r.role) ? r.role : 'system',
                content: String(r.content ?? ''),
            }));
    return { items, curatedAt: Date.now() };
}

/** 快照组装用键:同 kind 下优先 identifier,旧快照无 identifier 时退回 name */
function rowKey(kind, identifier, name) {
    const id = identifier != null && identifier !== '' ? identifier : '\u0001' + (name || '');
    return `${kind}\u0000${id}`;
}

/**
 * 用已保存的快照回显挑选清单(纯函数,可单测)。
 * 目的:再次打开「重新挑选」时显示的是上次保存的结果,而不是分类器默认值;
 * 「打开后原样保存」应得到逐项相同的快照。
 * - 勾选行 = 快照条目、按快照顺序,正文/角色取冻结版(活预设的改动不漏进来);
 * - 未勾选行 = 现读行里没被快照认领的,插在预设顺序中最近前驱之后;
 * - 预设里已删除、快照里仍在用的块,仍以勾选行出现。
 */
export function curationRowsFromSnapshot(freshRows, snap) {
    const fresh = Array.isArray(freshRows) ? freshRows : [];
    const items = (snap && Array.isArray(snap.items)) ? snap.items : [];
    if (!items.length) return fresh.map(r => ({ ...r }));

    const claimed = new Map();
    const out = [];
    for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const kind = it.kind === 'marker' ? 'marker' : 'text';
        const key = rowKey(kind, it.identifier, it.name);
        const idx = fresh.findIndex((r, i) => !claimed.has(i) && rowKey(r.kind, r.identifier, r.name) === key);
        const base = idx >= 0 ? fresh[idx] : null;
        let row;
        if (kind === 'marker') {
            row = base
                ? { ...base, name: it.name || base.name, keep: true }
                : {
                    identifier: it.identifier || '', name: it.name || it.identifier || '', role: 'system',
                    kind: 'marker', content: '', chars: 0, keep: true, disabled: false,
                    category: 'marker', note: '上下文插槽',
                };
        } else {
            const content = String(it.content ?? '');
            const role = ['system', 'user', 'assistant'].includes(it.role) ? it.role : 'system';
            const c = base ? null : classifyBlock({ identifier: it.identifier, name: it.name, role, content });
            row = {
                ...(base || { disabled: false, category: c.category, note: c.note }),
                identifier: it.identifier || '', name: it.name || (base && base.name) || '',
                role, kind: 'text', content, chars: content.length, keep: true,
            };
        }
        if (idx >= 0) claimed.set(idx, row);
        out.push(row);
    }
    fresh.forEach((fr, i) => {
        if (claimed.has(i)) return;
        const row = { ...fr, keep: false };
        let at = 0;
        for (let j = i - 1; j >= 0; j--) {
            const pos = claimed.has(j) ? out.indexOf(claimed.get(j)) : -1;
            if (pos >= 0) { at = pos + 1; break; }
        }
        out.splice(at, 0, row);
        claimed.set(i, row);
    });
    return out;
}

/**
 * 把块列表组装成消息(纯函数,可单测)。
 * 同时接受预设原始块({marker:true, content})与快照条目({kind:'marker'|'text'})。
 * - marker 视为「本论内容落位槽」,不产出消息;首个槽位之后的内容归入槽后;
 * - 空内容跳过;role 仅接受 system/user/assistant,其余归为 system;每块单独宏替换。
 * @returns {{pre: Array<{role: string, content: string}>, post: Array<{role: string, content: string}>, sawSlot: boolean}}
 */
export function assembleMessages(items, substitute) {
    const pre = [];
    const post = [];
    let sawSlot = false;
    let slotOpen = false;
    for (const item of Array.isArray(items) ? items : []) {
        if (!item || typeof item !== 'object') continue;
        if (item.kind === 'marker' || item.marker === true) {
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

/** 兼容旧调用名(v1.2.0 起的单测与内部使用) */
export function splitPresetBlocks(items, substitute) {
    return assembleMessages(items, substitute);
}

/**
 * 按配置组装"系统提示词来源"对应的消息列表(custom / preset;none 返回空数组)。
 * preset 优先用冻结快照;没有快照时(旧配置/手动改配置)按真实顺序 + 默认勾选实时组装,
 * 保证不会出现"选了预设却一条系统提示都没有"的空转。
 * @param {object} settings 插件配置(sysPromptSource / sysPromptCustom / sysPromptPresetName / sysPromptPresetSnapshots)
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
    if (source === 'builtin') {
        return [
            { role: 'system', content: SYSPROMPT_IDENTITY_HEADER },
            { role: 'system', content: BUILTIN_EVENT_PROMPT },
        ];
    }
    if (source === 'preset') {
        const name = String(settings.sysPromptPresetName ?? '').trim();
        if (!name) return [];
        const ctx = getCtx();
        const substitute = (text) => (typeof ctx.substituteParams === 'function' ? ctx.substituteParams(text) : text);
        const snapshots = settings.sysPromptPresetSnapshots;
        let items = (snapshots && typeof snapshots === 'object' && snapshots[name]?.items) || null;

        if (!Array.isArray(items) || !items.length) {
            const preset = getPresetByName(name);
            if (!preset) return [];
            const snap = snapshotFromRows(buildCurationRows(preset));
            items = snap.items;
            console.log('[摘要收集器] 预设尚无挑选快照,已按默认勾选实时组装;可在设置里点[重新挑选]保存');
        }
        if (!items.length) return [];

        const { pre, post } = assembleMessages(items, substitute);
        return [
            { role: 'system', content: SYSPROMPT_IDENTITY_HEADER },
            ...pre,
            ...post,
        ];
    }
    return [];
}
