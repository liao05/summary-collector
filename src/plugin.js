// ============================================================================
// 摘要收集器 —— 注册入口:事件绑定与总调度
// ----------------------------------------------------------------------------
// 数据流:
//   AI 楼层到达 → 提取(多摘要只取第一个)→ 进 pending 待写队列
//   → 满延后楼数(默认3)→ 写入「摘要收集」(记录间 <=>),计数 +1
//   → 计数 ≥ 阈值(默认30)→ 进入待总结窗口
//   → 再过延后楼数 → 静默生成大总结 → 追加「摘要总结」→ 清空收集、计数归零
// 延迟窗口内 swipe/编辑同一楼只会刷新 pending 内容;已写入的记录不回滚。
// ============================================================================

import { getContext } from '/scripts/st-context.js';
import { MODULE_NAME } from './constants.js';
import { initConfig, getSettings, getMeta, saveMeta } from './settings.js';
import { extractFloor, buildRecord, fingerprint } from './extractor.js';
import { ensureAll, appendRecords, countRecords, readCollection, healAnchorIfLost } from './lorebook.js';
import { runSummary } from './summarizer.js';
import { initUI, updateStatus } from './ui.js';
import { toastWarning, toastInfo, toastError, toastErrorOnce } from './toast.js';
import { log } from './lorebook.js';

let warnedNoSummaryTag = false;
let warnedApiConfig = false;

/** 大总结 API 配置预检:自定义API 模式下端点/模型未配全时提醒(同类只提醒一次,配置修复后自动重置) */
function warnIfApiConfigIncomplete(settings) {
    if (settings.apiMode !== 'custom' || warnedApiConfig) return;
    const missing = [];
    if (!settings.customEndpoint?.trim()) missing.push('端点 URL');
    if (!settings.customModel?.trim()) missing.push('模型');
    if (!missing.length) { warnedApiConfig = false; return; }
    warnedApiConfig = true;
    toastWarning(`大总结 API 未配置完整(缺:${missing.join('、')}),继续游玩到触发大总结时会失败 —— 请在扩展设置「大总结 API」中补全`);
}

/** 配置变化时重置预检提醒(供设置面板调用,改完配置可再次收到提醒) */
export function resetApiConfigWarning() {
    warnedApiConfig = false;
}

/** 注册插件:加载服务端配置 → 初始化 → 绑定事件、构建面板 */
export async function registerSummaryCollector() {
    await initConfig(); // 配置从 data/<用户>/user/files/ 加载(含旧配置迁移),必须先于一切消费方
    getSettings();
    bindEvents();
    initUI();
    console.log(`[${MODULE_NAME}] 已加载(监听 AI 楼层,收集摘要并定期大总结)`);
}

function bindEvents() {
    const { eventSource, eventTypes } = getContext();
    eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(eventTypes.MESSAGE_EDITED, onMessageMutated);
    eventSource.on(eventTypes.MESSAGE_UPDATED, onMessageMutated);
    eventSource.on(eventTypes.MESSAGE_SWIPED, onMessageMutated);
    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
}

/** 新 AI 楼层到达 */
async function onMessageReceived(messageId) {
    try {
        const settings = getSettings();
        if (!settings.enabled) return;

        const ctx = getContext();
        const message = ctx.chat?.[messageId];
        if (!message || message.is_user || message.is_system) return;

        if (!settings.summaryTag?.trim()) {
            if (!warnedNoSummaryTag) {
                warnedNoSummaryTag = true;
                toastWarning('尚未配置摘要标签,请在扩展设置中填写后重载聊天');
            }
            return;
        }

        const meta = getMeta();
        // 同一楼层再次触发(继续/重新生成/swipe 完成)不递增楼层序号,只刷新内容
        if (meta.lastFloorIndex !== messageId) {
            meta.ord += 1;
            meta.lastFloorIndex = messageId;
        }
        refreshPending(messageId, message, meta.ord, settings);

        await commitDue(settings);
        armIfNeeded(settings);
        await runSummaryIfDue(settings);
        saveMeta();
        updateStatus();
    } catch (err) {
        toastErrorOnce(`处理楼层失败:${err?.message ?? err}`);
    }
}

/** 楼层被编辑/swipe/更新:仅当该楼还在待写队列时刷新其内容 */
async function onMessageMutated(messageId) {
    try {
        const settings = getSettings();
        if (!settings.enabled) return;
        const meta = getMeta();
        if (!meta.pending?.[messageId]) return;

        const ctx = getContext();
        const message = ctx.chat?.[messageId];
        if (!message || message.is_user || message.is_system) {
            delete meta.pending[messageId];
        } else {
            refreshPending(messageId, message, meta.pending[messageId].ord, settings);
        }
        saveMeta();
        updateStatus();
    } catch (err) {
        toastErrorOnce(`刷新楼层记录失败:${err?.message ?? err}`);
    }
}

/** 切换聊天:为新聊天初始化状态结构并刷新面板 */
function onChatChanged() {
    try {
        getMeta();
        updateStatus();
    } catch (err) {
        console.error(`[${MODULE_NAME}] 聊天切换处理失败:`, err);
    }
}

/** 提取该楼内容进待写队列(无摘要则移除;已总结过(≤锚点)或已捕获的楼层跳过) */
function refreshPending(index, message, ord, settings) {
    const meta = getMeta();
    if (index <= (meta.summaryAnchor ?? -1)) return; // 已在「摘要总结」中,防重复
    if (meta.captured?.[index]) return; // 该楼已捕获入库,避免重复
    const rec = extractFloor(message.mes ?? '', {
        summaryTag: settings.summaryTag,
        timeTag: settings.timeTag,
    });
    if (!rec) {
        delete meta.pending[index];
        return;
    }
    if (settings.timeTag && rec.time === null) {
        toastWarning(`第 ${index + 1} 楼未提取到时间内容(标签:${settings.timeTag}),本楼记录将不含时间`);
    }
    meta.pending[index] = {
        ord,
        summary: rec.summary,
        time: rec.time,
        fp: fingerprint(index, rec.summary, rec.time ?? ''),
    };
}

/** 把满延后楼数的 pending 记录写入「摘要收集」;待总结窗口内暂缓写入 */
async function commitDue(settings) {
    const meta = getMeta();
    if (meta.awaitingSummary) return;

    const due = Object.entries(meta.pending)
        .filter(([, rec]) => meta.ord - rec.ord >= settings.delayFloors)
        .sort((a, b) => a[1].ord - b[1].ord);
    if (!due.length) return;

    const bookName = await ensureAll();
    const records = due.map(([, rec]) =>
        buildRecord(rec, { includeTime: Boolean(settings.timeTag), separator: settings.separator }));
    await appendRecords(bookName, records, settings.separator);

    for (const [index, rec] of due) {
        delete meta.pending[index];
        meta.captured[index] = rec.fp; // 标记已入库(与「指定楼层捕获」共用防重复)
    }
    // count 以收集条目实际内容为准,杜绝状态失真(如世界书被外部修改/旧版数据迁移)
    meta.count = await countRecords(bookName, settings.separator);
    log(`已提交 ${due.length} 条记录,收集条目当前共 ${meta.count} 条`);
    saveMeta();
    warnIfApiConfigIncomplete(settings); // 有实际收集活动时预检大总结配置
}

/** 计数达到阈值则进入待总结窗口 */
function armIfNeeded(settings) {
    const meta = getMeta();
    if (!meta.awaitingSummary && meta.count >= settings.threshold) {
        meta.awaitingSummary = true;
        meta.summaryArmOrd = meta.ord;
        log(`收集满 ${meta.count} 条,进入待总结窗口(${settings.delayFloors} 楼后执行)`);
        toastInfo(`已收集满 ${meta.count} 条摘要,${settings.delayFloors} 楼后进行大总结`);
        warnIfApiConfigIncomplete(settings); // 即将大总结,配置不完整时强提醒
    }
}

/** 待总结窗口满延后楼数后执行大总结 */
async function runSummaryIfDue(settings) {
    const meta = getMeta();
    if (meta.awaitingSummary && meta.ord - meta.summaryArmOrd >= settings.delayFloors) {
        await runSummary();
    }
}

/**
 * 指定楼层捕获:把 [start, end] 楼层范围内、尚未捕获的 AI 楼层摘要
 * 直接追加进「摘要收集」(绕过延后队列),供中途启用插件时补录历史剧情。
 * 只捕获入库,不触发大总结(达到阈值时提示用户手动执行)。
 * 自愈:若收集条目当前为空(被清空/刚做完大总结),视为全新开始,
 * 清空 captured 标记 —— 否则旧标记会让所有楼层被误判"已入库"而跳过。
 * 楼层号与聊天界面显示的 #N 一致(从 0 开始)。
 * @returns {Promise<{captured: number, skipped: number, total: number}>}
 */
export async function captureFloorRange(start, end) {
    const settings = getSettings();
    if (!settings.enabled) throw new Error('插件已停用');
    if (!settings.summaryTag?.trim()) throw new Error('未配置摘要标签');

    const ctx = getContext();
    const chat = ctx.chat ?? [];
    const lo = Math.max(0, Math.min(start, end));
    const hi = Math.min(chat.length - 1, Math.max(start, end));
    if (lo > hi) throw new Error(`楼层范围无效(当前聊天共 ${chat.length} 楼,#0 ~ #${chat.length - 1})`);

    const meta = getMeta();
    meta.captured ??= {};
    const bookName = await ensureAll();

    // 锚点自愈(可配置关闭):总结数据丢失(世界书被误删/条目被清空)→ 重置锚点,历史楼层可重新捕获
    if (settings.autoHealAnchor !== false && await healAnchorIfLost(bookName, meta)) {
        toastInfo('检测到总结数据缺失,锚点已重置,可重新捕获历史楼层');
    }
    const anchor = meta.summaryAnchor ?? -1;

    // 自愈:条目为空但存在 captured 标记 = 标记与内容失步(条目被外部清空/大总结后),
    // 清掉标记让历史楼层可重新捕获。锚点不清(≤锚点的楼层已进「摘要总结」,再捕获即重复)。
    // 自然到达路径的防重复不受影响(该路径不清标记)。
    const currentContent = await readCollection(bookName, settings.separator);
    if (!currentContent && Object.keys(meta.captured).length) {
        log('收集条目为空,已重置楼层捕获标记(可重新捕获历史楼层)');
        meta.captured = {};
    }

    const records = [];
    let skipped = 0;
    let skippedSummarized = 0;
    let aiFloors = 0;

    for (let i = lo; i <= hi; i++) {
        const message = chat[i];
        if (!message || message.is_user || message.is_system) continue;
        aiFloors += 1;
        if (i <= anchor) { skippedSummarized += 1; continue; } // 已总结过,跳过(防重复总结)
        if (meta.captured[i]) { skipped += 1; continue; } // 已在收集条目中
        // 延后队列(pending)中的楼层:内容尚未写入条目 —— 显式捕获时立即落盘,避免总结时缺楼
        if (meta.pending[i]) {
            const pendingRec = meta.pending[i];
            records.push(buildRecord(pendingRec, { includeTime: Boolean(settings.timeTag), separator: settings.separator }));
            meta.captured[i] = pendingRec.fp;
            delete meta.pending[i];
            continue;
        }
        const rec = extractFloor(message.mes ?? '', {
            summaryTag: settings.summaryTag,
            timeTag: settings.timeTag,
        });
        if (!rec) continue;
        if (settings.timeTag && rec.time === null) {
            toastWarning(`第 ${i + 1} 楼未提取到时间内容(标签:${settings.timeTag}),本楼记录将不含时间`);
        }
        records.push(buildRecord(rec, { includeTime: Boolean(settings.timeTag), separator: settings.separator }));
        meta.captured[i] = fingerprint(i, rec.summary, rec.time ?? '');
    }

    // 全部落空且并非因"已总结/已入库"跳过 → 多半是标签名与 AI 回复不匹配,给出明确提示
    if (!records.length && aiFloors > 0 && !skipped && !skippedSummarized) {
        toastWarning(`范围内 ${aiFloors} 个 AI 楼层均未提取到摘要(标签:${settings.summaryTag}),请检查标签名是否与 AI 回复内的标签一致`);
    }

    if (records.length) {
        await appendRecords(bookName, records, settings.separator);
    }
    meta.count = await countRecords(bookName, settings.separator);
    log(`指定楼层捕获 [#${lo}~#${hi}]:捕获 ${records.length} 条,跳过已总结 ${skippedSummarized} 条、已入库 ${skipped} 条,当前共 ${meta.count} 条(锚点 #${anchor})`);
    saveMeta();
    updateStatus();

    // 只捕获不总结:达到阈值时提示手动执行
    if (meta.count >= settings.threshold && !meta.awaitingSummary) {
        toastInfo(`当前已收集 ${meta.count} 条(阈值 ${settings.threshold}),可点「立即 / 重试大总结」执行`);
    }
    return { captured: records.length, skipped, skippedSummarized, total: meta.count };
}
