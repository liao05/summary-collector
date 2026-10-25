// ============================================================================
// 摘要收集器 —— 配置与运行时状态存取(v0.10.0 起)
// ----------------------------------------------------------------------------
// 配置存储:data/<用户>/user/files/summary-collector-config.json
//   读:GET /user/files/<name>(酒馆静态用户文件路由,1.14/1.19 一致)
//   写:POST /api/files/upload(name + base64,官方端点,防抖)
//   旧配置(extension_settings.summaryCollector,存于 settings.json)在首次
//   加载时自动迁移到文件,并清空旧位置 —— 单一真源,避免双源漂移。
// 运行时状态(计数 / pending / 锚点):chat_metadata,随聊天存档持久(不变)。
// ============================================================================

import { getContext } from '/scripts/st-context.js';
import { MODULE_KEY, METADATA_KEY, DEFAULTS } from './constants.js';
import { toastWarning } from './toast.js';

const CONFIG_FILE = 'summary-collector-config.json';
const TAG = '[摘要收集器]';

/** 内存中的配置真源(getSettings 返回它的引用,调用方原地修改) */
const configStore = {};
let initialized = false;
let saveTimer = null;

/** 补齐缺失的默认键(原地) */
function fillDefaults(target) {
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (target[key] === undefined) {
            target[key] = structuredClone(value);
        }
    }
    return target;
}

/** UTF-8 安全的 base64(中文配置必须;分块避免大数组 spread 上限) */
function toBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/** 立即把配置写入服务端文件(官方 /api/files/upload) */
async function saveConfigNow() {
    try {
        const json = JSON.stringify(configStore, null, 2);
        const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers: getContext().getRequestHeaders(),
            body: JSON.stringify({ name: CONFIG_FILE, data: toBase64Utf8(json) }),
        });
        if (!res.ok) {
            toastWarning(`配置保存失败(HTTP ${res.status}),本次修改仅当前页面生效,请检查网络后重试`);
        }
    } catch (err) {
        console.error(`${TAG} 配置保存失败:`, err);
        toastWarning('配置保存失败(网络异常),本次修改仅当前页面生效');
    }
}

/**
 * 初始化配置(插件注册时 await):读服务端文件 → 迁移旧配置 → 必要时首次落盘。
 * 必须在任何 getSettings() 消费方(UI 渲染/事件处理)之前完成。
 */
export async function initConfig() {
    if (initialized) return;
    initialized = true;
    let fileExists = false;
    try {
        const res = await fetch(`/user/files/${encodeURIComponent(CONFIG_FILE)}`, { cache: 'no-store' });
        if (res.ok) {
            const text = await res.text();
            try {
                const json = JSON.parse(text);
                if (json && typeof json === 'object' && Object.keys(json).length) {
                    Object.assign(configStore, json);
                    fileExists = true;
                }
            } catch (parseErr) {
                // 文件被手滑编辑坏:保留原文件不被默认值覆盖,内存用默认值运行并提醒修复
                fileExists = true;
                console.error(`${TAG} 配置文件不是有效 JSON(已保留原文件,使用默认值运行):`, parseErr);
                toastWarning(`配置文件 ${CONFIG_FILE} 不是有效 JSON,已用默认值运行且不会覆盖该文件 —— 请修复后刷新页面`);
            }
        }
    } catch (err) {
        console.warn(`${TAG} 读取配置文件失败,尝试迁移/使用默认值:`, err);
    }

    if (!fileExists) {
        // 迁移:旧配置存在(settings.json 的 extension_settings)则整体搬入
        const legacy = getContext().extensionSettings?.[MODULE_KEY];
        if (legacy && typeof legacy === 'object' && Object.keys(legacy).length) {
            Object.assign(configStore, legacy);
            console.log(`${TAG} 已将配置从 settings.json 迁移至用户文件目录(${CONFIG_FILE})`);
        }
        // 清空旧位置(extension_settings 仅留空对象),settings.json 不再承载插件配置
        try {
            if (getContext().extensionSettings) {
                getContext().extensionSettings[MODULE_KEY] = {};
                getContext().saveSettingsDebounced();
            }
        } catch { /* 清理失败不影响运行 */ }
    }

    fillDefaults(configStore);
    if (!fileExists) {
        await saveConfigNow(); // 首次落盘(含迁移结果)
    }
}

/** 读取配置(返回内存真源引用;缺键自动补默认) */
export function getSettings() {
    fillDefaults(configStore);
    return configStore;
}

/** 保存配置(防抖 800ms 写入服务端文件;保持旧导出名,调用方无感) */
export function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveConfigNow, 800);
}

// ---------------------------------------------------------------------------
// 运行时状态(chat_metadata,与 v0.1 起一致)
// ---------------------------------------------------------------------------

/** 读取当前聊天的运行时状态(缺失字段自动补零值) */
export function getMeta() {
    const ctx = getContext();
    const meta = (ctx.chatMetadata[METADATA_KEY] ??= {});
    meta.count ??= 0;             // 本周期已写入「摘要收集」的记录数(以条目实际内容为准,见 plugin.js 重数逻辑)
    meta.ord ??= 0;               // AI 楼层序号(单调递增,用户楼层不计)
    meta.pending ??= {};          // 待写入队列: { [楼层索引]: { ord, summary, time, fp } }
    meta.awaitingSummary ??= false; // 是否已进入待总结窗口
    meta.summaryArmOrd ??= 0;     // 进入待总结窗口时的楼层序号
    meta.lastFloorIndex ??= -1;   // 最后处理的楼层索引(swipe/继续时区分新楼)
    meta.captured ??= {};         // 已捕获楼层索引 → 内容指纹(含「指定楼层捕获」,防重复)
    meta.summaryAnchor ??= -1;    // 总结锚点:已成功大总结覆盖到的最大楼层号;≤锚点的楼层不再进入后续总结(防重复)
    return meta;
}

export function saveMeta() {
    getContext().saveMetadataDebounced();
}

/** 整体重置当前聊天的周期状态(清空收集时使用;随「清空收集条目」一并重置锚点 = 明确的全部重来) */
export function resetMeta() {
    const ctx = getContext();
    ctx.chatMetadata[METADATA_KEY] = {
        count: 0,
        ord: 0,
        pending: {},
        awaitingSummary: false,
        summaryArmOrd: 0,
        lastFloorIndex: -1,
        captured: {},
        summaryAnchor: -1,
    };
    return ctx.chatMetadata[METADATA_KEY];
}
