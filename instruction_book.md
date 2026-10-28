# 摘要收集器维护文档(instruction_book)

> **版本基线**:插件 v1.3.0,基于 SillyTavern `release` 分支 1.19.0(commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`,2026-10-25 克隆到本工作区 `../SillyTavern/`)。所有接口均在该源码中核对过行号,升级酒馆后请按 §5.1 重新核对。
> **实机验证**:2026-10-25 已在内置浏览器 + 模拟 LLM(OpenAI 兼容,`tests/mock-llm-server.mjs`)环境下完成 10 楼全流程实测(v0.1.0)与大总结独立 API 四模式实测(v0.2.0),全部通过;报告见 `tests/实机测试报告-2026-10-25.md`。

---

## §1 架构现状

本插件是纯 UI 扩展(manifest 驱动,由酒馆扩展加载器以 ES Module 动态 import),以「事件监听 + 官方 API 读写」方式工作:

- 监听 `MESSAGE_RECEIVED` 等 5 个官方事件,零轮询;
- 世界书读写完全走酒馆自带缓存 `worldInfoCache`(`loadWorldInfo` 读 / `saveWorldInfo` 写);
- 角色挂载使用酒馆原生的**多附加世界书**机制(`world_info.charLore` → `extraBooks` 数组),与角色主世界书(`data.extensions.world`)互不干扰。

没有使用任何运行时 patch、原型改写或 fetch 拦截;没有 `unsafe.eval`,**逃生舱数量为 0**。

## §2 接口路线符合情况

### §2.1 使用的官方接口清单(附 ST 1.19 源码位置)

| 用途 | 接口 | 源码位置 |
| --- | --- | --- |
| 上下文 | `getContext()` | `public/scripts/st-context.js` |
| 楼层事件 | `event_types.MESSAGE_RECEIVED / MESSAGE_EDITED / MESSAGE_UPDATED / MESSAGE_SWIPED / CHAT_CHANGED` | `public/scripts/events.js`(枚举),发射点 `public/script.js` 3799/6691/8337/8405/10315/1723 |
| 静默生成 | `getContext().generateQuietPrompt({ quietPrompt })` | `public/script.js:3084`(对象参数;返回值兼容 string / [string, hashes] 两种形态) |
| 聊天元数据 | `getContext().chatMetadata` + `saveMetadataDebounced()` | st-context.js;`chat_metadata` 原始导出在 `public/script.js:454` |
| 扩展配置 | `getContext().extensionSettings` + `saveSettingsDebounced()` | st-context.js |
| 世界书读 | `getContext().loadWorldInfo(name)`(带 `worldInfoCache`,miss 时 POST `/api/worldinfo/get`) | `public/scripts/world-info.js:2036`;服务端 `src/endpoints/worldinfo.js` `/get` |
| 世界书写 | `getContext().saveWorldInfo(name, data, true)`(更新缓存 + POST `/api/worldinfo/edit` + 发射 `WORLDINFO_UPDATED`) | `public/scripts/world-info.js:4177`;服务端 `/edit` |
| 条目创建 | `createWorldInfoEntry(name, data)`(官方模板字段 + 自动分配 uid) | `public/scripts/world-info.js:4137`;字段默认值见同文件 `newWorldInfoEntryDefinition` |
| 附加挂载 | `charUpdateAddAuxWorld(character.avatar, bookName)`(追加进 `world_info.charLore` 的 `extraBooks` 并 `saveSettingsDebounced`) | `public/scripts/world-info.js:6134` |
| 挂载读取 | `world_info.charLore` + `getCharaFilename(chid)` | world-info.js;`public/scripts/utils.js:1342` |
| 列表刷新 | `getContext().updateWorldInfoList()`(新建书后刷新下拉列表) | `public/scripts/world-info.js:2061` |
| 编辑器实时刷新 | `getContext().reloadWorldInfoEditor?.(bookName)`(每次写世界书后调用;仅当编辑器正打开该书时刷新,防旧快照覆盖) | world-info.js `reloadEditor(file, loadIfNotSelected)`;st-context 暴露为 `reloadWorldInfoEditor` |
| 条目位置 | `world_info_position.before = 0` | `public/scripts/world-info.js:855` |
| 酒馆预设(系统提示词来源) | 列表/读取:`getContext().getPresetManager('openai')` → `getPresetList()` / `getCompletionPresetByName(name)`;真实顺序:`preset.prompt_order`(优先 character_id 100001,兼容 100000);块内容宏替换用 `getContext().substituteParams` | st-context.js;`public/scripts/preset-manager.js`(1.14/1.19 同签名);`prompt_order` 结构见 `public/scripts/openai.js` 预设保存逻辑 |
| 提示与确认 | 全局 `toastr`;`getContext().callGenericPopup / POPUP_TYPE / POPUP_RESULT` | st-context.js |
| 大总结·自定义API | 生成:`ChatCompletionService.processRequest(payload, {}, true, signal)`,payload 为 custom 源 + `custom_url` + `custom_include_headers` 显式 Bearer(**两版 `options` 参数均无默认值,必须显式传 `{}`**;signal=AbortSignal.timeout 用于超时中止);拉取模型:POST `/api/backends/chat-completions/status`(custom 源,服务端拼 `urlJoin(custom_url, '/models')`,custom 豁免缺密钥守卫,`custom_include_headers` 会覆盖默认 Authorization) | `public/scripts/custom-request.js`;服务端 `src/endpoints/backends/chat-completions.js` `/generate` 与 `/status` |
| 大总结·超时保护 | `AbortSignal.timeout(apiTimeoutSec*1000)` 传入 processRequest + `Promise.race` 兜底(随主插件模式无法中止酒馆请求,仅释放插件状态) | 浏览器原生 API |

### §2.2 Hook 之外的使用(非违规)

- **全局 `toastr`、全局 jQuery `$`**:酒馆页面自带;`toastr` 缺失时 toast.js 回退 console。
- **世界书注入生效原理**(无需干预,供维护理解):`getSortedEntries()` 收集全局/角色主/角色附加(`charLore.extraBooks`)/聊天/人格五类书,`sortFn = (a,b) => b.order - a.order` 即 **order 越大越靠前** —— 因此「摘要总结」order=101、「摘要收集」order=100,总结永远在收集上方(见 world-info.js:88 与 4709 `checkWorldInfo`)。
- **package.json**:仅声明 `"type": "module"` 供 Node 跑单测;酒馆扩展扫描只读 manifest.json,不受影响。

### §2.3 逃生舱登记

**无。** 未使用 `api.unsafe.eval`、未拦截 `fetch/XHR`、未调用酒馆私有/内部接口(上表全部为酒馆官方导出或官方服务端路由)。

## §3 项目架构

### §3.1 根文件

| 文件 | 职责 |
| --- | --- |
| `manifest.json` | 扩展清单(display_name / loading_order=102 / js / css / author / version / auto_update=false) |
| `index.js` | 根入口:轮询等待 `globalThis.SillyTavern.getContext` 就绪(最多 30s)→ 动态 `import('./src/plugin.js')` |
| `style.css` | 面板样式(依赖酒馆自带 inline-drawer / text_pole / menu_button) |
| `package.json` | 仅 `"type": "module"`,供 Node 运行 tests |
| `tests/extractor.test.mjs` | 提取器单测(21 项),`node tests/extractor.test.mjs` 运行,无外部依赖 |
| `tests/sysprompt.test.mjs` | 预设块单测(24 项):组装、prompt_order 还原、默认勾选分类、快照幂等、无快照兜底 |
| `tests/api-client.test.mjs` | 请求层单测(19 项):URL 规范化、请求体、错误链、模型列表 |

### §3.2 src/ 模块分工

| 模块 | 职责 | 依赖 |
| --- | --- | --- |
| `constants.js` | 默认配置、条目名/顺序、分隔符、默认模板 | 无 |
| `toast.js` | toastr 封装与回退 | constants |
| `extractor.js` | 纯函数:标签提取(多块取第一)、记录拼装、分隔符剥离、大总结清洗、指纹 | 无(可单测) |
| `settings.js` | 配置存取(v0.10.0 起存于 data/<用户>/user/files/summary-collector-config.json:读 GET /user/files/<name> 静态路由、写 POST /api/files/upload{name,data:base64} 防抖;旧 extension_settings 配置首载自动迁移并清空)与聊天运行时状态(chat_metadata) | st-context;src/endpoints/files.js(1.14/1.19 同契约) |
| `api-client.js` | 大总结独立 API 请求层(两种模式:current 随主插件 / custom 自定义API[自填端点/密钥/模型,经后端转发生成与拉取模型])、URL 规范化、cause 链错误展开;纯函数不依赖酒馆运行时可单测(连接配置文件方案已在 v0.4.0 移除,历史见 git v0.2.0/v0.3.0) | st-context(运行时经 `globalThis.SillyTavern.getContext()`) |
| `sysprompt.js` | 大总结系统提示词来源:列出/读取酒馆预设、按 `prompt_order` 还原真实块顺序、块默认勾选分类、挑选快照生成/回显、按快照组装(marker=落位槽,保 role、逐块宏替换)、身份头防污染;全部纯函数可单测;不使用 unsafe.eval | constants |
| `lorebook.js` | 世界书层:建书/建条目/多挂载/读写;互斥队列串行化所有写操作 | world-info、utils、st-context、settings |
| `summarizer.js` | 大总结:模板填充 → generateQuietPrompt → 写回;失败重入延后期 | st-context、settings、lorebook、extractor |
| `ui.js` | 设置面板(绑定输入、三个操作按钮、状态区) | settings、summarizer、lorebook |
| `plugin.js` | 总调度:绑定 5 个事件,实现「延后写入 → 阈值 → 延后总结」状态机 | 以上全部 |

### §3.3 加载时序与数据流

```
酒馆加载扩展 → index.js 轮询 SillyTavern.getContext → import src/plugin.js
  → registerSummaryCollector():初始化配置 → 绑定事件 → 构建面板

MESSAGE_RECEIVED(楼层 i)
  ├─ 楼层去重:meta.lastFloorIndex === i ? 不递增 : meta.ord += 1(继续/重生成同一楼只刷新)
  ├─ 提取:extractFloor(mes, {summaryTag, timeTag}) → 多块只取第一个
  │    ├─ 无摘要 → 从 pending 移除
  │    └─ 有摘要 → pending[i] = { ord, summary, time, fp };时间标签启用但缺时间 → toast 提醒
  ├─ commitDue():awaitingSummary=false 且 (ord - rec.ord ≥ delayFloors) 的记录
  │    → ensureAll()(建书+建条目+多挂载,群聊抛错跳过)→ appendRecords(记录间 <=>)
  │    → meta.count += n
  ├─ armIfNeeded():count ≥ threshold → awaitingSummary=true, summaryArmOrd=ord
  └─ runSummaryIfDue():awaitingSummary 且 ord - summaryArmOrd ≥ delayFloors
       → runSummary():读收集条目 → 填模板 → generateQuietPrompt → normalizeDigest
         → appendDigestAndClearCollection(总结追加、收集清空)→ count=0, awaitingSummary=false
         失败 → summaryArmOrd=ord(重新延后),现场保留自动重试

MESSAGE_EDITED / MESSAGE_UPDATED / MESSAGE_SWIPED(楼层 i)
  → 仅当 pending[i] 存在时刷新内容(延迟窗口 = swipe 宽限期);已写入的不回滚

CHAT_CHANGED → 初始化新聊天的 meta 结构 → 刷新面板状态
```

**运行时状态结构**(`chat_metadata.summary_collector`):`{ count, ord, pending: {楼层索引: {ord, summary, time, fp}}, awaitingSummary, summaryArmOrd, lastFloorIndex }`。

**互斥**:`lorebook.js` 内 `serialized()` 把所有「loadWorldInfo → 修改 → saveWorldInfo」串成 Promise 队列,防止连续楼层并发读改写互相覆盖。

## §4 与本体及依赖的职责边界

### §4.1 本体(酒馆)负责
消息收发与楼层事件、世界书文件存储(`/api/worldinfo`)、世界书注入排序与预算、多附加世界书挂载持久化(`settings.json`)、聊天 metadata 存档、LLM 连接与静默生成。

### §4.2 插件负责
标签提取与记录格式(`<=>` 分隔)、延后队列与防重复、阈值状态机、大总结模板与静默调用、设置面板、预设块挑选与快照。所有数据只写入三处用户数据:世界书 JSON、聊天 metadata 的 `summary_collector` 键、`data/<用户>/user/files/summary-collector-config.json`(插件配置与预设快照)。

### §4.3 边界原则
不修改酒馆任何文件;不拦截网络请求;不调用私有接口;不使用 `unsafe.eval`;写世界书只动 `摘要收集`/`摘要总结` 两个 `comment` 匹配的条目,用户对条目的其他修改(如手动改内容)不被覆盖(仅追加/清空两种操作);挂载只做追加,绝不取消用户已有挂载。

## §5 后续维护怎么下手

### §5.1 酒馆升级核对清单
1. `st-context.js` 的 `getContext()` 是否仍返回本表 §2.1 的键(尤其 `chatMetadata`、`loadWorldInfo`、`saveWorldInfo`、`generateQuietPrompt`);
2. `events.js` 事件枚举名是否变化;
3. `world-info.js`:`loadWorldInfo`/`saveWorldInfo`/`createWorldInfoEntry`/`charUpdateAddAuxWorld` 是否仍是导出;`world_info_position.before` 是否仍为 0;`sortFn` 是否仍是 `b.order - a.order`;
4. `worldinfo.js` 服务端 `/get`、`/edit` 路由请求体形状是否变化;
5. 跑 `node tests/extractor.test.mjs`(提取逻辑与酒馆无关,应恒绿)。

### §5.2 改默认标签 / 分隔符 / 阈值 / 模板
全部在 `src/constants.js` 的 `DEFAULTS` 与 `DEFAULT_TEMPLATE`。注意:改默认值不影响已保存过配置的用户(设置面板已写盘);`{{收集内容}}` 占位符名改动需同步 `CONTENT_PLACEHOLDER`。

### §5.3 改记录格式(如「时间 - 摘要」拼法)
`extractor.js` 的 `buildRecord`(拼装)与 `plugin.js`(调用);分隔符解析在 `lorebook.js` 的 `splitRecords/joinRecords`(按"独占一行且 trim 后等于分隔符"识别)。改格式后旧数据兼容性自行评估,`splitRecords` 对旧格式数据是自愈的。

### §5.4 改世界书写入
全部在 `lorebook.js`;写操作必须经 `withBook`(互斥),新增条目必须走 `createWorldInfoEntry` 以获得合法 uid 与官方模板字段。条目识别键是 `comment === '摘要收集' / '摘要总结'`,不要改常量名 `COLLECT_ENTRY / DIGEST_ENTRY`。

### §5.5 改延后 / 阈值状态机
在 `plugin.js`:`onMessageReceived` 中的 `commitDue → armIfNeeded → runSummaryIfDue` 顺序不要打乱;`pending` 必须随聊天存档(不能挪到内存变量),否则刷新丢队列。

### §5.6 改预设块挑选 / 快照
全部在 `sysprompt.js` + `ui.js` 的预设区块:
- 读预设与真实顺序:`getPresetByName` / `readPresetOrderedBlocks`(prompt_order 选择规则见函数注释;`MARKER_IDS` 是插槽白名单);酒馆若改预设结构,先核对这里的字段名。
- 默认勾选:`classifyBlock`(DROP_NAME / KEEP_NAME 两张正则 + 变量初始化/预填/回显规则)。改规则只影响"下次打开清单时的预勾选",不会改已保存的快照。
- 快照结构:`{ items: [{kind:'marker',identifier,name} | {kind:'text',identifier,name,role,content}], curatedAt }`,存于 `settings.sysPromptPresetSnapshots[预设名]`。快照**冻结正文**,这是"改酒馆预设不影响已保存结果"的实现基础 —— 不要改成只存 identifier。
- 回显:`curationRowsFromSnapshot` 保证"打开→原样保存"幂等;改动这里必须跑 `tests/sysprompt.test.mjs` 的幂等用例。
- 组装:`assembleMessages`(统一处理快照条目与原始块);无快照时 `buildSystemMessages` 用 `buildCurationRows + snapshotFromRows` 实时兜底,保证不会空转。

### §5.7 排障入口
- **世界书编辑器快照覆盖(高危场景)**:用户在世界书编辑器里打开着本书时,插件写入会即时刷新编辑器(v0.5.0 起);但若在插件写入后、编辑器刷新前,用户手动编辑并保存了旧内容,仍可能覆盖。排障时优先检查编辑器是否长时间开着本书。
- 面板不出现:`index.js` 轮询超时(30s)或 `#extensions_settings2` 缺失;**模块加载失败时面板整个消失,用页面控制台看 `[摘要收集器]` 错误**(v0.5.0 曾因 ui.js 误从 plugin.js 导入 runSummary 导致整图加载失败,修复于同一版本)。
- 楼层无反应:确认面板「启用」、摘要标签拼写、`git -C SillyTavern status` 是否为空(插件是否真装在扩展目录);
- 世界书没创建/没挂载:`lorebook.js ensureAll()` 的群聊守卫与 `charUpdateAddAuxWorld`;附加失败已降级为警告,看 console;
- 大总结一直失败:看 console / toastr 错误;失败时会 toast 并重新进入延后期,现场(收集条目+计数)不丢;
- 注入没生效:世界书面板确认两蓝灯条目仍启用、角色附加列表里有本书;`order` 是否仍满足 总结(101) > 收集(100);
- 二次大总结不触发(历史问题):v0.5.0 起 count 以收集条目实际记录数为准(commit 后重数),状态失真自动自愈;若仍复现,抓 console 的 `[摘要收集器]` 日志。

## §6 最小回归测试清单

1. 用 README/需求中的 AI 回复样例(含 `<dream_summary>`):提取内容、记录格式、`<=>` 分隔正确;含两个摘要块的楼层只取第一个。
2. 无摘要标签楼层:跳过、不计数。
3. 时间标签启用但无内容:toast 提醒,记录仅含摘要;时间标签留空:无提醒。
4. 延后验证:提取到摘要的楼层,延后 N 个 AI 楼层内不出现在收集条目,满 N 楼后出现;窗口内 swipe → 写入最新内容。
5. 阈值调小(如 3):大总结延后 N 楼触发,「时间 - 事情」追加进总结条目,收集条目清空、计数归零。
6. 已写入楼层再 swipe:记录不回滚、不重复记账。
7. 刷新页面/切换聊天:计数、pending 与世界书内容持久;配置与预设快照随 `user/files/summary-collector-config.json` 持久。
8. 手动「立即大总结」「清空收集」(有确认弹窗)。
9. 系统提示词来源:自己写提示词 → 请求首条为身份头、次条为自定义文本;接预设 → 首次选择弹清单、保存后请求按快照顺序带块、marker 不产出消息、改酒馆预设不影响已保存快照、重新挑选回显上次勾选。
10. `git -C SillyTavern status` 全程为空(零侵入)。
