// ============================================================================
// 摘要收集器 —— 正文提取(纯函数,无任何依赖,可独立单测)
// ============================================================================

/** 转义正则特殊字符 */
export function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 提取文本中 <tag>...</tag> 块的内容。一楼出现多个同名块时取**内容最长**的一个
 * (部分预设中同名标签兼具选项/短标记用途,摘要块通常最长;单块行为不变)。
 * @param {string} text 正文
 * @param {string} tag 标签名(不带尖括号)
 * @returns {string|null} 命中并 trim 后的内容;未命中或标签名为空返回 null
 */
export function extractTagContent(text, tag) {
    const name = String(tag ?? '').trim();
    if (!name) return null;
    const re = new RegExp(`<${escapeRegExp(name)}>([\\s\\S]*?)</${escapeRegExp(name)}>`, 'g');
    let best = null;
    for (const match of String(text ?? '').matchAll(re)) {
        const content = match[1].trim();
        if (!best || content.length > best.length) best = content;
    }
    return best;
}

/**
 * 从一楼正文中提取摘要与时间。
 * @returns {{summary: string, time: string|null}|null} 摘要标签未命中时返回 null;
 *          时间标签未启用或未命中时 time 为 null(由调用方决定是否提醒用户)
 */
export function extractFloor(text, { summaryTag, timeTag }) {
    const summary = extractTagContent(text, summaryTag);
    if (summary === null) return null;
    const time = timeTag ? extractTagContent(text, timeTag) : null;
    return { summary, time };
}

/** 去掉文本中独占一行的分隔符,防止破坏记录结构 */
export function stripSeparatorLines(text, separator) {
    const lines = String(text ?? '').split('\n').filter(line => line.trim() !== separator);
    return lines.join('\n').trim();
}

/**
 * 由提取结果拼装一条收集记录:有时间为「时间 - 摘要」,无时间仅为摘要。
 * @param {{summary: string, time: string|null}} rec 提取结果
 * @param {{includeTime: boolean, separator: string}} opts includeTime = 时间标签是否启用
 */
export function buildRecord(rec, { includeTime, separator }) {
    const body = stripSeparatorLines(rec.summary, separator);
    const head = includeTime && rec.time ? stripSeparatorLines(rec.time, separator) : '';
    return head ? `${head} - ${body}` : body;
}

/**
 * 清洗模型返回的大总结:去掉空行、代码块围栏、模板占位标签、独立分隔符行。
 * @returns {string} 逐行「时间 - 事情」文本;无有效内容时为空串
 */
export function normalizeDigest(text, separator) {
    const lines = String(text ?? '')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && line !== separator)
        .filter(line => !/^```/.test(line) && line !== '<collect>' && line !== '</collect>');
    return lines.join('\n').trim();
}

/** 稳定的字符串指纹(djb2),用于楼层内容去重比对 */
export function fingerprint(...parts) {
    const s = parts.join('\u0001');
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = (((h << 5) + h) + s.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
}
