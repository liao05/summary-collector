// ============================================================================
// 摘要收集器 —— 扩展设置面板
// ============================================================================

import { getContext } from '/scripts/st-context.js';
import { DEFAULTS, DEFAULT_TEMPLATE } from './constants.js';
import { getSettings, saveSettings, getMeta, saveMeta, resetMeta } from './settings.js';
import { runSummary } from './summarizer.js';
import { captureFloorRange, resetApiConfigWarning } from './plugin.js';
import { ensureAll, clearCollection } from './lorebook.js';
import { fetchCustomModels, errChainMessage } from './api-client.js';
import {
    listChatPresets,
    getPresetByName,
    buildCurationRows,
    snapshotFromRows,
    curationRowsFromSnapshot,
} from './sysprompt.js';
import { toastInfo, toastSuccess, toastError } from './toast.js';

const PANEL_HTML = `
<div id="summary_collector_settings" class="extension_settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>摘要收集器</b><span class="sc-version" id="sc_version" title="当前加载的插件版本(用于确认更新已生效)"></span>
            <div class="inline-drawer-icon fa-solid fa-circle-down down"></div>
        </div>
        <div class="inline-drawer-content">

            <div class="sc-card sc-card-status">
                <div class="sc-stats">
                    <div class="sc-stat"><span class="sc-stat-num" id="sc_status_count">0</span><span class="sc-stat-label">已收集</span></div>
                    <div class="sc-stat"><span class="sc-stat-num" id="sc_status_pending">0</span><span class="sc-stat-label">待写入</span></div>
                    <div class="sc-stat"><span class="sc-stat-num" id="sc_status_await">否</span><span class="sc-stat-label">待总结</span></div>
                    <div class="sc-stat"><span class="sc-stat-num" id="sc_status_anchor">-</span><span class="sc-stat-label">已总结至</span></div>
                </div>
                <div class="sc-hint">「已收集」显示 当前条数/阈值 —— 距下次大总结的进度(大总结后清零重新攒)。「摘要收集」每楼一条,每次大总结后清空重来;「摘要总结」存大总结结果,只增不清;收集与大总结都会延后 N 个 AI 楼层执行。</div>
            </div>

            <div class="sc-card">
                <div class="sc-card-title">基础设置</div>
                <label class="checkbox_label sc-check">
                    <input id="sc_enabled" type="checkbox">
                    <span>启用插件(监听 AI 楼层,提取时间与摘要写入世界书)</span>
                </label>
                <label class="checkbox_label sc-check" title="开启:检测到总结数据丢失(世界书被删/总结条目被清空)时自动重置总结锚点,历史楼层可重新捕获;关闭:锚点只随「清空收集条目」按钮重置">
                    <input id="sc_auto_heal" type="checkbox">
                    <span>自动重置锚点(检测到总结数据丢失时)</span>
                </label>
                <div class="sc-grid">
                    <div class="sc-field">
                        <label for="sc_summary_tag">摘要标签(必填,不带尖括号)</label>
                        <input id="sc_summary_tag" class="text_pole textarea_compact" type="text" placeholder="dream_summary">
                    </div>
                    <div class="sc-field">
                        <label for="sc_time_tag">时间标签(可选,留空禁用)</label>
                        <input id="sc_time_tag" class="text_pole textarea_compact" type="text" placeholder="留空禁用">
                    </div>
                    <div class="sc-field">
                        <label for="sc_separator">记录分隔符</label>
                        <input id="sc_separator" class="text_pole textarea_compact" type="text">
                    </div>
                    <div class="sc-field">
                        <label for="sc_threshold">总结阈值(满多少条触发)</label>
                        <input id="sc_threshold" class="text_pole textarea_compact" type="number" min="1" max="500" step="1">
                    </div>
                    <div class="sc-field">
                        <label for="sc_delay">延后楼数(AI 楼层)</label>
                        <input id="sc_delay" class="text_pole textarea_compact" type="number" min="0" max="100" step="1">
                    </div>
                </div>
                <div class="sc-field">
                    <label for="sc_book_name">世界书名(留空则自动「角色名-摘要」,与已有附加世界书并存)</label>
                    <input id="sc_book_name" class="text_pole textarea_compact" type="text" placeholder="留空自动命名">
                </div>
            </div>

            <div class="sc-card">
                <div class="sc-card-title">大总结 API</div>
                <div class="sc-pill-group" id="sc_api_mode_group">
                    <label class="sc-pill"><input type="radio" name="sc_api_mode" value="current"><span>随主插件</span></label>
                    <label class="sc-pill"><input type="radio" name="sc_api_mode" value="custom"><span>自定义API</span></label>
                </div>
                <div id="sc_api_custom" hidden>
                    <div class="sc-field">
                        <label for="sc_custom_endpoint">端点 URL(裸域名自动补 /v1;特殊路径勾"地址原样使用")</label>
                        <input id="sc_custom_endpoint" class="text_pole textarea_compact" type="text" placeholder="https://api.example.com">
                    </div>
                    <div class="sc-field">
                        <label for="sc_custom_key">API 密钥(仅保存在本机酒馆 settings.json)</label>
                        <input id="sc_custom_key" class="text_pole textarea_compact" type="password" autocomplete="off">
                    </div>
                    <div class="sc-field">
                        <label for="sc_custom_model">模型(点「拉取模型」后从下拉选择;也可手动输入)</label>
                        <div class="sc-row-inline">
                            <input id="sc_custom_model" class="text_pole textarea_compact" type="text" list="sc_model_list">
                            <datalist id="sc_model_list"></datalist>
                            <a id="sc_fetch_models" class="sc-btn"><i class="fa-solid fa-cloud-arrow-down"></i> 拉取模型</a>
                        </div>
                    </div>
                    <label class="checkbox_label sc-check"><input id="sc_custom_raw" type="checkbox"><span>地址原样使用(不自动补 /v1)</span></label>
                    <div class="sc-field">
                        <label>API 存档(名称框填新名保存;或下拉选中存档后直接点「保存」覆盖)</label>
                        <div class="sc-row-inline">
                            <input id="sc_preset_name" class="text_pole textarea_compact" type="text" placeholder="存档名称(保存时用)">
                            <a id="sc_preset_save" class="sc-btn"><i class="fa-solid fa-floppy-disk"></i> 保存</a>
                        </div>
                        <div class="sc-row-inline">
                            <select id="sc_preset_select" class="text_pole textarea_compact"></select>
                            <a id="sc_preset_load" class="sc-btn"><i class="fa-solid fa-folder-open"></i> 加载</a>
                            <a id="sc_preset_del" class="sc-btn sc-btn-danger"><i class="fa-solid fa-trash"></i> 删除</a>
                        </div>
                    </div>
                    <div class="sc-hint">请求与模型列表均经酒馆服务器代发(无浏览器跨域问题);密钥仅保存在本机。</div>
                </div>
                <div class="sc-grid">
                    <div class="sc-field">
                        <label for="sc_max_tokens">最大输出 tokens(自定义API 生效)</label>
                        <input id="sc_max_tokens" class="text_pole textarea_compact" type="number" min="16" step="1">
                    </div>
                    <div class="sc-field">
                        <label for="sc_timeout">请求超时秒数(0 = 不限时)</label>
                        <input id="sc_timeout" class="text_pole textarea_compact" type="number" min="0" max="3600" step="1">
                    </div>
                </div>
            </div>

            <div class="sc-card">
                <div class="sc-card-title">大总结提示词模板</div>
                <textarea id="sc_template" class="text_pole textarea_compact" rows="8"></textarea>
                                <div class="sc-field">
                    <label>系统提示词来源</label>
                    <div class="sc-inline" id="sc_sys_source_group">
                        <label class="radio_label"><input type="radio" name="sc_sys_source" value="none"><span>不使用</span></label>
                        <label class="radio_label"><input type="radio" name="sc_sys_source" value="custom"><span>自己写提示词</span></label>
                        <label class="radio_label"><input type="radio" name="sc_sys_source" value="preset"><span>接酒馆预设</span></label>
                        <label class="radio_label"><input type="radio" name="sc_sys_source" value="builtin"><span>内置事件级 V5</span></label>
                    </div>
                </div>
                <div class="sc-hint" id="sc_sys_builtin_hint" hidden>内置提示词(代码内固定,界面不可编辑):逐条覆盖、混合分写、成人向只记事件级、剧情线索优先、无法归纳也不整批拒答;适配不同厂商模型的语言与格式习惯。</div>
                <div id="sc_sys_custom" hidden>
                    <div class="sc-field">
                        <label for="sc_sys_custom_text">自定义系统提示词(作为 system 消息置顶)</label>
                        <textarea id="sc_sys_custom_text" class="text_pole textarea_compact" rows="4"></textarea>
                    </div>
                </div>
                <div id="sc_sys_preset" hidden>
                    <div class="sc-field">
                        <label for="sc_sys_preset_select">酒馆 Chat Completion 预设(先挑选要保留的块,再按块顺序组装)</label>
                        <div class="sc-inline">
                            <select id="sc_sys_preset_select" class="text_pole textarea_compact"></select>
                            <a id="sc_sys_preset_refresh" class="sc-btn">刷新</a>
                            <a id="sc_sys_preset_recurate" class="sc-btn" hidden><i class="fa-solid fa-list-check"></i> 重新挑选</a>
                        </div>
                        <div class="sc-hint" id="sc_sys_preset_hint"></div>
                    </div>
                    <div id="sc_curate" class="sc-curate" hidden>
                        <div class="sc-curate-head">
                            <span class="sc-curate-title"><i class="fa-solid fa-list-check"></i> 挑选要保留的块</span>
                            <span class="sc-inline">
                                <a id="sc_curate_all" class="sc-btn">全选</a>
                                <a id="sc_curate_none" class="sc-btn">全不选</a>
                            </span>
                        </div>
                        <div class="sc-hint">勾选要保留的块,用 ↑↓ 调整顺序;「插槽」是本次总结内容的落位处。保存后冻结为快照,之后在酒馆里改预设不影响已保存的组装结果。</div>
                        <div id="sc_curate_list" class="sc-curate-list"></div>
                        <div class="sc-curate-foot">
                            <span id="sc_curate_count" class="sc-hint"></span>
                            <span class="sc-inline">
                                <a id="sc_curate_save" class="sc-btn sc-btn-primary">保存并使用</a>
                                <a id="sc_curate_cancel" class="sc-btn">取消</a>
                            </span>
                        </div>
                    </div>
                    <div class="sc-hint">随主插件模式下系统提示词只能以文本拼接(role 不保留),建议配合自定义API 使用。</div>
                </div>
<div class="sc-actions">
                    <a id="sc_reset_template" class="sc-btn"><i class="fa-solid fa-rotate-left"></i> 恢复默认模板</a>
                </div>
            </div>

            <div class="sc-card">
                <div class="sc-card-title">指定楼层捕获</div>
                <div class="sc-hint">中途启用插件时补录历史楼层;楼层号与聊天界面 #N 一致,仅处理 AI 楼层,已入库的自动跳过。</div>
                <div class="sc-row-inline">
                    <input id="sc_range_start" class="text_pole textarea_compact" type="number" min="0" placeholder="起始楼层 #">
                    <input id="sc_range_end" class="text_pole textarea_compact" type="number" min="0" placeholder="结束楼层 #">
                    <a id="sc_capture_range" class="sc-btn"><i class="fa-solid fa-download"></i> 捕获该范围</a>
                </div>
            </div>

            <div class="sc-actions sc-actions-main">
                <a id="sc_manual_summary" class="sc-btn sc-btn-primary"><i class="fa-solid fa-wand-magic-sparkles"></i> 立即 / 重试大总结</a>
                <a id="sc_clear_collection" class="sc-btn sc-btn-danger"><i class="fa-solid fa-trash"></i> 清空收集条目</a>
            </div>
        </div>
    </div>
</div>`;

async function confirmPopup(text) {
    const ctx = getContext();
    if (typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE && ctx.POPUP_RESULT) {
        const result = await ctx.callGenericPopup(text, ctx.POPUP_TYPE.CONFIRM);
        return result === ctx.POPUP_RESULT.AFFIRMATIVE;
    }
    return window.confirm(text);
}

function clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.round(num)));
}

export function initUI() {
    $('#extensions_settings2').append(PANEL_HTML);
    const settings = getSettings();

    // 版本徽章:从 manifest.json 动态读取(import.meta.url 相对定位,不依赖安装路径),
    // 用于一眼确认浏览器加载的是新版(此环境扩展 JS 缓存较顽固)
    (async () => {
        try {
            const res = await fetch(new URL('../manifest.json', import.meta.url), { cache: 'no-cache' });
            const m = await res.json();
            $('#sc_version').text(`v${m.version ?? '?'}`);
        } catch { /* 读取失败不影响面板 */ }
    })();

    const $enabled = $('#sc_enabled');
    const $autoHeal = $('#sc_auto_heal');
    const $summaryTag = $('#sc_summary_tag');
    const $timeTag = $('#sc_time_tag');
    const $separator = $('#sc_separator');
    const $threshold = $('#sc_threshold');
    const $delay = $('#sc_delay');
    const $bookName = $('#sc_book_name');
    const $template = $('#sc_template');

    // —— 大总结独立 API 元素 ——
    const $modeRadios = $('input[name="sc_api_mode"]');
    const $customEndpoint = $('#sc_custom_endpoint');
    const $customKey = $('#sc_custom_key');
    const $customModel = $('#sc_custom_model');
    const $customRaw = $('#sc_custom_raw');
    const $presetSelect = $('#sc_preset_select');
    const $maxTokens = $('#sc_max_tokens');
    const $timeout = $('#sc_timeout');

    /** 重画 API 存档下拉(尽量保留当前选中项) */
    const renderPresetSelect = () => {
        $presetSelect.empty().append(new Option('(选择存档加载)', ''));
        for (const p of settings.apiPresets ?? []) $presetSelect.append(new Option(p.name, p.name));
    };

    $enabled.prop('checked', Boolean(settings.enabled));
    $autoHeal.prop('checked', settings.autoHealAnchor !== false);
    $summaryTag.val(settings.summaryTag);
    $timeTag.val(settings.timeTag);
    $separator.val(settings.separator);
    $threshold.val(settings.threshold);
    $delay.val(settings.delayFloors);
    $bookName.val(settings.bookName);
    $template.val(settings.template);
    $modeRadios.filter(`[value="${settings.apiMode}"]`).prop('checked', true);
    $customEndpoint.val(settings.customEndpoint);
    $customKey.val(settings.customApiKey);
    $customModel.val(settings.customModel);
    $customRaw.prop('checked', Boolean(settings.customRawUrl));
    renderPresetSelect();
    $maxTokens.val(settings.maxTokens);
    $timeout.val(settings.apiTimeoutSec);

    const persist = () => saveSettings();

    $enabled.on('change', function () {
        settings.enabled = Boolean(this.checked);
        persist();
        toastInfo(settings.enabled ? '已启用' : '已停用');
    });

    $autoHeal.on('change', function () {
        settings.autoHealAnchor = Boolean(this.checked);
        persist();
        toastInfo(settings.autoHealAnchor ? '自动重置锚点已开启' : '自动重置锚点已关闭(锚点仅随「清空收集条目」重置)');
    });

    $summaryTag.on('input', function () {
        settings.summaryTag = String(this.value).trim();
        persist();
    });

    $timeTag.on('input', function () {
        settings.timeTag = String(this.value).trim();
        persist();
    });

    $separator.on('change', function () {
        const value = String(this.value);
        settings.separator = value.trim() ? value : DEFAULTS.separator;
        if (!value.trim()) $separator.val(settings.separator);
        persist();
    });

    $threshold.on('change', function () {
        settings.threshold = clampNumber(this.value, 1, 500, DEFAULTS.threshold);
        $threshold.val(settings.threshold);
        persist();
    });

    $delay.on('change', function () {
        settings.delayFloors = clampNumber(this.value, 0, 100, DEFAULTS.delayFloors);
        $delay.val(settings.delayFloors);
        persist();
    });

    $bookName.on('change', function () {
        settings.bookName = String(this.value).trim();
        persist();
    });

    $template.on('change', function () {
        settings.template = String(this.value);
        persist();
    });

    $('#sc_reset_template').on('click', () => {
        settings.template = DEFAULT_TEMPLATE;
        $template.val(settings.template);
        persist();
        toastInfo('已恢复默认大总结模板');
    });

    // —— 系统提示词来源(自己写提示词 / 接酒馆预设) ——
    const $sysSourceRadios = $('input[name="sc_sys_source"]');
    const $sysCustomText = $('#sc_sys_custom_text');
    const $sysPresetSelect = $('#sc_sys_preset_select');
    const $sysPresetRecurate = $('#sc_sys_preset_recurate');
    const $sysPresetHint = $('#sc_sys_preset_hint');
    const $curate = $('#sc_curate');
    const $curateList = $('#sc_curate_list');
    const $curateCount = $('#sc_curate_count');

    const CURATION_CATEGORY_LABEL = {
        marker: '插槽', story: '故事', wrapper: '包裹', machinery: '变量', prefill: '预填',
        'user-echo': '回显', output: '输出', inert: '空块', review: '待确认',
    };

    /** 挑选清单的临时状态(未保存不上盘):{ name, rows } */
    let curationState = null;

    /** 快照容器(旧配置可能没有该键) */
    const presetSnapshots = () => {
        if (!settings.sysPromptPresetSnapshots || typeof settings.sysPromptPresetSnapshots !== 'object') {
            settings.sysPromptPresetSnapshots = {};
        }
        return settings.sysPromptPresetSnapshots;
    };

    const applySysSourceVisibility = () => {
        $('#sc_sys_custom').attr('hidden', settings.sysPromptSource !== 'custom');
        $('#sc_sys_preset').attr('hidden', settings.sysPromptSource !== 'preset');
        $('#sc_sys_builtin_hint').attr('hidden', settings.sysPromptSource !== 'builtin');
    };

    const updateCurationCount = () => {
        if (!curationState) return;
        const kept = curationState.rows.filter(r => r.keep);
        const texts = kept.filter(r => r.kind === 'text');
        const slots = kept.filter(r => r.kind === 'marker');
        const chars = texts.reduce((n, r) => n + (r.chars || 0), 0);
        $curateCount.text(`保留 ${texts.length} 块 + ${slots.length} 插槽 · 约 ${chars} 字`);
    };

    const renderCurationRows = () => {
        if (!curationState) return;
        $curateList.empty();
        curationState.rows.forEach((r, idx) => {
            const $row = $('<div>')
                .addClass('sc-cur-row')
                .toggleClass('sc-cur-off', !r.keep)
                .toggleClass('sc-cur-marker', r.kind === 'marker');
            const $cb = $('<input type="checkbox" class="sc-cur-cb">').prop('checked', Boolean(r.keep));
            $cb.on('change', () => {
                curationState.rows[idx].keep = $cb.prop('checked');
                $row.toggleClass('sc-cur-off', !$cb.prop('checked'));
                updateCurationCount();
            });
            const displayName = r.name || r.identifier || '(未命名)';
            const $name = $('<span class="sc-cur-name">').text(displayName).attr('title', displayName);
            $row.append($cb, $name);
            if (r.disabled) $row.append($('<span class="sc-cur-disabled">').text('预设已停用'));
            if (r.role && r.role !== 'system') $row.append($('<span class="sc-cur-role">').text(r.role));
            $row.append($('<span class="sc-cur-tag">')
                .addClass(`sc-cur-tag-${r.category}`)
                .text(CURATION_CATEGORY_LABEL[r.category] || r.category));
            $row.append($('<span class="sc-cur-chars">').text(r.kind === 'marker' ? '插槽' : `${r.chars} 字`));

            const $moves = $('<span class="sc-cur-moves">');
            const $up = $('<a class="sc-cur-move" title="上移">↑</a>');
            const $down = $('<a class="sc-cur-move" title="下移">↓</a>');
            $up.on('click', () => moveCurationRow(idx, -1));
            $down.on('click', () => moveCurationRow(idx, 1));
            $moves.append($up, $down);
            $row.append($moves);

            $curateList.append($row);
        });
        updateCurationCount();
    };

    const moveCurationRow = (idx, delta) => {
        if (!curationState) return;
        const to = idx + delta;
        if (to < 0 || to >= curationState.rows.length) return;
        const [row] = curationState.rows.splice(idx, 1);
        curationState.rows.splice(to, 0, row);
        renderCurationRows();
    };

    const closeCuration = () => {
        curationState = null;
        $curate.prop('hidden', true);
    };

    const openCuration = (name, seedRows) => {
        let rows = seedRows;
        if (!rows) {
            const preset = getPresetByName(name);
            if (!preset) {
                toastError(`读取预设「${name}」失败,请点刷新后重试`);
                return;
            }
            rows = buildCurationRows(preset);
        }
        if (!rows.length) {
            toastError(`预设「${name}」没有可挑选的块,请检查酒馆里的预设配置`);
            return;
        }
        curationState = { name, rows };
        $curate.prop('hidden', false);
        renderCurationRows();
        if ($curate[0]?.scrollIntoView) $curate[0].scrollIntoView({ block: 'nearest' });
    };

    const updateSysPresetHint = () => {
        $sysPresetHint.removeClass('sc-hint-error');
        const name = settings.sysPromptPresetName;
        if (!name) {
            const names = listChatPresets();
            $sysPresetHint.text(names.length
                ? '选择一个预设后会打开块挑选清单;选回「(不使用预设)」则使用下方文本框(若填写)。'
                : '未找到已保存的补全预设。请先在酒馆的「预设」里保存一个,再点刷新。');
            $sysPresetRecurate.prop('hidden', true);
            return;
        }
        const snap = presetSnapshots()[name];
        if (snap && Array.isArray(snap.items) && snap.items.length) {
            const texts = snap.items.filter(i => i.kind === 'text');
            const slots = snap.items.filter(i => i.kind === 'marker');
            const chars = texts.reduce((n, i) => n + String(i.content || '').length, 0);
            const gone = !listChatPresets().includes(name);
            $sysPresetHint.text(
                `已按预设「${name}」的挑选结果组装:保留 ${texts.length} 个文本块 + ${slots.length} 个上下文插槽(约 ${chars} 字)。`
                + (gone ? '该预设已不在酒馆列表中,仍使用已保存的快照。' : ''),
            );
            $sysPresetRecurate.prop('hidden', false);
        } else {
            $sysPresetHint.addClass('sc-hint-error')
                .text(`预设「${name}」尚未挑选内容,点[重新挑选]完成挑选后才会生效。`);
            $sysPresetRecurate.prop('hidden', false);
        }
    };

    const renderSysPresetSelect = () => {
        const names = listChatPresets();
        const current = settings.sysPromptPresetName;
        $sysPresetSelect.empty();
        $sysPresetSelect.append(new Option('(不使用预设)', ''));
        for (const name of names) $sysPresetSelect.append(new Option(name, name));
        if (current && !names.includes(current)) {
            // 预设被删/改名:仍列出已保存的快照名,避免用户看不见当前在用的是什么
            $sysPresetSelect.append(new Option(`${current}(快照·不在列表)`, current));
        }
        $sysPresetSelect.val(names.includes(current) || current ? current : '');
        updateSysPresetHint();
    };

    $sysSourceRadios.filter(`[value="${settings.sysPromptSource}"]`).prop('checked', true);
    $sysCustomText.val(settings.sysPromptCustom);
    renderSysPresetSelect();
    applySysSourceVisibility();

    $sysSourceRadios.on('change', function () {
        if (!this.checked) return;
        settings.sysPromptSource = String(this.value);
        persist();
        applySysSourceVisibility();
        if (settings.sysPromptSource === 'preset') renderSysPresetSelect();
    });
    $sysCustomText.on('change', function () {
        settings.sysPromptCustom = String(this.value);
        persist();
    });
    $sysPresetSelect.on('change', function () {
        const name = String(this.value || '');
        if (!name) {
            settings.sysPromptPresetName = '';
            persist();
            updateSysPresetHint();
            return;
        }
        const snap = presetSnapshots()[name];
        if (snap && Array.isArray(snap.items) && snap.items.length) {
            settings.sysPromptPresetName = name;
            persist();
            updateSysPresetHint();
            return;
        }
        // 未挑选过:下拉先回退到已提交值,再打开挑选清单(取消 = 等于没选)
        $sysPresetSelect.val(settings.sysPromptPresetName || '');
        openCuration(name);
    });
    $('#sc_sys_preset_refresh').on('click', () => {
        renderSysPresetSelect();
        toastInfo(`已刷新酒馆预设列表(${listChatPresets().length} 项)`);
    });
    $sysPresetRecurate.on('click', () => {
        const name = settings.sysPromptPresetName;
        if (!name) return;
        const preset = getPresetByName(name);
        const snap = presetSnapshots()[name];
        if (!preset) {
            if (snap && Array.isArray(snap.items) && snap.items.length) {
                openCuration(name, curationRowsFromSnapshot([], snap));
            } else {
                toastError(`读取预设「${name}」失败,请点刷新后重试`);
            }
            return;
        }
        const fresh = buildCurationRows(preset);
        openCuration(name, snap && Array.isArray(snap.items) && snap.items.length
            ? curationRowsFromSnapshot(fresh, snap)
            : fresh);
    });
    $('#sc_curate_all').on('click', () => {
        if (!curationState) return;
        curationState.rows.forEach(r => { r.keep = true; });
        renderCurationRows();
    });
    $('#sc_curate_none').on('click', () => {
        if (!curationState) return;
        curationState.rows.forEach(r => { r.keep = false; });
        renderCurationRows();
    });
    $('#sc_curate_save').on('click', () => {
        if (!curationState) return;
        const snap = snapshotFromRows(curationState.rows);
        if (!snap.items.length) {
            toastError('至少要保留一个块');
            return;
        }
        const name = curationState.name;
        presetSnapshots()[name] = snap;
        settings.sysPromptPresetName = name;
        closeCuration();
        persist();
        renderSysPresetSelect();
        toastSuccess(`已保存预设「${name}」的挑选结果(${snap.items.length} 项)`);
    });
    $('#sc_curate_cancel').on('click', () => {
        closeCuration();
        $sysPresetSelect.val(settings.sysPromptPresetName || '');
        updateSysPresetHint();
    });

    $('#sc_manual_summary').on('click', async () => {
        try {
            await runSummary({ manual: true });
            updateStatus();
        } catch (err) {
            toastError(`手动总结失败:${err?.message ?? err}`);
        }
    });

    $('#sc_clear_collection').on('click', async () => {
        const ok = await confirmPopup('确认清空「摘要收集」条目并重置本周期计数吗?未写入的暂存记录也会一并丢弃。');
        if (!ok) return;
        try {
            const bookName = await ensureAll();
            await clearCollection(bookName);
            resetMeta();
            saveMeta();
            updateStatus();
            toastSuccess('「摘要收集」已清空,周期已重置');
        } catch (err) {
            toastError(`清空失败:${err?.message ?? err}`);
        }
    });

    // —— 大总结独立 API 绑定 ——

    const applyApiModeVisibility = () => {
        $('#sc_api_custom').attr('hidden', settings.apiMode !== 'custom');
    };

    $modeRadios.on('change', function () {
        if (!this.checked) return;
        settings.apiMode = String(this.value);
        persist();
        applyApiModeVisibility();
    });

    $customEndpoint.on('change', function () {
        settings.customEndpoint = String(this.value).trim();
        $customEndpoint.val(settings.customEndpoint);
        persist();
        resetApiConfigWarning();
    });
    $customKey.on('change', function () {
        settings.customApiKey = String(this.value);
        persist();
    });
    $customModel.on('change', function () {
        settings.customModel = String(this.value).trim();
        persist();
        resetApiConfigWarning();
    });
    $customRaw.on('change', function () {
        settings.customRawUrl = Boolean(this.checked);
        persist();
    });

    $('#sc_fetch_models').on('click', async () => {
        try {
            const models = await fetchCustomModels(settings.customEndpoint, settings.customApiKey, settings.customRawUrl);
            $('#sc_model_list').empty();
            for (const m of models) $('#sc_model_list').append(new Option(m, m));
            // 清空输入框:避免浏览器按旧值前缀过滤 datalist,导致下拉看似"只有一个模型"
            $customModel.val('');
            if (!models.includes(settings.customModel)) {
                // 当前已设模型不在新列表中时保留为可选项,避免误选
                $('#sc_model_list').append(new Option(settings.customModel + '(当前)', settings.customModel));
            }
            toastInfo(`获取到 ${models.length} 个模型,点击输入框从下拉选择`);
        } catch (err) {
            toastError(`拉取模型失败:${errChainMessage(err)}`);
        }
    });

    // —— 自定义API 存档 ——

    $('#sc_preset_save').on('click', () => {
        // 命名优先级:名称框有值 → 用名称框(同名覆盖);
        // 名称框为空但下拉选中了存档 → 直接覆盖选中存档(快速保存);
        // 两者皆空 → 提示。不依赖弹窗,任何环境都稳定。
        const typedName = String($('#sc_preset_name').val() || '').trim();
        const selectedName = String($presetSelect.val() || '');
        const presets = settings.apiPresets ?? [];
        let name = '';
        let mode = '';
        if (typedName) {
            name = typedName;
            mode = presets.some(p => p.name === name) ? '覆盖同名存档' : '新建存档';
        } else if (selectedName && presets.some(p => p.name === selectedName)) {
            name = selectedName;
            mode = '覆盖选中存档';
        } else {
            toastInfo('请在名称框输入新名称,或先在下拉选中要覆盖的存档');
            return;
        }
        const preset = { name, endpoint: settings.customEndpoint || '', apiKey: settings.customApiKey || '', model: settings.customModel || '', rawUrl: Boolean(settings.customRawUrl) };
        settings.apiPresets = [...presets.filter(p => p.name !== name), preset];
        persist();
        renderPresetSelect();
        $presetSelect.val(name);
        $('#sc_preset_name').val('');
        toastSuccess(`API 存档「${name}」已保存(${mode})`);
    });
    $('#sc_preset_load').on('click', () => {
        const name = String($presetSelect.val() || '');
        const preset = (settings.apiPresets ?? []).find(p => p.name === name);
        if (!preset) { toastInfo('请先选择要加载的存档'); return; }
        settings.customEndpoint = preset.endpoint || '';
        settings.customApiKey = preset.apiKey || '';
        settings.customModel = preset.model || '';
        settings.customRawUrl = Boolean(preset.rawUrl);
        $customEndpoint.val(settings.customEndpoint);
        $customKey.val(settings.customApiKey);
        $customModel.val(settings.customModel);
        $customRaw.prop('checked', settings.customRawUrl);
        persist();
        toastSuccess(`API 存档「${preset.name}」已加载`);
    });
    $('#sc_preset_del').on('click', async () => {
        const name = String($presetSelect.val() || '');
        if (!name) { toastInfo('请先选择要删除的存档'); return; }
        const ok = await confirmPopup(`确认删除 API 存档「${name}」?`);
        if (!ok) return;
        settings.apiPresets = (settings.apiPresets ?? []).filter(p => p.name !== name);
        persist();
        renderPresetSelect();
        toastSuccess(`API 存档「${name}」已删除`);
    });

    $maxTokens.on('change', function () {
        const num = Number(this.value);
        settings.maxTokens = Number.isFinite(num) ? Math.min(200000, Math.max(16, Math.round(num))) : DEFAULTS.maxTokens;
        $maxTokens.val(settings.maxTokens);
        persist();
    });
    $timeout.on('change', function () {
        const num = Number(this.value);
        settings.apiTimeoutSec = Number.isFinite(num) ? Math.min(3600, Math.max(0, Math.round(num))) : DEFAULTS.apiTimeoutSec;
        $timeout.val(settings.apiTimeoutSec);
        persist();
        toastInfo(settings.apiTimeoutSec > 0 ? `大总结请求超时已设为 ${settings.apiTimeoutSec} 秒` : '大总结请求超时已关闭(不限时)');
    });

    applyApiModeVisibility();

    // —— 指定楼层捕获 ——
    $('#sc_capture_range').on('click', async () => {
        const start = Number($('#sc_range_start').val());
        const end = Number($('#sc_range_end').val());
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
            toastInfo('请先填写起始楼层和结束楼层(与聊天界面 #N 一致)');
            return;
        }
        try {
            const r = await captureFloorRange(start, end);
            updateStatus();
            toastSuccess(`捕获完成:新增 ${r.captured} 条,跳过 ${r.skipped} 条已入库,当前共 ${r.total} 条`);
        } catch (err) {
            toastError(`楼层捕获失败:${err?.message ?? err}`);
        }
    });

    updateStatus();
}

/** 刷新面板状态区(已收集 N/阈值 / 待写入 / 待总结 / 总结锚点) */
export function updateStatus() {
    if (!document.getElementById('sc_status_count')) return;
    const meta = getMeta();
    const settings = getSettings();
    $('#sc_status_count').text(`${meta.count ?? 0}/${settings.threshold}`);
    $('#sc_status_pending').text(Object.keys(meta.pending ?? {}).length);
    $('#sc_status_await').text(meta.awaitingSummary ? '是' : '否');
    $('#sc_status_anchor').text((meta.summaryAnchor ?? -1) >= 0 ? `#${meta.summaryAnchor}` : '-');
}
