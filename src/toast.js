// ============================================================================
// 摘要收集器 —— 轻提示(封装 toastr,缺失时回退 console)
// ============================================================================

import { MODULE_NAME } from './constants.js';

function show(kind, message) {
    const text = `[${MODULE_NAME}] ${message}`;
    if (typeof toastr !== 'undefined' && typeof toastr[kind] === 'function') {
        toastr[kind](text);
    } else {
        console[kind === 'error' ? 'error' : 'log'](text);
    }
}

export function toastInfo(message) {
    show('info', message);
}

export function toastSuccess(message) {
    show('success', message);
}

export function toastWarning(message) {
    show('warning', message);
}

export function toastError(message) {
    show('error', message);
}

/** 同类错误只提示一次(按消息文本去重),避免连续楼层反复刷屏 */
const onceShown = new Set();
function showOnce(kind, message) {
    if (onceShown.has(message)) return;
    onceShown.add(message);
    show(kind, message);
}

export function toastErrorOnce(message) {
    showOnce('error', message);
}

export function toastWarningOnce(message) {
    showOnce('warning', message);
}
