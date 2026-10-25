// ============================================================================
// 摘要收集器 —— 根入口
// ----------------------------------------------------------------------------
// 根入口只负责握手和加载模块;业务逻辑在 src/ 下。
// 等待 globalThis.SillyTavern.getContext 就绪后,动态加载 src/plugin.js 完成注册。
// ============================================================================
(function () {
    'use strict';

    const TAG = '[摘要收集器]';

    function isReady() {
        return typeof globalThis.SillyTavern?.getContext === 'function';
    }

    function waitReady(attempt = 0) {
        if (isReady()) {
            boot();
            return;
        }
        if (attempt >= 300) {
            console.error(`${TAG} 等待酒馆就绪超时(30s),插件未启动`);
            return;
        }
        setTimeout(() => waitReady(attempt + 1), 100);
    }

    async function boot() {
        try {
            const { registerSummaryCollector } = await import('./src/plugin.js');
            await registerSummaryCollector();
        } catch (err) {
            console.error(`${TAG} 模块加载失败:`, err);
        }
    }

    waitReady();
})();
