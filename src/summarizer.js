// ============================================================================
// 摘要收集器 —— 大总结:模板填充 + 当前 LLM 静默生成 + 写回世界书
// ============================================================================

import { CONTENT_PLACEHOLDER, DEFAULT_TEMPLATE, COLLECT_ENTRY, DIGEST_ENTRY, MODULE_NAME } from './constants.js';
import { getSettings, getMeta, saveMeta } from './settings.js';
import { ensureAll, readCollection, appendDigestAndClearCollection, healAnchorIfLost, log } from './lorebook.js';
import { normalizeDigest } from './extractor.js';
import { generateSummaryText, errChainMessage } from './api-client.js';
import { toastInfo, toastSuccess, toastError } from './toast.js';

let running = false;

export function isRunning() {
    return running;
}

/** 用收集内容填充大总结模板(split/join 规避替换串中 $ 等特殊字符问题) */
export function buildSummaryPrompt(template, content) {
    const tpl = template?.trim() ? template : DEFAULT_TEMPLATE;
    return tpl.split(CONTENT_PLACEHOLDER).join(content);
}

/**
 * 执行一次大总结:读「摘要收集」→ 静默生成 → 追加进「摘要总结」→ 清空收集。
 * @param {{manual?: boolean}} options manual=true 时由面板按钮触发,忽略延后与阈值
 * @returns {Promise<boolean>} 是否成功执行
 */
export async function runSummary({ manual = false } = {}) {
    if (running) {
        toastInfo('大总结正在进行中,已忽略本次请求');
        return false;
    }
    running = true;
    try {
        const settings = getSettings();
        const meta = getMeta();
        const bookName = await ensureAll();

        // 锚点自愈(可配置关闭):总结数据丢失(世界书被误删/条目被清空)时重置锚点,后续可重新捕获历史楼层
        if (settings.autoHealAnchor !== false && await healAnchorIfLost(bookName, meta)) {
            toastInfo('检测到总结数据缺失,锚点已重置,可重新捕获历史楼层');
        }

        const content = await readCollection(bookName, settings.separator);
        if (!content) {
            if (meta.awaitingSummary) {
                meta.awaitingSummary = false;
                meta.count = 0; // 条目为空时计数归零,保持状态与条目一致
            }
            toastInfo('「摘要收集」条目为空,无需总结');
            return false;
        }

        log(`开始大总结(${settings.apiMode === 'custom' ? `自定义API ${settings.customEndpoint} · ${settings.customModel}` : '随主插件'},${content.split(settings.separator).length} 条记录)`);
        const prompt = buildSummaryPrompt(settings.template, content);
        const text = await generateSummaryText(prompt, settings);
        const digest = normalizeDigest(text, settings.separator);
        if (!digest) {
            throw new Error('模型返回内容为空');
        }

        await appendDigestAndClearCollection(bookName, digest);
        // 总结锚点:本次总结覆盖到的最大楼层(收集条目清空前,captured 标记记录了所有已入库楼层)
        const anchor = Math.max(-1, ...Object.keys(meta.captured ?? {}).map(Number));
        meta.count = 0;
        meta.awaitingSummary = false;
        meta.summaryAnchor = anchor;
        log(`大总结完成,收集条目已重置,总结锚点更新至 #${anchor}`);
        toastSuccess(`大总结完成${manual ? '(手动)' : ''}:已写入「${DIGEST_ENTRY}」,已总结至 #${anchor},「${COLLECT_ENTRY}」已重置`);
        return true;
    } catch (err) {
        // 失败保留全部现场,重新进入延后期,下个触发点自动重试;也可点面板按钮立即重试
        const meta = getMeta();
        if (meta.awaitingSummary) meta.summaryArmOrd = meta.ord;
        console.error(`[${MODULE_NAME}] 大总结失败,完整错误对象:`, err);
        log(`大总结失败:${errChainMessage(err)}`);
        toastError(`大总结失败:${errChainMessage(err)}(现场已保留,可点「立即 / 重试大总结」重试)`);
        return false;
    } finally {
        running = false;
        saveMeta();
    }
}
