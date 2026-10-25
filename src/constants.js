// ============================================================================
// 摘要收集器 —— 常量与默认配置
// ============================================================================

export const MODULE_NAME = '摘要收集器';
export const MODULE_KEY = 'summaryCollector';    // extension_settings 下的配置命名空间
export const METADATA_KEY = 'summary_collector'; // chat_metadata 下的运行时状态键

/** 世界书条目名(按需求固定) */
export const COLLECT_ENTRY = '摘要收集';
export const DIGEST_ENTRY = '摘要总结';

/** 条目注入顺序:order 越大在提示词中越靠前,总结条目排在收集条目上方 */
export const COLLECT_ORDER = 100;
export const DIGEST_ORDER = 101;

/** 大总结模板中收集内容的占位符 */
export const CONTENT_PLACEHOLDER = '{{收集内容}}';

export const DEFAULT_TEMPLATE = `以下是逐楼收集的剧情摘要(记录以<=>分隔)。请归纳为大总结:每行一条,格式严格为"时间 - 事情",保持时间顺序,合并重复与琐碎细节,保留关键剧情节点与因果关系。直接输出内容,不要解释、不要标题、不要代码块。
<collect>
{{收集内容}}
</collect>`;

/** 默认配置(写入 extension_settings.summaryCollector,随酒馆数据目录 settings.json 持久化) */
export const DEFAULTS = {
    enabled: true,               // 总开关
    summaryTag: 'dream_summary', // 摘要标签(必填,不带尖括号)
    timeTag: '',                 // 时间标签(可选,留空禁用)
    separator: '<=>',            // 收集条目内各楼记录之间的分隔符
    threshold: 30,               // 收集满多少条触发大总结
    delayFloors: 3,              // 收集写入与大总结延后的 AI 楼层数
    autoHealAnchor: true,        // 自动重置锚点:检测到总结数据丢失(世界书被删/总结条目被清空)时自动重置总结锚点
    bookName: '',                // 世界书名,留空则自动「<角色名>-摘要」
    template: DEFAULT_TEMPLATE,  // 大总结提示词模板

    // —— 大总结独立 API 接入(v0.4.0:随主插件 / 自定义API 两种模式)——
    apiMode: 'current',          // 'current' 随主插件(跟随酒馆当前激活连接) | 'custom' 自定义API(插件内自填端点/密钥/模型,经酒馆后端转发)
    customEndpoint: '',          // 自定义API:端点(裸域名自动补 /v1)
    customApiKey: '',            // 自定义API:API 密钥(仅存本机酒馆 settings.json)
    customModel: '',             // 自定义API:模型名
    customRawUrl: false,         // 自定义API:地址原样使用(不自动补 /v1)
    apiPresets: [],              // 自定义API 存档 [{name, endpoint, apiKey, model, rawUrl}]
    maxTokens: 2048,             // 大总结输出预算(自定义API 模式生效)
    apiTimeoutSec: 120,          // 大总结请求超时秒数(0 = 不限时);超时释放重试锁并报错
};
