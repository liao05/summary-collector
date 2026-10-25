// ============================================================================
// 摘要收集器 —— 世界书层:创建 / 附加 / 读写「摘要收集」「摘要总结」条目
// ----------------------------------------------------------------------------
// 只使用 SillyTavern 官方导出:
//   loadWorldInfo / saveWorldInfo   读写世界书(走 worldInfoCache + /api/worldinfo/edit)
//   createWorldInfoEntry            按官方模板创建条目并自动分配 uid
//   charUpdateAddAuxWorld           把世界书追加到角色卡的附加世界书列表(多挂载)
//   world_info                      读取 charLore(角色附加世界书列表)
//   world_info_position             条目位置枚举(before = 0)
// 所有读改写经模块内互斥队列串行化,避免并发覆盖。
// ============================================================================

import {
    createWorldInfoEntry,
    world_info_position,
    charUpdateAddAuxWorld,
    world_info,
} from '/scripts/world-info.js';
import { getCharaFilename } from '/scripts/utils.js';
import { getContext } from '/scripts/st-context.js';
import { COLLECT_ENTRY, DIGEST_ENTRY, COLLECT_ORDER, DIGEST_ORDER, MODULE_NAME } from './constants.js';
import { getSettings } from './settings.js';

/** 诊断日志(帮助远程定位环境问题) */
export function log(...args) {
    console.log(`[${MODULE_NAME}]`, ...args);
}

/** 互斥队列:所有世界书写操作串行执行 */
let queue = Promise.resolve();
function serialized(task) {
    const next = queue.then(task);
    queue = next.catch(() => { });
    return next;
}

/** 世界书名里的非法文件字符替换掉(ST 以 <名字>.json 存储世界书) */
export function sanitizeBookName(name) {
    return String(name).replace(/[\\/:*?"<>|]/g, '-').trim() || '未知角色';
}

/** 解析当前应使用的世界书名:配置优先,否则自动「<角色名>-摘要」 */
export function resolveBookName() {
    const settings = getSettings();
    const configured = (settings.bookName || '').trim();
    if (configured) return configured;
    const ctx = getContext();
    const character = ctx.characters?.[ctx.characterId];
    return `${sanitizeBookName(character?.name)}-摘要`;
}

function findEntryByName(data, entryName) {
    for (const entry of Object.values(data?.entries ?? {})) {
        if (entry?.comment === entryName) return entry;
    }
    return null;
}

/**
 * 确保世界书文件存在(不存在则创建空书)。
 * 注意:酒馆后端对不存在的书返回「空壳对象」({entries:{}})而非错误,
 * 因此存在性必须按 entries 是否为空判断 —— 否则永远不会走创建分支,
 * 新建的世界书也就不会刷新到世界书面板下拉列表。
 */
async function ensureBook(bookName) {
    const ctx = getContext();
    let data = await ctx.loadWorldInfo(bookName);
    if (!data || !data.entries || !Object.keys(data.entries).length) {
        data = { name: bookName, entries: {} };
        await ctx.saveWorldInfo(bookName, data, true);
        await ctx.updateWorldInfoList?.(); // 新建书即时出现在世界书面板下拉
        log(`世界书「${bookName}」已创建`);
    }
    return data;
}

/** 确保两个固定条目存在(常驻蓝灯、角色定义之前、递归隔离) */
function ensureEntry(data, entryName, order) {
    if (findEntryByName(data, entryName)) return false;
    const entry = createWorldInfoEntry(entryName, data);
    if (!entry) return false;
    Object.assign(entry, {
        comment: entryName,
        content: '',
        constant: true,                          // 蓝灯:每楼常驻注入
        position: world_info_position.before,    // 角色定义之前
        disable: false,
        selective: false,
        excludeRecursion: true,                  // 不被其他条目递归激活
        preventRecursion: true,                  // 其内容不递归激活其他条目
        order,
        probability: 100,
        useProbability: true,
        addMemo: true,
        key: [],
        keysecondary: [],
    });
    return true;
}

/** 判断世界书是否已挂到当前角色的附加世界书列表 */
export function isAuxAttached(bookName) {
    const ctx = getContext();
    const chid = ctx.characterId;
    if (chid == null || chid < 0) return false;
    const fileName = getCharaFilename(chid);
    const slot = (world_info.charLore ?? []).find(item => item.name === fileName);
    return Array.isArray(slot?.extraBooks) && slot.extraBooks.includes(bookName);
}

/** 把世界书附加到当前角色的附加世界书列表;失败降级为警告,不阻塞收集/总结 */
export async function attachBook(bookName) {
    if (isAuxAttached(bookName)) return false;
    try {
        const ctx = getContext();
        const character = ctx.characters?.[ctx.characterId];
        if (!character?.avatar) {
            throw new Error('未找到当前角色');
        }
        await charUpdateAddAuxWorld(character.avatar, bookName);
        log(`已将世界书「${bookName}」附加到角色「${character.name}」的附加世界书`);
        return true;
    } catch (err) {
        console.warn(`[${MODULE_NAME}] 附加世界书失败(不影响收集与总结,可稍后在酒馆世界书面板手动挂载):`, err);
        return false;
    }
}

/**
 * 确保世界书、两个条目、附加挂载全部就绪,返回世界书名。
 * 群聊或未选择角色时抛错(由调用方提示并跳过)。
 */
export async function ensureAll() {
    const ctx = getContext();
    if (ctx.groupId) {
        throw new Error('群聊暂不支持,已跳过');
    }
    const chid = ctx.characterId;
    if (chid == null || chid < 0 || !ctx.characters?.[chid]) {
        throw new Error('未选择角色,已跳过');
    }
    const bookName = resolveBookName();
    const data = await ensureBook(bookName);
    let changed = ensureEntry(data, COLLECT_ENTRY, COLLECT_ORDER);
    changed = ensureEntry(data, DIGEST_ENTRY, DIGEST_ORDER) || changed;
    if (changed) {
        await ctx.saveWorldInfo(bookName, data, true);
        log(`世界书「${bookName}」已创建并写入两个固定条目`);
    }
    await attachBook(bookName);
    return bookName;
}

/** 串行化的读改写:loadWorldInfo → mutator(原地修改 data)→ saveWorldInfo → 刷新打开中的编辑器 */
function withBook(bookName, mutator) {
    return serialized(async () => {
        const ctx = getContext();
        const data = await ctx.loadWorldInfo(bookName);
        if (!data) throw new Error(`世界书「${bookName}」不存在`);
        const result = await mutator(data);
        await ctx.saveWorldInfo(bookName, data, true);
        refreshEditorIfOpen(bookName);
        return result;
    });
}

/**
 * 若世界书编辑器当前正打开这本书,立即刷新其显示。
 * 作用:① 用户能实时看到条目变化;② 防止编辑器里的旧快照被保存后覆盖插件刚写入的记录。
 */
export function refreshEditorIfOpen(bookName) {
    try {
        getContext().reloadWorldInfoEditor?.(bookName);
    } catch { /* 刷新失败不影响写入 */ }
}

/** 读取单个条目的原始内容 */
export async function readEntry(bookName, entryName) {
    return serialized(async () => {
        const data = await getContext().loadWorldInfo(bookName);
        const entry = findEntryByName(data, entryName);
        return entry ? String(entry.content ?? '') : '';
    });
}

/** 按分隔符把条目内容拆成记录列表(分隔符独占一行) */
export function splitRecords(content, separator) {
    const records = [];
    let current = [];
    for (const line of String(content ?? '').split('\n')) {
        if (line.trim() === separator) {
            records.push(current.join('\n').trim());
            current = [];
        } else {
            current.push(line);
        }
    }
    records.push(current.join('\n').trim());
    return records.filter(Boolean);
}

/** 把记录列表用分隔符行拼回条目内容 */
export function joinRecords(records, separator) {
    return records.map(record => record.trim()).filter(Boolean).join(`\n${separator}\n`);
}

/** 向「摘要收集」条目追加若干条记录 */
export async function appendRecords(bookName, records, separator) {
    const clean = records.map(record => String(record).trim()).filter(Boolean);
    if (!clean.length) return;
    await withBook(bookName, (data) => {
        const entry = findEntryByName(data, COLLECT_ENTRY);
        if (!entry) throw new Error(`条目「${COLLECT_ENTRY}」不存在`);
        const merged = [...splitRecords(entry.content, separator), ...clean];
        entry.content = joinRecords(merged, separator);
    });
}

/** 读取「摘要收集」条目当前内容(已按分隔符规整) */
export async function readCollection(bookName, separator) {
    const content = await readEntry(bookName, COLLECT_ENTRY);
    return joinRecords(splitRecords(content, separator), separator);
}

/** 大总结写回:摘要追加进「摘要总结」(只增),同时清空「摘要收集」 */
export async function appendDigestAndClearCollection(bookName, digest) {
    await withBook(bookName, (data) => {
        const digestEntry = findEntryByName(data, DIGEST_ENTRY);
        const collectEntry = findEntryByName(data, COLLECT_ENTRY);
        if (!digestEntry || !collectEntry) throw new Error('世界书条目缺失');
        digestEntry.content = digestEntry.content ? `${digestEntry.content}\n${digest}` : digest;
        collectEntry.content = '';
    });
}

/** 清空「摘要收集」条目 */
export async function clearCollection(bookName) {
    await withBook(bookName, (data) => {
        const entry = findEntryByName(data, COLLECT_ENTRY);
        if (entry) entry.content = '';
    });
}

/** 统计「摘要收集」条目当前的实际记录数(count 以此为准,防止状态失真) */
export async function countRecords(bookName, separator) {
    const content = await readEntry(bookName, COLLECT_ENTRY);
    return splitRecords(content, separator).length;
}

/** 「摘要总结」条目是否有内容(走缓存读取) */
export async function isDigestEmpty(bookName) {
    const digest = await readEntry(bookName, DIGEST_ENTRY);
    return !String(digest ?? '').trim();
}

/**
 * 直读世界书文件探测总结数据(绕过 worldInfoCache —— 世界书被外部/文件级删除后缓存可能陈旧)。
 * 走官方 /api/worldinfo/get 端点(与 loadWorldInfo 内部同一请求,仅跳过缓存)。
 * @returns {Promise<{bookMissing: boolean, digestEmpty: boolean}>}
 */
export async function probeDigest(bookName) {
    try {
        const ctx = getContext();
        const res = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ name: bookName }),
            cache: 'no-cache',
        });
        if (!res.ok) return { bookMissing: true, digestEmpty: true };
        const data = await res.json();
        if (!data || !data.entries || !Object.keys(data.entries).length) {
            return { bookMissing: true, digestEmpty: true };
        }
        const entry = findEntryByName(data, DIGEST_ENTRY);
        return { bookMissing: false, digestEmpty: !String(entry?.content ?? '').trim() };
    } catch {
        // 网络异常不武断判定(保守:视为数据仍在,避免误重置)
        return { bookMissing: false, digestEmpty: false };
    }
}

/** 整书重建:全新空书 + 两个固定条目(经 saveWorldInfo 同步更新缓存与文件,防陈旧缓存复活旧数据) */
export async function rebuildBook(bookName) {
    const data = { name: bookName, entries: {} };
    ensureEntry(data, COLLECT_ENTRY, COLLECT_ORDER);
    ensureEntry(data, DIGEST_ENTRY, DIGEST_ORDER);
    const ctx = getContext();
    await ctx.saveWorldInfo(bookName, data, true);
    await ctx.updateWorldInfoList?.(); // 刷新世界书面板下拉,新书即时可见(无需刷新页面)
    refreshEditorIfOpen(bookName);
}

/**
 * 锚点自愈:总结数据丢失(世界书被误删/总结条目被清空)时重置锚点。
 * - 整书缺失 → 重建空书(同时清 captured 标记,收集数据本已不存在);
 * - 书在但总结条目为空 → 仅重置锚点(保留可能存在的未总结收集记录)。
 * @param {string} bookName 世界书名
 * @param {{summaryAnchor?: number, captured?: object}} meta 聊天运行时状态(原地修改)
 * @returns {Promise<boolean>} 是否执行了重置
 */
export async function healAnchorIfLost(bookName, meta) {
    if ((meta.summaryAnchor ?? -1) < 0) return false;
    const probe = await probeDigest(bookName);
    if (probe.bookMissing) {
        await rebuildBook(bookName);
        meta.captured = {};
    } else if (!probe.digestEmpty) {
        return false; // 总结数据在,锚点有效
    }
    meta.summaryAnchor = -1;
    log('检测到总结数据缺失(世界书被删或条目被清空),总结锚点已重置');
    return true;
}
