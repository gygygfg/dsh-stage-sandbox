window.__ModuleLoader__.load({
  id: "dsh-winstage-sandbox",
  factory(require2) {
    const React = require2("react");
    const h = React.createElement;
    const NAMESPACE = "winstage-sandbox";
    const LOCALE_NS = "settings.winstage";
    const COMPOSER_PRIORITY = 20;
    const PERMISSION_PRIORITY = -10;
    const COMPOSER_FALLBACK_UNHIDE_SELECTOR = '[data-chain-overlay-fallback="conversation.composer"]';
    const COMPOSER_FALLBACK_UNHIDE_CSS = `${COMPOSER_FALLBACK_UNHIDE_SELECTOR}{display:block !important;}`;
    const POLL_MS = 1500;
    const dicts = {
      zh: {
        title: "WinStage \u6C99\u7BB1",
        /**
         * ── R11-C 修复轮 · M6：把"运行期 vs 装配期"写进界面（原来一字未提）────────────
         * 实测现状（`docs/插件启动-环境监测与开关保证.md:40-41` 明说是既定差异）：
         *   · **文件面**（写文件工具）现读开关 ⇒ 关掉**立即**生效；
         *   · **命令面**（pwsh 工具）的提供方在**加载期**选定（两个 provider 不能共存、热切换会崩宿主）
         *     ⇒ 关掉后**必须重启宿主**才交还平台 shell。
         * 旧文案只说"关闭即卸载暂存与审阅面"，用户会以为命令面也立刻变了 ⇒ M3/M6 的核心误解。
         * 新文案把两条时延分开写清，并给出"怎么确认"。
         */
        description: "\u542F\u7528 Windows \u6682\u5B58\u2014\u5019\u9009\u2014\u9009\u62E9\u6027\u63D0\u4EA4\u6C99\u7BB1\u3002\u5173\u95ED\u540E\uFF1A**\u6587\u4EF6\u5DE5\u5177\uFF08\u5199\u6587\u4EF6\uFF09\u7ACB\u5373\u9000\u56DE**\u5E73\u53F0\u81EA\u5E26\u7684\u6C99\u7BB1/\u5BA1\u6279\u6A21\u5F0F\uFF1B**\u547D\u4EE4\uFF08pwsh\uFF09\u9700\u8981\u91CD\u542F\u5BBF\u4E3B\u540E**\u624D\u4EA4\u8FD8\u5E73\u53F0 shell\uFF08\u547D\u4EE4\u9762\u7684\u63D0\u4F9B\u65B9\u5728\u52A0\u8F7D\u671F\u9009\u5B9A\uFF0C\u4E0D\u80FD\u70ED\u5207\u6362\uFF09\u3002\u4E0D\u786E\u5B9A\u5F53\u524D\u751F\u6548\u54EA\u4E00\u4FA7\u65F6\uFF0C\u8DD1 /winstage status \u770B\u6743\u5A01\u7ED3\u8BBA\u3002",
        on: "\u5DF2\u542F\u7528",
        off: "\u5DF2\u5173\u95ED",
        unavailable: "Host \u672A\u63D0\u4F9B\u8BE5\u8BBE\u7F6E\u9879",
        // ── R12 修复 · D7-c/d：状态词与**实际生效档**对齐（配置值 / 生效值分列）────────
        // R11 实测：行内写 `已关闭`，而同一宿主里 pwsh 的写入确实进了暂存（TS 在跑）；
        // 进程级 `WINSTAGE_SHELL=1` 这个覆盖在界面上完全不可见。
        effectivePrefix: "\u5F53\u524D\u751F\u6548\uFF1A",
        effectiveOn: "WinStage \u63A5\u7BA1\u4E2D",
        effectiveOff: "\u5E73\u53F0\u9762",
        forcedPrefix: "\u5F53\u524D\u7531\u73AF\u5883\u53D8\u91CF\u5F3A\u5236\uFF1A",
        forcedHint: "\u8FDB\u7A0B\u7EA7\u73AF\u5883\u53D8\u91CF WINSTAGE_SHELL \u7684\u4F18\u5148\u7EA7\u9AD8\u4E8E\u672C\u884C\u5F00\u5173\uFF0C\u56E0\u6B64\u8FD9\u4E00\u884C\u7684\u5F00\u5173\u6B64\u523B\u4E0D\u6539\u53D8\u5B9E\u9645\u751F\u6548\u6863\u3002\u8981\u770B\u6743\u5A01\u7ED3\u8BBA\u8BF7\u8DD1 /winstage status\uFF1B\u8981\u771F\u6B63\u4EA4\u8FD8\u5E73\u53F0\uFF0C\u8BF7\u7528 WINSTAGE_SHELL=0 \u91CD\u542F\u5BBF\u4E3B\u3002",
        /**
         * ── R13 修复 · D7-b/D7-d：**把两张脸分开说** ─────────────────────────────
         * 实测（R13 GUI 复核）：`enabled:false` + `WINSTAGE_SHELL=1` 时
         * **文件面（fs 暂存/候选）确实关着**、**命令面（pwsh）确实被 shim 接管**。
         * 旧文案把两张脸混成一句（"已关闭 · 当前由环境变量强制：平台面 · 强制 WinStage 接管"），
         * 自相矛盾。现在文件面与命令面各自成句，且**各自的判据**都来自宿主快照的两面字段。
         */
        faceFileOn: "\u6587\u4EF6\u9762\uFF08\u6682\u5B58/\u5019\u9009\uFF09\uFF1A\u5DF2\u542F\u7528",
        faceFileOff: "\u6587\u4EF6\u9762\uFF08\u6682\u5B58/\u5019\u9009\uFF09\uFF1A\u5DF2\u5173\u95ED",
        faceShellEnvOn: "\u547D\u4EE4\u9762\uFF08pwsh\uFF09\uFF1A\u7531 WINSTAGE_SHELL=1 \u5F3A\u5236\u63A5\u7BA1",
        faceShellEnvOff: "\u547D\u4EE4\u9762\uFF08pwsh\uFF09\uFF1A\u7531 WINSTAGE_SHELL=0 \u5F3A\u5236\u4EA4\u8FD8\u5E73\u53F0 shell",
        faceShellFollow: "\u547D\u4EE4\u9762\uFF08pwsh\uFF09\uFF1A\u8DDF\u968F\u5F00\u5173\uFF08\u6362\u63D0\u4F9B\u65B9\u9700\u91CD\u542F\u5BBF\u4E3B\uFF09",
        toggleAccepted: "\u672C\u6B21\u5F00\u5173\u5DF2\u5199\u5165\uFF08\u751F\u6548\u65F6\u673A\u89C1\u4E0A\u9762\u7684\u8BF4\u660E\uFF09\u3002",
        toggleRejected: "\u672C\u6B21\u5F00\u5173\u672A\u5199\u5165\uFF1A\u8BBE\u7F6E\u901A\u9053\u62D2\u7EDD\u4E86\u8FD9\u6B21\u4FEE\u6539\uFF08\u672C\u884C config \u53EF\u80FD\u88AB profile \u8986\u76D6\u5C42\u56FA\u5B9A\uFF09\u3002\u53EF\u6838\u5BF9 %DSH_HOME%\\profiles\\<profile>\\cordis.patch.yml\u3002",
        toggleThrew: "\u672C\u6B21\u5F00\u5173\u51FA\u9519\uFF1A",
        /**
         * R11-C 修复③（D1b）：旧文案是 `写入失败，已保留原值` —— 它只说了**值**的结局，
         * 却让用户以为"磁盘什么都没发生"。实测：同一个交互把
         * `%DSH_HOME%\profiles\web\cordis.patch.yml` 重写了（1236→1234 B、mtime 变化、
         * `name` 的引号风格被打平；`enabled`/`workspaceRoot` 语义未漂移）。
         * ⇒ 新文案把两件事**分开说清**：值没生效 + 文件可能已被重新序列化（附查看方式），
         * 并提示该 profile 可能被多个宿主共享（并发写风险）。
         */
        error: '\u8BBE\u7F6E\u503C\u672A\u751F\u6548\uFF1A\u5DF2\u4FDD\u7559\u539F\u503C\uFF08\u672C\u884C config \u88AB\u8986\u76D6\u5C42/\u73AF\u5883\u53D8\u91CF\u56FA\u5B9A\uFF09\u3002\u6CE8\u610F\uFF1A\u6B64\u6B21\u4EA4\u4E92\u53EF\u80FD\u5DF2\u628A profile \u6587\u4EF6\u91CD\u65B0\u5E8F\u5217\u5316\u5199\u5165\uFF08\u4EC5\u683C\u5F0F\u89C4\u8303\u5316\uFF0C\u952E\u503C\u8BED\u4E49\u4E0D\u53D8\uFF09\u2014\u2014\u53EF\u6838\u5BF9 %DSH_HOME%\\profiles\\<profile>\\cordis.patch.yml \u7684\u4FEE\u6539\u65F6\u95F4\u4E0E sha256\uFF1B\u540C\u4E00 profile \u82E5\u88AB\u591A\u4E2A\u5BBF\u4E3B\u5171\u7528\uFF0C\u8BF7\u907F\u514D\u5E76\u53D1\u6539\u52A8\u3002**\u672C\u63D2\u4EF6\u65E0\u6CD5\u56DE\u6EDA\u6587\u4EF6\u5B57\u8282**\uFF1A\u8BBE\u7F6E\u901A\u9053\u53EA\u9001\u952E\u503C\uFF0C\u5BA2\u6237\u7AEF\u62FF\u4E0D\u5230\u5199\u524D\u7684\u6587\u4EF6\u5185\u5BB9\uFF0C\u56E0\u6B64"\u5199\u5165\u524D\u5FEB\u7167 + \u5931\u8D25\u56DE\u6EDA"\u5FC5\u987B\u7531\u5BBF\u4E3B\u4FA7\u8BBE\u7F6E\u5C42\u5B9E\u73B0\u3002',
        loading: "\u8BFB\u53D6\u4E2D\u2026",
        reviewTitle: "WinStage \u6682\u5B58\u5F85\u5BA1",
        reviewWaiting: "\u7B49\u5F85\u4F60\u6279\u51C6\u540E\u624D\u5199\u5165\u771F\u5B9E\u5DE5\u4F5C\u533A",
        reviewFiles: "{files} \u4E2A\u6587\u4EF6",
        reviewCounts: "+{added} / \u2212{removed}",
        noDiff: "\uFF08\u65E0\u5DEE\u5F02\u5185\u5BB9\uFF09",
        groupInside: "\u5DE5\u4F5C\u533A\u5185",
        // ── R11-C 修复轮 · M5：沙箱自身副作用/临时探针的折叠区（默认收起）───────────
        // 实测：一次"写两个文件 + pwd"产生 14 条候选，其中 10 条是 PowerShell 的
        // `__PSScriptPolicyTest_*` 探针、外加 `shim.log`（+1466 行）⇒ 真正的成果被淹没。
        noiseBadge: "\u6298\u53E0",
        noiseSummary: "{count} \u9879\u6C99\u7BB1\u81EA\u8EAB\u526F\u4F5C\u7528/\u4E34\u65F6\u63A2\u9488\uFF08\u5DF2\u6298\u53E0\uFF1B\u53EF\u5C55\u5F00\uFF09\xB7 \u672C\u6B21\u5DE5\u4F5C\u6210\u679C {work} \u9879",
        noiseHint: "\u8FD9\u4E9B\u662F\u6C99\u7BB1/ PowerShell \u81EA\u8EAB\u7684\u526F\u4EA7\u7269\uFF08AppLocker \u63A2\u9488\u3001\u57AB\u7247\u65E5\u5FD7\u7B49\uFF09\uFF0C\u4E0D\u662F\u4F60\u7684\u5DE5\u4F5C\u6210\u679C\uFF1B\u5B83\u4EEC\u4ECD\u53EF\u52FE\u9009\u3001\u53EF\u6279\u51C6\uFF0C\u53EA\u662F\u9ED8\u8BA4\u4E0D\u5360\u7528\u4E3B\u5217\u8868\u3002",
        groupOutside: "\u5DE5\u4F5C\u533A\u5916",
        groupSensitive: "\u654F\u611F",
        // S3i：等级徽章与面板标题条的分级文案
        levelL1: "L1",
        levelL2: "L2",
        levelL3: "L3",
        reviewLevels: "{files} \u4E2A\u6587\u4EF6\uFF08{levels}\uFF09",
        badgeOutside: "\u5DE5\u4F5C\u533A\u5916",
        badgeSensitive: "\u654F\u611F",
        badgeDanger: "\u5371\u9669",
        summaryOutside: "{count} \u4E2A\u5728\u5DE5\u4F5C\u533A\u5916",
        summarySensitive: "{count} \u4E2A\u654F\u611F",
        summaryDanger: "{count} \u4E2A\u5371\u9669",
        riskReason: "\u539F\u56E0\uFF1A{reason}",
        riskReasonUnknown: "\u547D\u4E2D\u654F\u611F\u7B56\u7565",
        riskCheckHint: "{path}\uFF08\u9AD8\u98CE\u9669\u9879\uFF1A\u9700\u663E\u5F0F\u52FE\u9009\u624D\u4F1A\u88AB\u6279\u51C6\uFF09",
        approveAllScope: "\u300C\u6279\u51C6\u5168\u90E8\u300D= \u5168\u90E8\u5DE5\u4F5C\u533A\u5185\u7684\u666E\u901A\u9879 + \u4F60\u5DF2\u52FE\u9009\u7684\u5DE5\u4F5C\u533A\u5916/\u654F\u611F\u9879\uFF1B\u672A\u52FE\u9009\u7684\u9AD8\u98CE\u9669\u9879\u4E0D\u4F1A\u88AB\u5199\u5165\u3002",
        alertTitle: "\u26A0 {count} \u9879\u5371\u9669\u6539\u52A8",
        alertHint: "\u6B64\u63D0\u793A\u4E0D\u963B\u65AD\u4EFB\u4F55\u64CD\u4F5C\uFF0C\u6279\u51C6/\u62D2\u7EDD\u4ECD\u53EF\u7EE7\u7EED\u3002",
        chipLabel: "WinStage \u5F85\u5BA1 \xB7 {files}",
        // S3h：分级数量。L1 = 工作区内，L2 = 工作区外，L3 = 敏感；`danger` 是 L3 里更严的子档
        chipLabelLevels: "WinStage \u5F85\u5BA1 \xB7 {files}\uFF08{levels}\uFF09",
        chipL1: "L1 {count}",
        chipL2: "L2 {count}",
        chipL3: "L3 {count}",
        chipDanger: "\u5371\u9669 {count}",
        chipTitle: '\u5C55\u5F00\u5BA1\u9605\u9762\u677F\uFF08\u8FD9\u4E00\u7248\u5FEB\u7167\u5DF2\u6536\u8D77\uFF1B\u70B9\u8FD9\u91CC\u5373\u53EF\u6062\u590D\uFF09\n\u5206\u7EA7\uFF1AL1 = \u5DE5\u4F5C\u533A\u5185 \xB7 L2 = \u5DE5\u4F5C\u533A\u5916 \xB7 L3 = \u654F\u611F\uFF08"\u5371\u9669"\u662F L3 \u91CC\u66F4\u4E25\u7684\u5B50\u6863\uFF09\u3002\u6570\u5B57\u4E3A\u5168\u91CF\u8BA1\u6570\uFF0C\u5E26 + \u8868\u793A\u5217\u8868\u5DF2\u622A\u65AD\u3002',
        defaultCollapsedOn: "\u9ED8\u8BA4\u6536\u8D77\uFF1A\u5F00",
        defaultCollapsedOff: "\u9ED8\u8BA4\u6536\u8D77\uFF1A\u5173",
        defaultCollapsedHint: "\u5F00\u542F\u540E\u53EA\u5728\u9875\u9762\u52A0\u8F7D\u540E\u7684\u7B2C\u4E00\u7248\u5F85\u5BA1\u5FEB\u7167\u4E0A\u9ED8\u8BA4\u6536\u8D77\uFF1B\u4E4B\u540E\u5404\u8F6E\u7684\u65B0\u5FEB\u7167\u6309\u4F60\u7684\u624B\u52BF\u8D70\uFF08chip \u53EF\u968F\u65F6\u6536\u8D77/\u5C55\u5F00\uFF09",
        consentStale: "\u6709 {count} \u9879\u6863\u4F4D\u5DF2\u53D8\u5316\uFF0C\u9700\u91CD\u65B0\u52FE\u9009\u540E\u624D\u4F1A\u88AB\u6279\u51C6",
        dangerHidden: "\u5185\u5BB9\u5DF2\u6309\u654F\u611F\u7B56\u7565\u7701\u7565",
        confirmTitle: "{count} \u9879\u547D\u4E2D\u654F\u611F\u7B56\u7565\uFF0C\u9700\u8981\u4E8C\u6B21\u786E\u8BA4",
        confirmBody: "\u6279\u51C6\u4F1A\u628A\u6682\u5B58\u5185\u5BB9\u5199\u5165\u771F\u5B9E\u78C1\u76D8\uFF0C\u4E14\u4E0D\u53EF\u64A4\u9500\u3002\u8BF7\u9010\u6761\u786E\u8BA4\u540E\u679C\u540E\u518D\u5199\u5165\u3002",
        confirmReason: "\u547D\u4E2D\uFF1A{reason}",
        confirmDanger: "\u5371\u9669\u6863\uFF1A\u53EF\u80FD\u662F\u51ED\u636E/\u5BC6\u94A5\u6216\u6C99\u7BB1\u81EA\u8EAB\u5B58\u50A8\uFF0C\u843D\u76D8\u540E\u53EF\u80FD\u88AB\u540E\u7EED\u64CD\u4F5C\u8BFB\u53D6\u6216\u8986\u76D6\u3002",
        confirmAccept: "\u6211\u4E86\u89E3\u540E\u679C\uFF0C\u786E\u8BA4\u5199\u5165",
        confirmCancel: "\u53D6\u6D88",
        nothingToApprove: "\u6CA1\u6709\u53EF\u6279\u51C6\u7684\u9879\uFF1A\u5171 {total} \u9879\uFF0C\u5176\u4E2D {frozen} \u9879\u4EC5\u5B58\u6863\uFF08\u4E0D\u53EF\u6279\u51C6\uFF09\u3001{risky} \u9879\u9AD8\u98CE\u9669\u672A\u52FE\u9009\u6216\u6863\u4F4D\u5DF2\u53D8\uFF08\u9700\u91CD\u65B0\u52FE\u9009\uFF09",
        noSession: "\u5F53\u524D\u6CA1\u6709\u4F1A\u8BDD\u8EAB\u4EFD\uFF0C\u547D\u4EE4\u672A\u6267\u884C\uFF08\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5\uFF09",
        commandNoOp: "\u547D\u4EE4\u672A\u4EA7\u751F\u4EFB\u4F55\u53D8\u5316\uFF08\u5BBF\u4E3B\u672A\u8FD4\u56DE\u539F\u56E0\uFF09",
        unknownCommand: "\u547D\u4EE4\u672A\u88AB\u6267\u884C\uFF1A\u5BBF\u4E3B\u6CA1\u6709\u8BC6\u522B\u8BE5\u547D\u4EE4\uFF08\u672C\u6B21\u6CA1\u6709\u4EFB\u4F55\u6539\u52A8\u843D\u5730\uFF09",
        rowFailed: "\u6B64\u6761\u5931\u8D25\uFF1A{message}",
        commandTimeout: "\u547D\u4EE4\u8D85\u65F6\uFF08\u5BBF\u4E3B {seconds} \u79D2\u672A\u54CD\u5E94\uFF09\uFF0C\u672C\u6B21\u672A\u6267\u884C\uFF1B\u8BF7\u91CD\u8BD5\uFF08\u8BE5\u6761\u4ECD\u5F85\u5BA1\uFF09",
        // D1：冻结存档行（`frozenOnly`）—— 路径已不在当前净 diff，只显示、**不可批准**
        frozenBadge: "\u5B58\u6863",
        frozenReclaimed: "\u5DF2\u4E0D\u5728\u5F53\u524D\u51C0 diff\uFF1A\u6682\u5B58\u5185\u5BB9\u5DF2\u88AB\u56DE\u6536\uFF0C\u65E0\u6CD5\u518D\u6279\u51C6",
        frozenNoOp: "\u5DF2\u4E0D\u5728\u5F53\u524D\u51C0 diff\uFF1A\u8BE5\u6539\u52A8\u5BF9\u771F\u5B9E\u78C1\u76D8\u6CA1\u6709\u51C0\u53D8\u5316\uFF08\u4F8B\u5982\u5220\u9664\u4E00\u4E2A\u672C\u5C31\u4E0D\u5B58\u5728\u7684\u6587\u4EF6\uFF09\uFF0C\u65E0\u6CD5\u518D\u6279\u51C6",
        frozenNoNetChange: "\u5DF2\u4E0D\u5728\u5F53\u524D\u51C0 diff\uFF1A\u6682\u5B58\u5185\u5BB9\u5DF2\u88AB\u53D6\u4EE3\uFF0C\u65E0\u6CD5\u518D\u6279\u51C6",
        frozenSummary: "{count} \u9879\u5DF2\u4E0D\u5728\u5F53\u524D\u51C0 diff\uFF08\u4EC5\u5B58\u6863\uFF0C\u4E0D\u53EF\u6279\u51C6\uFF09",
        baselineStale: "\u57FA\u7EBF\u5DF2\u8FC7\u671F",
        // 缺陷②（F5b）：这三条解释**为什么**过期。旧文案说"系统会自动重新对齐、无需手动操作"
        // —— 那正是丢数据的那条路径（自动对齐把外部写入变成可批准的 diff）。
        // 现在：不会自动对准有内容丢失风险的漂移，因此必须给出显式出路。
        baselineStaleAppeared: '\u771F\u5B9E\u6587\u4EF6\u5728\u6682\u5B58\u4E4B\u540E\u51FA\u73B0\uFF08\u57FA\u7EBF\u672C\u4E3A"\u4E0D\u5B58\u5728"\uFF09',
        baselineStaleDeleted: "\u771F\u5B9E\u6587\u4EF6\u5728\u6682\u5B58\u4E4B\u540E\u88AB\u5916\u90E8\u5220\u9664",
        baselineStaleDrifted: "\u771F\u5B9E\u6587\u4EF6\u5728\u6682\u5B58\u4E4B\u540E\u88AB\u5916\u90E8\u6539\u5199",
        baselineStaleTitle: "\u771F\u5B9E\u6587\u4EF6\u5728\u6682\u5B58\u4E4B\u540E\u88AB\u5916\u90E8\u6539\u52A8\u8FC7\uFF08\u624B\u518C #12.1\uFF09\u3002\u6279\u51C6\u5DF2\u88AB\u62D2\u7EDD\uFF0C\u771F\u5B9E\u78C1\u76D8\u4E0A\u7684\u5185\u5BB9\u4E0D\u4F1A\u88AB\u8986\u76D6\u3002\u51FA\u8DEF\uFF1A\u7528\u300C\u91CD\u65B0\u5BF9\u9F50\u57FA\u7EBF\u300D/\u300C\u91CD\u65B0\u5BF9\u9F50\u5E76\u6279\u51C6\u6240\u9009\u300D\uFF0C\u6216 /winstage rebase\uFF1B\u4E22\u5F03\u8FD9\u4EFD\u6682\u5B58\u7528\u300C\u62D2\u7EDD\u300D\u3002",
        staleSummary: "{count} \u9879\u57FA\u7EBF\u5DF2\u8FC7\u671F\uFF08\u771F\u5B9E\u6587\u4EF6\u5728\u6682\u5B58\u4E4B\u540E\u88AB\u5916\u90E8\u6539\u52A8\uFF09\uFF1A\u6279\u51C6\u4F1A\u88AB\u62D2\u7EDD\uFF0C\u4E0D\u4F1A\u9759\u9ED8\u8986\u76D6\u771F\u5B9E\u78C1\u76D8\uFF1B\u8BF7\u5148 rebase \u518D\u6279\u51C6\uFF0C\u6216\u62D2\u7EDD\u8FD9\u4EFD\u6682\u5B58",
        // Method A 主线：AI 进程树的文件/注册表读写分类统计（宿主 `sandbox-audit.json` 的摘要）
        auditSummary: "\u5BA1\u8BA1\uFF1A\u6587\u4EF6 \u8BFB{read} \u5199{write}\uFF08\u5DE5\u4F5C\u533A\u5185{inws}/\u5DE5\u4F5C\u533A\u5916{outside}\uFF09\u5220{deleted}\uFF1B\u6CE8\u518C\u8868 \u8BFB{rread} \u5199{rwrite}",
        rebaseAll: "\u91CD\u65B0\u5BF9\u9F50\u57FA\u7EBF",
        rebaseAndApprove: "\u91CD\u65B0\u5BF9\u9F50\u5E76\u6279\u51C6\u6240\u9009",
        permIdle: "WinStage \u6682\u5B58",
        permPending: "\u6682\u5B58\u5F85\u5BA1 {files}",
        permTitle: "WinStage \u6C99\u7BB1\uFF1A\u6587\u4EF6\u5199\u5165\u5148\u843D\u6682\u5B58\u3001\u6279\u51C6\u540E\u624D\u5199\u771F\u5B9E\u5DE5\u4F5C\u533A\uFF08\u5DF2\u66FF\u4EE3\u5E73\u53F0\u7684\u8BBF\u95EE\u6A21\u5F0F\u9009\u62E9\u5668\uFF09",
        permOpenPanel: "\u67E5\u770B\u5F85\u5BA1\uFF08{files}\uFF09",
        permRefresh: "\u5237\u65B0\u6682\u5B58\u5FEB\u7167",
        permRebase: "\u91CD\u65B0\u5BF9\u9F50\u57FA\u7EBF\uFF08{files} \u9879\u8FC7\u671F\uFF09",
        permDisable: "\u5173\u95ED WinStage \u6C99\u7BB1",
        permDisableHint: "\u5173\u95ED\u540E\u5199\u76D8\u9000\u56DE\u5E73\u53F0\u81EA\u5E26\u7684\u8BBF\u95EE\u6A21\u5F0F / \u5BA1\u6279",
        approveAll: "\u6279\u51C6\u5168\u90E8",
        approveSelected: "\u6279\u51C6\u6240\u9009",
        rejectAll: "\u62D2\u7EDD\u5168\u90E8",
        dismiss: "\u6682\u65F6\u6536\u8D77",
        selectAll: "\u5168\u9009",
        selectAllScope: "\u53EA\u9009\u62E9\u5DE5\u4F5C\u533A\u5185\u7684\u666E\u901A\u9879\uFF1B\u5DE5\u4F5C\u533A\u5916/\u654F\u611F\u9879\u9700\u9010\u9879\u52FE\u9009",
        clearSelection: "\u6E05\u7A7A\u9009\u62E9",
        opCreate: "\u65B0\u589E",
        opModify: "\u4FEE\u6539",
        opDelete: "\u5220\u9664",
        opMkdir: "\u65B0\u5EFA\u76EE\u5F55",
        busy: "\u5904\u7406\u4E2D\u2026",
        failed: "\u64CD\u4F5C\u5931\u8D25\uFF1A{message}",
        // ── WP3：可信性状态卡（面板侧；与 /winstage status 同一份 buildTrustCard）──────
        // 这里只显示**一句话结论**，六个面的细节仍在 /winstage status 里（面板不堆术语）。
        trustLabel: "\u53EF\u4FE1\u6027",
        trustTrusted: "\u6C99\u7BB1\u53EF\u4FE1\uFF08\u547D\u4EE4\u8D70\u53BB\u4EE4\u724C\u5316\u901A\u9053\uFF0C\u5199\u5165\u5148\u843D\u6682\u5B58\uFF09",
        trustAttention: "\u6C99\u7BB1\u53EF\u4FE1\uFF0C\u4F46\u6709 {count} \u7C7B\u5F85\u5904\u7406\u4E8B\u9879\uFF08\u8BE6\u89C1 /winstage status\uFF09",
        trustDegraded: "\u26A0 \u6C99\u7BB1**\u4E0D\u53EF\u4FE1**\uFF1A\u6863\u4F4D\u5DF2\u6389\u6863\uFF0C\u5199\u5165\u53EA\u5269\u5185\u6838\u786C\u62D2\uFF08\u8BE6\u89C1 /winstage status\uFF09",
        trustLost: "\u26A0 \u4F1A\u8BDD\u5DE5\u4F5C\u6839\u5DF2\u4E0D\u53EF\u7528\uFF1A\u5199\u5165\u4F1A\u5931\u8D25\uFF0C\u4E0D\u4F1A\u9759\u9ED8\u6539\u5199\u771F\u5B9E\u6587\u4EF6",
        // ── R11-C 修复②：以下四条只在"证据成立"时出现，避免把正常说成坏 ──────────────
        // `trustDegradedAction`：降档的**可见且可操作**版本（旧 `trustDegraded` 只说"不可信"，
        //   用户不知道该干什么；实测它还被 `lost` 顶掉，只能活在 12 px 灰字里）。
        trustDegradedAction: "\u26A0 \u6C99\u7BB1\u5DF2\u964D\u6863\uFF1A\u547D\u4EE4\u4E0D\u518D\u8D70\u900F\u660E\u57AB\u7247\u901A\u9053\uFF08\u6863\u4F4D {lane}\uFF09\uFF0C\u5199\u5165\u53EA\u5269\u5185\u6838\u786C\u62D2\u3002\u4E0B\u4E00\u6B65\uFF1A\u8DD1 /winstage status \u770B\u539F\u56E0\uFF1B\u82E5\u6CE8\u5165\u5668\u88AB\u5B89\u5168\u8F6F\u4EF6\u9694\u79BB\uFF0C\u8BF7\u628A shim\\out\\winstage-inject.exe \u52A0\u5165\u767D\u540D\u5355\u540E\u91CD\u542F\u5BBF\u4E3B\u3002",
        // ★ 实测发现的**第二处误导**：面板拿到的那份卡片里 `tier` 字段为空（宿主路由却有
        //   `tier.status="degraded"`）⇒ 面板既不知道降档、又拿着宿主的 `level:"lost"`，
        //   于是继续喊"写入会失败"。但同一时刻**写文件工具写出的候选完全正常**。
        //   ⇒ 判据不足时**不许断言**，只报可观察事实（"暂存写入此刻可用"）+ 自述判据不足。
        trustBaseUnverifiable: "\u26A0 \u6C99\u7BB1\u6863\u4F4D\u4FE1\u606F\u4E0D\u5B8C\u6574\uFF08\u9762\u677F\u62FF\u5230\u7684\u5361\u7247\u91CC\u6CA1\u6709\u6863\u4F4D\u5B57\u6BB5\uFF09\uFF1A**\u6682\u5B58\u5199\u5165\u6B64\u523B\u53EF\u7528**\uFF08\u5F85\u5BA1\u5019\u9009\u6B63\u5E38\u751F\u6210\uFF09\uFF1B\u662F\u5426\u5DF2\u964D\u6863\u65E0\u6CD5\u636E\u6B64\u5224\u5B9A\uFF0C\u8BF7\u8DD1 /winstage status \u770B\u6743\u5A01\u7ED3\u8BBA\u3002",
        // `trustLossNoise`：计数是**探测次数**，不是失败次数（实测 6 s 内 +4 线性上涨）。
        trustLossNoise: '\uFF08"\u5931\u6839 {count}"\u662F\u63A2\u6D4B\u8BA1\u6570\uFF0C\u4E0D\u662F\u5199\u5165\u5931\u8D25\u6B21\u6570\uFF0C\u4E14\u6BCF\u6B21\u67E5\u8BE2\u90FD\u4F1A +1\uFF1B\u672C\u6761\u4E0D\u5F71\u54CD\u5199\u5165\uFF09',
        trustRootLostAction: "\u4E0B\u4E00\u6B65\uFF1A\u8DD1 /winstage status \u770B\u662F\u54EA\u4E00\u6B65\u4E22\u4E86\u6839\uFF1B\u672A\u786E\u8BA4\u5199\u5165 > 0 \u65F6\u5148\u786E\u8BA4\u6682\u5B58\u5185\u5BB9\u518D\u6279\u51C6\u3002",
        trustWriteUnconfirmed: "\u26A0 \u6709\u5199\u5165\u672A\u786E\u8BA4\u843D\u76D8\uFF08\u8BE6\u89C1 /winstage status\uFF09",
        trustUnknown: '\u6C99\u7BB1\u6863\u4F4D\u672A\u77E5\uFF1A\u5C1A\u65E0\u5224\u5B9A\u8BB0\u5F55\uFF0C\u6309"\u672A\u8BC1\u5B9E\u5DF2\u751F\u6548"\u5BF9\u5F85',
        trustOff: "\u6C99\u7BB1\u5DF2\u5173\u95ED\uFF08\u5C5E\u9884\u671F\uFF09",
        trustSourceRoute: "\u8BFB\u53D6\u6765\u6E90\uFF1A\u5BBF\u4E3B\u8DEF\u7531\uFF08\u5B58\u50A8\u6839\u7531\u5BBF\u4E3B\u89E3\u6790\uFF09",
        trustSourceLegacy: "\u8BFB\u53D6\u6765\u6E90\uFF1A\u517C\u5BB9\u65E7\u5E03\u5C40\uFF08\u5BBF\u4E3B\u8DEF\u7531\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u542F\u5BBF\u4E3B\u8FDB\u7A0B\uFF09",
        trustDetail: "\u6863\u4F4D {lane} \xB7 \u6389\u6863 {degrades} \u6B21 \xB7 \u5931\u6839 {lost} \u6B21 \xB7 \u672A\u7ED3\u7B97\u5BA1\u6279 {approvals} \xB7 \u672A\u786E\u8BA4\u5199\u5165 {writes} \xB7 \u654F\u611F\u8BFB {reads} \xB7 \u5224\u636E\uFF1A\u5BBF\u4E3B level={hostLevel} \xB7 tierEffective={tierEff} \xB7 degraded={degraded} \xB7 \u5361\u6765\u6E90={tierSource}({tierAlt})"
      },
      en: {
        title: "WinStage Sandbox",
        description: "Enable the Windows staging\u2013candidate\u2013selective-commit sandbox. Turning it off: the **file tools switch back immediately** to the platform sandbox/approval mode; the **command side (pwsh) only hands back the platform shell after a host restart** (the shell provider is chosen at load time and cannot be hot-swapped). Run /winstage status to see which side is currently in effect.",
        on: "Enabled",
        off: "Disabled",
        unavailable: "This setting is not exposed by the Host",
        error: `The setting value did NOT take effect; the previous value was kept (this row's config is pinned by a profile overlay or an environment variable). Note: this interaction may still have re-serialized the profile file (formatting normalization only, no key/value change) \u2014 check the mtime and sha256 of %DSH_HOME%\\profiles\\<profile>\\cordis.patch.yml; if several hosts share that profile, avoid concurrent edits. **This plugin cannot roll file bytes back**: the settings transport only carries key/values, so a "pre-write snapshot + rollback on failure" must be implemented by the host-side settings layer.`,
        loading: "Loading\u2026",
        // R12 fix · D7-c/d: status words follow the EFFECTIVE tier (config vs effective split)
        effectivePrefix: "Currently effective: ",
        effectiveOn: "WinStage is intercepting",
        effectiveOff: "platform tier",
        forcedPrefix: "Currently forced by an environment variable: ",
        forcedHint: "The process-level WINSTAGE_SHELL variable outranks this row, so toggling this row does not change the effective tier right now. Run /winstage status for the authoritative answer; to really hand control back to the platform, restart the host with WINSTAGE_SHELL=0.",
        toggleAccepted: "The toggle was written (see the timing note above).",
        toggleRejected: "The toggle was NOT written: the settings channel rejected this change (this row may be pinned by a profile overlay). Check %DSH_HOME%\\profiles\\<profile>\\cordis.patch.yml.",
        toggleThrew: "The toggle failed: ",
        reviewTitle: "WinStage staged changes",
        reviewWaiting: "Nothing is written to the real workspace until you approve",
        reviewFiles: "{files} files",
        reviewCounts: "+{added} / \u2212{removed}",
        noDiff: "(no textual difference)",
        groupInside: "Inside workspace",
        noiseBadge: "folded",
        noiseSummary: "{count} sandbox-generated / temp probe item(s) (folded; expandable) \xB7 {work} real work item(s)",
        noiseHint: "These are by-products of the sandbox / PowerShell itself (AppLocker probes, shim logs). They stay tickable and approvable; they just no longer flood the main list.",
        groupOutside: "Outside workspace",
        groupSensitive: "Sensitive",
        levelL1: "L1",
        levelL2: "L2",
        levelL3: "L3",
        reviewLevels: "{files} files ({levels})",
        badgeOutside: "Outside",
        badgeSensitive: "Sensitive",
        badgeDanger: "DANGER",
        summaryOutside: "{count} outside",
        summarySensitive: "{count} sensitive",
        summaryDanger: "{count} danger",
        riskReason: "Reason: {reason}",
        riskReasonUnknown: "matched a sensitive policy",
        riskCheckHint: "{path} (high risk: approving requires ticking this box explicitly)",
        approveAllScope: '"Approve all" = every inside-workspace normal item + the outside/sensitive items you ticked; unticked high-risk items are never written.',
        alertTitle: "\u26A0 {count} dangerous change(s)",
        alertHint: "This notice blocks nothing; approve/reject remain available.",
        chipLabel: "WinStage pending \xB7 {files}",
        chipLabelLevels: "WinStage pending \xB7 {files} ({levels})",
        chipL1: "L1 {count}",
        chipL2: "L2 {count}",
        chipL3: "L3 {count}",
        chipDanger: "Danger {count}",
        chipTitle: 'Reopen the review panel (this snapshot was hidden; click to restore)\nLevels: L1 = inside workspace \xB7 L2 = outside workspace \xB7 L3 = sensitive ("Danger" is the stricter sub-tier of L3). Counts are the full totals; a trailing + means the list was truncated.',
        defaultCollapsedOn: "Default collapsed: on",
        defaultCollapsedOff: "Default collapsed: off",
        defaultCollapsedHint: "When on, only the first pending snapshot after page load starts collapsed; later snapshots follow your own collapse/expand (the chip reopens them)",
        consentStale: "{count} item(s) changed risk tier - tick them again to authorise",
        dangerHidden: "Content omitted by the sensitive policy",
        confirmTitle: "{count} item(s) hit the sensitive policy - confirm again to write",
        confirmBody: "Approving writes the staged content to the real disk and cannot be undone. Review each consequence before writing.",
        confirmReason: "Matched: {reason}",
        confirmDanger: "Danger tier: credentials/keys or the sandbox store itself; once written it can be read or overwritten by later operations.",
        confirmAccept: "I understand - write anyway",
        confirmCancel: "Cancel",
        nothingToApprove: "Nothing to approve: {total} item(s), of which {frozen} are archive-only (not approvable) and {risky} are un-ticked/risk-tier-changed high-risk items (re-tick them)",
        noSession: "No session identity on this panel - the command was not sent (refresh the page and retry)",
        commandNoOp: "The command changed nothing (the host returned no reason)",
        unknownCommand: "The command was not executed: the host did not recognise it (nothing was changed this time)",
        rowFailed: "This item failed: {message}",
        commandTimeout: "Command timed out (the host did not respond for {seconds}s); nothing was executed - retry (the item is still pending)",
        frozenBadge: "archive",
        frozenReclaimed: "no longer in the net diff: the staged content was reclaimed, so it cannot be approved",
        frozenNoOp: "no longer in the net diff: this change has no net effect on the real disk (e.g. deleting a file that never existed), so it cannot be approved",
        frozenNoNetChange: "no longer in the net diff: the staged content was superseded, so it cannot be approved",
        frozenSummary: "{count} item(s) are no longer in the net diff (archive only, not approvable)",
        baselineStale: "stale baseline",
        baselineStaleAppeared: 'the real file appeared after staging (the baseline was "absent")',
        baselineStaleDeleted: "the real file was deleted after staging",
        baselineStaleDrifted: "the real file was changed after staging",
        baselineStaleTitle: 'The real file changed after staging (manual #12.1). Approval is refused; the content on the real disk is not overwritten. Use "re-align baseline" / "re-align and approve selected", or /winstage rebase; reject to discard this staged change.',
        staleSummary: "{count} item(s) have a stale baseline (the real file changed after staging): approval is refused and the real disk is not overwritten; re-align the baseline first, or reject this staged change",
        // Method A main line: classified file/registry read/write counts of the AI process tree
        auditSummary: "Audit: files read {read}, written {write} (in-workspace {inws}/outside {outside}), deleted {deleted}; registry read {rread}, written {rwrite}",
        rebaseAll: "Rebase onto real file",
        rebaseAndApprove: "Rebase and approve selected",
        permIdle: "WinStage staging",
        permPending: "Staged {files}",
        permTitle: "WinStage sandbox: writes land in staging and reach the real workspace only after approval (replaces the platform access-mode selector)",
        permOpenPanel: "Review pending ({files})",
        permRefresh: "Refresh staging snapshot",
        permRebase: "Rebase onto real file ({files} stale)",
        permDisable: "Turn off WinStage sandbox",
        permDisableHint: "Turning it off returns file writes to the platform access mode / approval",
        approveAll: "Approve all",
        approveSelected: "Approve selected",
        rejectAll: "Reject all",
        dismiss: "Hide for now",
        selectAll: "Select all",
        selectAllScope: "Selects only inside-workspace normal items; outside/sensitive items must be ticked one by one",
        clearSelection: "Clear",
        opCreate: "create",
        opModify: "modify",
        opDelete: "delete",
        opMkdir: "mkdir",
        busy: "Working\u2026",
        failed: "Failed: {message}",
        // ── WP3 trust card (panel side; same buildTrustCard() as /winstage status) ──
        trustLabel: "Trust",
        trustTrusted: "Sandbox trusted (commands use the token-free channel; writes land in staging first)",
        trustAttention: "Sandbox trusted, with {count} kind(s) of open items (see /winstage status)",
        trustDegraded: "\u26A0 Sandbox NOT trusted: the lane fell back, writes are down to kernel denial (see /winstage status)",
        trustLost: "\u26A0 The session working root is unavailable: writes will fail instead of silently touching real files",
        trustDegradedAction: "\u26A0 Sandbox lane degraded: commands no longer use the transparent-shim channel (lane {lane}); writes are down to kernel denial. Next: run /winstage status for the cause; if the injector was quarantined by security software, allowlist shim\\out\\winstage-inject.exe and restart the host.",
        trustBaseUnverifiable: "\u26A0 Sandbox lane info is incomplete (the card this panel received has no lane fields): **staging writes work right now** (review candidates are being produced normally); whether the lane degraded cannot be decided from here \u2014 run /winstage status for the authoritative verdict.",
        trustLossNoise: '("root lost {count}" is a probe counter, not a write-failure count; it increments on every read and does not affect writes)',
        trustRootLostAction: "Next: run /winstage status to see which step lost the root; when unconfirmed writes > 0, verify staged content before approving.",
        trustWriteUnconfirmed: "\u26A0 A write was not confirmed on disk (see /winstage status)",
        trustUnknown: 'Sandbox lane unknown: no verdict recorded yet; treat as "not proven active"',
        trustOff: "Sandbox is off (expected)",
        trustSourceRoute: "Read via: host route (the host resolves the store root)",
        trustSourceLegacy: "Read via: legacy layout compatibility (host route unavailable; restart the host process)",
        trustDetail: "lane {lane} \xB7 degraded {degrades}\xD7 \xB7 root lost {lost}\xD7 \xB7 open approvals {approvals} \xB7 unconfirmed writes {writes} \xB7 sensitive reads {reads} \xB7 basis: host level={hostLevel} \xB7 tierEffective={tierEff} \xB7 degraded={degraded} \xB7 card from={tierSource}({tierAlt})"
      }
    };
    const store = {
      listeners: /* @__PURE__ */ new Set(),
      state: { status: "idle", sessionId: void 0, workspaceRoot: void 0, snapshot: null, error: void 0, alert: null, enabled: void 0 },
      /**
       * R12 修复 · D7-d：**最近一次从快照读到的"生效值"事实**。
       *
       * 为什么要单独存一份：设置页那一行（`WinStageRow`）拿不到快照，只能读 configForms；
       * 而 R11 实测"行内状态词 `已关闭`、事实是 TS 在跑"。把每拍读到的
       * `snapshot.staging.{effective, configValue, shellOverride, mismatch}` 放在这里，
       * 设置行就能显示**配置值与生效值两列**，并标明"被环境变量强制"。
       * 与快照同源（同一个字段），不另立判据。
       */
      staging: void 0,
      dismissed: void 0,
      /**
       * 「默认收起」偏好是否已在**本次页面加载**上生效过（page 级，刷新即重置）。
       *
       * 它把"启动偏好"与"每一版新快照"解耦：只有第一版**有待审的**快照会被默认收起；
       * 之后完全交给用户手势（chip 可随时收起/展开）与 sessionStorage 的那一版记忆。
       * 没有这个标记时，每个 Turn 的新 `generatedAt` 都会把面板重新压回去 ——
       * 开了偏好就永远打不开（实测缺陷）。
       */
      defaultCollapseApplied: false,
      /**
       * T3c：**粘性收起**（page 级；跨刷新由 sessionStorage 的 `STICKY_KEY` 记忆）。
       *
       * 为什么必须独立于 `dismissed`：`dismissed` 是"精确绑定某一版 `generatedAt`"的旧语义
       * （`nextDismissed` 规则 1），`.t/collapse-selftest.ts` 逐条钉住它**必须**"换版即失效"。
       * 而用户诉求恰好相反：点过「暂时收起」之后，新的待审快照**不得**再把面板弹开（C3）。
       * 两件事共用一个值必然两败俱伤 ⇒ 拆开：`dismissed` 保留旧语义，`stickyCollapsed` 管粘性。
       * true ⇒ 面板缺席、chip 在场（与 `generatedAt` 无关），直到
       *   ① 用户显式点 chip 展开（`restorePanel`），或
       *   ② 明确读到"待审集合已清空"（ready 且 `pending !== true`）⇒ 复位（C6）。
       */
      stickyCollapsed: false,
      /**
       * `alerts[]` 的"报过哪些"记录（按 `id`）。**它不决定横幅的可见性** ——
       * 可见性跟随**当前快照**（见 `tick()` 的 ready 分支）。保留它是为了幂等记录，
       * 以及纯函数 `pickFreshAlert` 的语义（`f8` 的 A11/A12 直接断言该函数）。
       */
      alertedId: void 0,
      /**
       * 逐条失败原因（path → message）。放 **store** 而不是组件 state：
       * 命令之后 `poller.refresh()` 会换一版快照，组件 state 可能随重挂载一起丢，
       * 观感就是"点了批准 → 处理中一闪 → 什么都没有"。
       */
      failures: /* @__PURE__ */ new Map(),
      /**
       * V2-2 记账（**新增键，只加不改**）：记录失败时"这些失败路径**当时在不在面板上**"。
       *
       * 清除时机必须靠它区分两种情况，否则会把 P0-1 的可见性改坏：
       *   · 当时在面板、现在已离场 ⇒ 条目被批准/拒绝 ⇒ 旧失败作废，可清；
       *   · 当时就不在面板（例："没有匹配的待审路径"）⇒ **必须保留**，否则下一轮
       *     轮询（1.5s）就会把它抹掉，用户又回到"点了没反应"。
       */
      failureRows: /* @__PURE__ */ new Set(),
      /**
       * v2.1（方案 B，**新增键，只加不改**）：`showFailure()` 当时写下的那条 notice 原文。
       *
       * 为什么需要它：菜单 `run()` / S6 那 5 处会**直接** `store.publish({ notice })` 覆盖面板提示，
       * 而它们不碰 `failureRows`。于是残留的旧失败记账会让 prune 在下一秒把这条**泛化提示**
       * 误清掉（verifier `v2-fr-notice.txt` 2-2）。记录"notice 是不是我们自己写的"，
       * 就能让 prune **只清它自己记的那一条**，不动别人的提示。
       */
      failureNotice: void 0,
      /** 面板级失败原文（没归到具体条目时的兜底）；同样放 store 以求存活 */
      notice: void 0,
      inFlight: false,
      publish(patch) {
        store.state = { ...store.state, ...patch || {} };
        for (const listener of store.listeners) listener();
      },
      subscribe(listener) {
        store.listeners.add(listener);
        return () => store.listeners.delete(listener);
      }
    };
    function sameRoot(a, b) {
      const norm = (value) => String(value ?? "").replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
      const left = norm(a);
      return left.length > 0 && left === norm(b);
    }
    function readSwitch(form) {
      const snapshot = form && typeof form.getSnapshot === "function" ? form.getSnapshot() : void 0;
      if (!snapshot || snapshot.status !== "ready") return "unknown";
      const value = snapshot.value;
      return value && value.enabled === true ? "on" : "off";
    }
    function stagingFacts(snapshot) {
      const staging = snapshot && typeof snapshot === "object" ? snapshot.staging : void 0;
      if (!staging || typeof staging !== "object") {
        return { effective: "unknown", configValue: null, forced: false, mismatch: null, text: null, effectiveSource: null };
      }
      const effective = staging.effective === true ? "on" : staging.effective === false ? "off" : "unknown";
      const override = staging.shellOverride && typeof staging.shellOverride === "object" ? staging.shellOverride : null;
      return {
        effective,
        configValue: typeof staging.configValue === "boolean" ? staging.configValue : null,
        forced: Boolean(override && override.forced),
        mismatch: staging.mismatch && typeof staging.mismatch === "object" ? staging.mismatch : null,
        text: override && typeof override.text === "string" ? override.text : null,
        effectiveSource: typeof staging.source === "string" ? staging.source : null
      };
    }
    function winstageElection(sessionId) {
      if (!sessionId) return null;
      const staging = stagingFacts(store.state.snapshot);
      if (store.state.enabled !== true && staging.effective !== "on") return null;
      const snapshot = store.state.snapshot;
      if (!snapshot || snapshot.pending !== true) return null;
      if (!sameRoot(snapshot.workspaceRoot, store.state.workspaceRoot)) return null;
      if (isCollapsedNow(snapshot)) return null;
      return { kind: "winstage-review", sessionId, generatedAt: snapshot.generatedAt, stagingEffective: staging.effective };
    }
    function routeOf(owner) {
      if (!owner || !owner.sessionId) return null;
      return winstageElection(owner.sessionId);
    }
    const RISKS = ["normal", "outside", "sensitive"];
    function riskOf(item) {
      return item && RISKS.indexOf(item.risk) >= 0 ? item.risk : "normal";
    }
    function isDanger(item) {
      return Boolean(item) && item.safety === "danger";
    }
    function noteOf(item) {
      if (!item || typeof item !== "object") return null;
      if (!("note" in item)) return null;
      return typeof item.note === "string" && item.note.length > 0 ? item.note : null;
    }
    function baselineStaleReasonText(t, item) {
      const code = item?.baselineStaleCode;
      if (code === "baseline-appeared") return t("baselineStaleAppeared");
      if (code === "baseline-deleted") return t("baselineStaleDeleted");
      if (code === "baseline-drifted") return t("baselineStaleDrifted");
      return null;
    }
    function sortByPath(items) {
      return items.map((item, index) => ({ item, index })).sort((a, b) => {
        const left = String(a.item?.path ?? "").toLowerCase();
        const right = String(b.item?.path ?? "").toLowerCase();
        if (left < right) return -1;
        if (left > right) return 1;
        return a.index - b.index;
      }).map((entry) => entry.item);
    }
    function groupByRisk(files) {
      const list = Array.isArray(files) ? files : [];
      return {
        normal: sortByPath(list.filter((item) => riskOf(item) === "normal")),
        outside: sortByPath(list.filter((item) => riskOf(item) === "outside")),
        sensitive: sortByPath(list.filter((item) => riskOf(item) === "sensitive"))
      };
    }
    function isSandboxNoisePath(path) {
      const raw = String(path ?? "");
      if (raw.length === 0) return false;
      const lowered = raw.toLowerCase();
      if (lowered.includes("__psscriptpolicytest_")) return true;
      if (lowered.includes("dsh-stage-temp")) return true;
      const base = lowered.split(/[\\/]/).pop() ?? "";
      const normalized = lowered.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
      const topLevel = !normalized.includes("/");
      if (topLevel && (base === "shim.log" || base === "winstage-shim.config.json")) return true;
      return false;
    }
    function splitNoiseFiles(files) {
      const list = Array.isArray(files) ? files : [];
      const work = [];
      const noise = [];
      for (const item of list) (isSandboxNoisePath(item && item.path) ? noise : work).push(item);
      return { work, noise };
    }
    function summarize(files, declared, declaredTotal) {
      const list = Array.isArray(files) ? files : [];
      const counts = { files: list.length, normal: 0, outside: 0, sensitive: 0, danger: 0 };
      for (const item of list) {
        const risk = riskOf(item);
        counts[risk] += 1;
        if (risk === "sensitive" && isDanger(item)) counts.danger += 1;
      }
      if (declared && typeof declared === "object") {
        for (const key of ["normal", "outside", "sensitive", "danger"]) {
          const value = Number(declared[key]);
          if (Number.isFinite(value) && value > counts[key]) counts[key] = value;
        }
      }
      const total = Number(declaredTotal);
      if (Number.isFinite(total) && total > counts.files) counts.files = total;
      return counts;
    }
    function levelCounts(files, declared, snapshotTruncated, declaredTotal) {
      const list = Array.isArray(files) ? files : [];
      const counts = summarize(list, declared, declaredTotal);
      const truncated = counts.files > list.length || snapshotTruncated === true;
      return {
        L1: counts.normal,
        L2: counts.outside,
        L3: counts.sensitive,
        danger: counts.danger,
        total: counts.files,
        listed: list.length,
        truncated
      };
    }
    function levelSegments(levels, t) {
      const parts = [];
      if (levels.L1 > 0) parts.push(t("chipL1", { count: levels.L1 }));
      if (levels.L2 > 0) parts.push(t("chipL2", { count: levels.L2 }));
      if (levels.L3 > 0) parts.push(t("chipL3", { count: levels.L3 }));
      if (levels.danger > 0) parts.push(t("chipDanger", { count: levels.danger }));
      return parts;
    }
    function riskSignature(item) {
      return `${String(item?.path ?? "")}|${riskOf(item)}|${item?.safety ?? "null"}`;
    }
    function isActionable(item) {
      return Boolean(item) && item.frozenOnly !== true;
    }
    function frozenReasonText(t, item) {
      const reason = item?.frozenReason;
      if (reason === "reclaimed") return t("frozenReclaimed");
      if (reason === "no-op") return t("frozenNoOp");
      return t("frozenNoNetChange");
    }
    function failureByPath(text, paths) {
      const map = /* @__PURE__ */ new Map();
      if (typeof text !== "string" || text.length === 0 || !Array.isArray(paths) || paths.length === 0) return map;
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
      for (const path of paths) {
        const needle = String(path).toLowerCase();
        const hit = lines.find((line) => line.toLowerCase().includes(needle));
        if (hit) map.set(path, hit);
      }
      return map;
    }
    function pruneResolvedFailures(failures, failureRows, notice, failureNotice, snapshot) {
      const map = failures instanceof Map ? failures : /* @__PURE__ */ new Map();
      const tracked = failureRows instanceof Set ? failureRows : /* @__PURE__ */ new Set();
      if (map.size === 0 || tracked.size === 0) return { dropped: 0, failures: map, notice };
      const rows = Array.isArray(snapshot?.files) ? snapshot.files : [];
      const present = new Set(rows.map((row) => row.path));
      const staleById = new Map(rows.map((row) => [row.path, row.baselineStale === true]));
      const next = /* @__PURE__ */ new Map();
      let dropped = 0;
      for (const [path, message] of map) {
        const wasOnPanel = tracked.has(path);
        const staleClaim = typeof message === "string" && /STALE_BASELINE|基线已过期/i.test(message);
        const leftPanel = wasOnPanel && !present.has(path);
        const staleResolved = wasOnPanel && present.has(path) && staleClaim && staleById.get(path) !== true;
        if (leftPanel || staleResolved) {
          dropped += 1;
          continue;
        }
        next.set(path, message);
      }
      if (dropped === 0) return { dropped: 0, failures: map, notice };
      const ownsNotice = typeof failureNotice === "string" && failureNotice.length > 0 && notice === failureNotice;
      const clearNotice = ownsNotice && next.size === 0;
      return { dropped, failures: next, notice: clearNotice ? void 0 : notice };
    }
    function selectablePaths(files) {
      const list = Array.isArray(files) ? files : [];
      return list.filter((item) => riskOf(item) === "normal" && isActionable(item)).map((item) => item.path);
    }
    function authorizedPaths(files, selected, consented, only) {
      const list = Array.isArray(files) ? files : [];
      return list.filter((item) => {
        if (!isActionable(item)) return false;
        if (riskOf(item) === "normal") return true;
        if (!selected.has(item.path)) return false;
        return consented === null || consented?.get(item.path) === riskSignature(item);
      }).filter((item) => only === true ? selected.has(item.path) : true).map((item) => item.path);
    }
    function approveAllPaths(files, selected) {
      return authorizedPaths(files, selected, null);
    }
    function pickFreshAlert(alerts, lastId) {
      if (!Array.isArray(alerts)) return null;
      for (const alert of alerts) {
        if (!alert || typeof alert.id !== "string" || alert.id.length === 0) continue;
        if (alert.id === lastId) continue;
        return alert;
      }
      return null;
    }
    function fnv1a32(text) {
      let hash = 2166136261;
      for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      return hash.toString(16).padStart(8, "0");
    }
    function sessionDirKey(sessionId) {
      const raw = typeof sessionId === "string" ? sessionId.trim() : "";
      if (raw.length === 0) return "";
      if (/^[A-Za-z0-9._-]{1,64}$/.test(raw)) return raw;
      return `s_${fnv1a32(raw)}_${raw.length}`;
    }
    function joinPath(root, ...parts) {
      const sep = /^[a-zA-Z]:/.test(root) ? "\\" : "/";
      return [String(root).replace(/[\\/]+$/, ""), ...parts].join(sep);
    }
    const PANEL_ROUTE_PREFIX = "/winstage-panel";
    const PANEL_SNAPSHOT_ROUTE = PANEL_ROUTE_PREFIX + "/snapshot";
    const PANEL_TRUST_ROUTE = PANEL_ROUTE_PREFIX + "/trust";
    function fetchPanelRoute(path, sessionId) {
      if (typeof fetch !== "function") return Promise.resolve({ ok: false, code: "no-fetch" });
      const controller = new AbortController();
      const url = `${path}?session=${encodeURIComponent(typeof sessionId === "string" ? sessionId : "")}`;
      return Promise.resolve(fetch(url, { signal: controller.signal, headers: { accept: "application/json" } })).then(async (response) => {
        const type = String(response && response.headers && response.headers.get && response.headers.get("content-type") || "");
        if (!type.includes("application/json")) return { ok: false, code: "not-json" };
        const body = await response.json().catch(() => void 0);
        if (!response.ok) return { ok: false, code: String(body && body.code ? body.code : `http-${response.status}`), body };
        if (!body || body.ok !== true) return { ok: false, code: String(body && body.code || "bad-body"), body };
        return { ok: true, value: body };
      }).catch((error) => ({ ok: false, code: `fetch-failed: ${String(error && error.message || error)}` })).finally(() => controller.abort());
    }
    async function readReviewViaRoute(ctx, sessionId) {
      const result = await fetchPanelRoute(PANEL_SNAPSHOT_ROUTE, sessionId);
      if (!result.ok) {
        return result.code === "no-snapshot" ? { ok: true, snapshot: null, store: void 0, source: "host-route" } : { ok: false, code: result.code, staging: result.body && result.body.staging ? result.body.staging : void 0 };
      }
      const body = result.value;
      return { ok: true, snapshot: body.snapshot ?? null, store: body.store, source: "host-route" };
    }
    function readReviewViaLegacyPath(ctx, sessionId, root) {
      const controller = new AbortController();
      const key = sessionDirKey(sessionId);
      const path = key ? joinPath(root, ".dshstage", "sessions", key, "review.json") : joinPath(root, ".dshstage", "review.json");
      return Promise.resolve(ctx.remote.workspaceFiles.read(sessionId, path, { offset: 1, limit: 400 }, controller.signal)).then((result) => {
        if (result && result.ok === false) {
          const code = String(result.error?.code ?? result.error?.message ?? "unknown");
          if (code.includes("not-found")) return null;
          throw new Error(code);
        }
        const value = result && result.ok === true ? result.value : result;
        if (!value || typeof value.text !== "string" || value.text.length === 0) return null;
        return JSON.parse(value.text);
      }).finally(() => controller.abort());
    }
    async function readReview(ctx, sessionId, root) {
      const viaRoute = await readReviewViaRoute(ctx, sessionId);
      if (viaRoute.ok) return { snapshot: viaRoute.snapshot, source: viaRoute.source, store: viaRoute.store };
      const snapshot = await readReviewViaLegacyPath(ctx, sessionId, root);
      return { snapshot, source: "legacy-compat-path", store: void 0, routeFallback: viaRoute.code, staging: viaRoute.staging };
    }
    async function readTrustCard(ctx, sessionId) {
      const scoped = await fetchPanelRoute(PANEL_TRUST_ROUTE, sessionId);
      if (!scoped.ok) return { ok: false, code: scoped.code };
      const scopedCard = scoped.value.card ?? null;
      const hasTierEvidence = (card2) => Boolean(card2 && card2.tier && (card2.tier.status !== void 0 || card2.tier.tierEffective !== void 0 || card2.tier.launchMode !== void 0 || card2.tier.degraded === true));
      let card = scopedCard;
      let tierSource = "scoped";
      let alternate = null;
      if (!hasTierEvidence(scopedCard)) {
        const bare = await fetchPanelRoute(PANEL_TRUST_ROUTE, void 0);
        if (bare.ok && hasTierEvidence(bare.value.card ?? null)) {
          card = bare.value.card;
          tierSource = "unscoped";
          alternate = { scoped: false, unscoped: true };
        } else {
          alternate = { scoped: false, unscoped: false };
        }
      }
      return {
        ok: true,
        card: card ? { ...card, tierSource, tierAlternate: alternate } : null,
        store: scoped.value.store
      };
    }
    function runCommand(ctx, sessionId, line) {
      return Promise.resolve(ctx.remote.commands.execute(sessionId, line, [])).then((result) => {
        if (result && result.ok === false) throw new Error(result.error?.code ?? result.error?.message ?? "command failed");
        return result && result.ok === true ? result.value : result;
      });
    }
    function createPoller(ctx, configForm) {
      let sessionId;
      let stopped = false;
      const tick = async () => {
        if (stopped || store.inFlight) return;
        store.inFlight = true;
        try {
          const configSnapshot = configForm ? configForm.getSnapshot() : void 0;
          const configValue = configSnapshot && configSnapshot.value || {};
          if (readSwitch(configForm) !== "on") {
            const configuredRoot = typeof configValue.workspaceRoot === "string" && configValue.workspaceRoot.trim().length > 0 ? configValue.workspaceRoot.trim() : void 0;
            const probe = await readReview(ctx, sessionId, configuredRoot);
            const probeStaging = stagingFacts(probe.snapshot);
            store.staging = probe.snapshot && probe.snapshot.staging ? probe.snapshot.staging : { effective: probeStaging.effective === "on" };
            if (probeStaging.effective !== "on") {
              store.publish({ status: "idle", snapshot: null, workspaceRoot: configuredRoot, sessionId, alert: null, enabled: false });
              return;
            }
            const readyRoot = configuredRoot ?? (probe.snapshot && probe.snapshot.workspaceRoot);
            if (!readyRoot || probe.snapshot && !sameRoot(probe.snapshot.workspaceRoot, readyRoot)) {
              store.publish({ status: "idle", snapshot: null, workspaceRoot: readyRoot, sessionId, alert: null, enabled: true });
              return;
            }
            store.publish({
              status: "ready",
              snapshot: probe.snapshot,
              error: void 0,
              workspaceRoot: readyRoot,
              sessionId,
              alert: null,
              /** ⚠ 语义：这个 `enabled` 是"面板是否立起来"，不是"配置值"；配置值读 `snapshot.staging.configValue` */
              enabled: true,
              forcedByEffectiveStaging: true,
              storeSource: probe.source,
              ...probe.routeFallback ? { routeFallback: probe.routeFallback } : {}
            });
            return;
          }
          const root = typeof configValue.workspaceRoot === "string" ? configValue.workspaceRoot.trim() : "";
          if (!sessionId || root.length === 0) {
            store.publish({ status: "idle", snapshot: null, workspaceRoot: void 0, sessionId, enabled: true });
            return;
          }
          const read = await readReview(ctx, sessionId, root);
          const snapshot = read.snapshot;
          if (snapshot && !sameRoot(snapshot.workspaceRoot, root)) {
            store.publish({ status: "idle", snapshot: null, workspaceRoot: root, sessionId, enabled: true });
            return;
          }
          const trust = await readTrustCard(ctx, sessionId);
          if (snapshot && snapshot.pending !== true) resetStickyCollapse();
          const generatedAt = snapshot?.generatedAt;
          if (generatedAt) {
            const decision = nextDismissed({
              dismissed: store.dismissed,
              generatedAt,
              remembered: readStr(sessionStore, DISMISS_KEY),
              defaultCollapsed: readStr(localStore, PREF_KEY) === "1",
              applied: store.defaultCollapseApplied,
              // β（V2-1）：同一条判据的**第 4 处出现**（喂 nextDismissed 的 `pending` 输入）。
              // 与 :323/:1319/:2030 收敛为同一写法；行为等价（见 winstageElection 处的恒等式说明）。
              pending: Boolean(snapshot && snapshot.pending === true)
            });
            store.dismissed = decision.dismissed;
            store.defaultCollapseApplied = decision.applied;
            if (decision.dismissed !== void 0) markStickyCollapsed();
          }
          const alerts = Array.isArray(snapshot?.alerts) ? snapshot.alerts : [];
          const currentAlert = alerts.find((item) => item && typeof item.id === "string" && item.id.length > 0) ?? null;
          const fresh = pickFreshAlert(alerts, store.alertedId);
          if (fresh) store.alertedId = fresh.id;
          const pruned = pruneResolvedFailures(
            store.state.failures,
            store.failureRows,
            store.state.notice,
            store.failureNotice,
            snapshot
          );
          store.publish({
            status: "ready",
            snapshot,
            error: void 0,
            workspaceRoot: root,
            sessionId,
            alert: currentAlert,
            enabled: true,
            /**
             * R12 · D7-d：`staging` 段随**同一版快照**一起进 store（配置值 / 生效值 /
             * 环境强制三者同源）。设置行据此把状态词写成"配置值 X / 生效值 Y"。
             */
            staging: snapshot && snapshot.staging ? snapshot.staging : read.staging ? read.staging : void 0,
            // WP3-B：读侧来源（`host-route` = 宿主解析的新存储 / `legacy-compat-path` = 兜底旧布局）。
            // 面板据此显示一行"读取来源"，让"读到的是哪一份"永远可分辨。
            storeSource: read.source,
            ...read.routeFallback ? { routeFallback: read.routeFallback } : {},
            // WP3：可信性状态卡（取不到就是 undefined ⇒ 面板不显示，而不是显示旧结论）
            trust: trust.ok ? trust.card : void 0,
            ...trust.ok ? {} : { trustCode: trust.code },
            ...pruned.dropped > 0 ? { failures: pruned.failures, notice: pruned.notice } : {}
          });
        } catch (error) {
          store.publish({ status: "error", error: String(error?.message ?? error) });
        } finally {
          store.inFlight = false;
        }
      };
      const interval = setInterval(tick, POLL_MS);
      void tick();
      return {
        /** 面板渲染时把会话身份告诉轮询器（owner props 是唯一的会话来源） */
        observe(owner) {
          const next = owner?.sessionId;
          if (next !== sessionId) {
            sessionId = next;
            void tick();
          }
        },
        refresh: tick,
        /**
         * "此刻是否应当接管 composer" —— 与 `routeOf` 同一判据，只差 ownerProps
         * （sessionId 由 `observe()` 提供）。供失效通道在**没有渲染**的时机检测跃迁。
         */
        shouldElect() {
          return winstageElection(sessionId) !== null;
        },
        dispose() {
          stopped = true;
          clearInterval(interval);
        }
      };
    }
    const styles = {
      root: { padding: "8px 16px 12px", display: "flex", flexDirection: "column", alignItems: "center" },
      card: {
        width: "100%",
        maxWidth: "var(--dsh-chat-content-width, 760px)",
        border: "1px solid var(--dsw-alias-state-warn-secondary, rgba(200,140,0,.5))",
        borderRadius: "var(--dsw-radius-xl, 12px)",
        background: "var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1, #fff))",
        boxShadow: "var(--dsw-shadow-lv2, 0 4px 16px rgba(0,0,0,.12))",
        overflow: "hidden"
      },
      strip: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "10px 16px",
        fontSize: "13px",
        lineHeight: "18px",
        background: "var(--dsw-alias-state-warn-tertiary, rgba(255,196,0,.14))",
        // ⚠ S3d：tinted 背景上的文字一律用**前景 token**（`label-primary`），
        // 不再用同色系的 state-primary：暗色下 warn-tertiary=amber-900 + warn-primary=amber-500
        // 是同色相中低对比组合（对比度审计会判 FAIL）。语义靠背景/边框的色相保留。
        color: "var(--dsw-alias-label-primary)",
        flexWrap: "wrap"
      },
      body: {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "12px 16px 0",
        maxHeight: "var(--dsh-composer-text-max-height, 40vh)",
        overflowY: "auto"
      },
      // S3i：原 `headline`（正文首行的摘要）已退役 —— 摘要移到标题条（`reviewLevels`），避免同一数字出现两遍。
      fileRow: {
        display: "flex",
        alignItems: "flex-start",
        gap: "8px",
        padding: "6px 0",
        borderTop: "1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.2))"
      },
      path: {
        fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)",
        fontSize: "12px",
        lineHeight: "18px",
        color: "var(--dsw-alias-label-primary, inherit)",
        wordBreak: "break-all",
        flex: "1 1 auto",
        minWidth: 0,
        background: "none",
        border: "none",
        padding: 0,
        textAlign: "left",
        cursor: "pointer"
      },
      meta: { fontSize: "12px", opacity: 0.65, whiteSpace: "nowrap" },
      diff: {
        margin: "2px 0 8px",
        padding: "8px 10px",
        borderRadius: "var(--dsw-radius-md, 6px)",
        background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08))",
        fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)",
        fontSize: "12px",
        lineHeight: "17px",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        maxHeight: "30vh",
        overflow: "auto"
      },
      actionRow: { display: "flex", justifyContent: "flex-end", gap: "8px", padding: "14px 16px", flexWrap: "wrap" },
      button: {
        font: "inherit",
        fontSize: "13px",
        lineHeight: "20px",
        padding: "6px 14px",
        borderRadius: "var(--dsw-radius-lg, 8px)",
        border: "1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.35))",
        background: "transparent",
        color: "var(--dsw-alias-label-primary, inherit)",
        cursor: "pointer"
      },
      // ⚠ S3f（task-11）：**`--dsw-alias-brand-text` 与 `--dsw-alias-brand-primary` 在两种主题下
      // 解析成同一个值**（实测主题 CSS：light 都是 bluish-1000 `#0f1115`；dark 都是 bluish-50 `#f9fafb`）
      // ⇒ 我上一轮用它做前景，运行时得到 **1.00:1**（字与底同色 = 隐形），被对比度审计当场抓到。
      // 现在配对的是**实测互为反色**的一对：
      //   brand-primary  light #0f1115 / dark #f9fafb
      //   label-primary-foreground light #fff    / dark #0f1115
      // 计算对比度：light **18.9:1**、dark **18.1:1**（≥4.5 达标）。
      primary: { borderColor: "transparent", background: "var(--dsw-alias-brand-primary)", color: "var(--dsw-alias-label-primary-foreground)" },
      danger: {
        borderColor: "transparent",
        background: "var(--dsw-alias-state-error-tertiary, rgba(220,60,60,.14))",
        // S3f：**文字色一律用 label-* 前景 token**。`state-*-primary`（红/绿/琥珀）是**填充/描边**色，
        // 当正文色时实测不合格（amber-600 在白底只有 2.79:1；red-600 4.4976:1 临界不过）。
        // 语义保留在**背景 tint + 左边条/边框**上。
        color: "var(--dsw-alias-label-primary)"
      },
      badge: {
        fontSize: "11px",
        lineHeight: "16px",
        padding: "0 6px",
        borderRadius: "999px",
        border: "1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.35))",
        whiteSpace: "nowrap"
      },
      // ── S3c 三档视觉分级：**只用 host 主题 token，不写死颜色**（明暗主题都正确）──
      badgeBase: {
        fontSize: "11px",
        lineHeight: "16px",
        padding: "0 6px",
        borderRadius: "999px",
        whiteSpace: "nowrap",
        marginRight: "6px",
        fontWeight: 500
      },
      badgeOutside: {
        border: "1px solid var(--dsw-alias-state-warn-primary)",
        color: "var(--dsw-alias-label-primary)"
      },
      badgeSensitive: {
        border: "1px solid var(--dsw-alias-state-error-primary)",
        color: "var(--dsw-alias-label-primary)"
      },
      badgeDanger: {
        border: "1px solid var(--dsw-alias-state-error-primary)",
        background: "var(--dsw-alias-state-error-tertiary, rgba(220,60,60,.14))",
        // 同 S3d：tinted 背景上的**文字**用前景 token（否则暗色下同色相中低对比）
        color: "var(--dsw-alias-label-primary)",
        fontWeight: 600
      },
      rowOutside: { borderLeft: "3px solid var(--dsw-alias-state-warn-primary)", paddingLeft: "8px" },
      rowSensitive: { borderLeft: "3px solid var(--dsw-alias-state-error-primary)", paddingLeft: "8px" },
      rowDanger: { borderLeft: "3px solid var(--dsw-alias-state-error-primary)", paddingLeft: "8px" },
      groupHeader: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "12px",
        fontWeight: 600,
        lineHeight: "18px",
        padding: "6px 0 2px",
        color: "var(--dsw-alias-label-primary, inherit)"
      },
      groupCount: { opacity: 0.65, fontWeight: 400 },
      /**
       * S3i：组头的**等级徽章**（L1/L2/L3）。沿用既有 badge 的视觉语言（描边 pill + `--dsw-*` token），
       * **不写死颜色**；文字用前景 token（`D1`/`D2` 哨兵会管住对比度，`data-darkreader-ignore` 由渲染处加）。
       * ⚠ 这是 S3i 新增的渲染元素 ⇒ 它**必须**被 `f9` 的渲染树断言（`D4`）覆盖，否则就是新的对比度盲区。
       */
      groupBadge: {
        fontSize: "11px",
        lineHeight: "16px",
        padding: "0 6px",
        borderRadius: "999px",
        border: "1px solid var(--dsw-alias-state-warn-secondary)",
        background: "transparent",
        color: "var(--dsw-alias-label-primary)",
        fontWeight: 600,
        whiteSpace: "nowrap"
      },
      riskReason: {
        fontSize: "12px",
        lineHeight: "17px",
        padding: "0 0 4px 26px",
        // S3f：正文级文字 ⇒ label-*；红色语义由所在行的左边条（rowSensitive/rowDanger）保留
        color: "var(--dsw-alias-label-primary)"
      },
      note: { opacity: 0.85 },
      /**
       * D1：冻结存档行的视觉语言 —— 复选框的位置换成不可交互的「存档」徽章，
       * 行内再给一句原因。**只用主题 token**（与其它自绘控件同一套），
       * 前景一律 `label-primary`（tinted/透明底上的对比度规则同 S3d/S3f）。
       */
      frozenBadge: {
        flex: "0 0 auto",
        fontSize: "11px",
        lineHeight: "16px",
        padding: "0 6px",
        borderRadius: "999px",
        border: "1px dashed var(--dsw-alias-border-l4, rgba(128,128,128,.35))",
        color: "var(--dsw-alias-label-primary)",
        opacity: 0.85,
        whiteSpace: "nowrap"
      },
      frozenReason: {
        fontSize: "12px",
        lineHeight: "17px",
        padding: "0 0 4px 26px",
        color: "var(--dsw-alias-label-primary)",
        opacity: 0.75
      },
      frozenSummary: {
        fontSize: "12px",
        lineHeight: "18px",
        paddingBottom: "2px",
        color: "var(--dsw-alias-label-primary)",
        opacity: 0.75
      },
      /** 基线已过期：与 frozenBadge 同一套视觉语言，但用 warn token（不是"存档"，是"要处理"） */
      staleBadge: {
        ...{ flex: "0 0 auto" },
        fontSize: "11px",
        lineHeight: "16px",
        padding: "0 6px",
        borderRadius: "999px",
        border: "1px solid var(--dsw-alias-state-warn-secondary, rgba(200,140,0,.5))",
        color: "var(--dsw-alias-state-warn-primary, #8a6100)",
        whiteSpace: "nowrap"
      },
      staleSummary: {
        fontSize: "12px",
        lineHeight: "18px",
        paddingBottom: "2px",
        color: "var(--dsw-alias-state-warn-primary, #8a6100)"
      },
      /**
       * 逐行的漂移形状说明（缺陷② F5b）。与 frozenReason 同一缩进语言：
       * 贴在那一行**下面**，因此"哪一条、为什么"不会被读成面板级告警。
       */
      staleNote: {
        fontSize: "12px",
        lineHeight: "17px",
        padding: "0 0 4px 26px",
        color: "var(--dsw-alias-state-warn-primary, #8a6100)"
      },
      // ── 替代「访问模式」控件的视觉：与平台 PermissionSelect 同一位置、同一尺寸语言 ──
      permRoot: { position: "relative", display: "inline-flex", alignItems: "center" },
      permTrigger: {
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        minWidth: 0,
        maxWidth: "200px",
        height: "28px",
        padding: "0 4px 0 8px",
        border: "none",
        borderRadius: "var(--dsw-radius-sm, 6px)",
        background: "transparent",
        color: "var(--dsw-alias-label-secondary)",
        font: "inherit",
        fontSize: "13px",
        fontWeight: 500,
        lineHeight: "20px",
        cursor: "pointer"
      },
      permMark: {
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "14px",
        height: "14px",
        borderRadius: "4px",
        background: "var(--dsw-alias-state-warn-tertiary, rgba(255,196,0,.18))",
        color: "var(--dsw-alias-state-warn-primary, #8a6100)",
        fontSize: "10px",
        fontWeight: 700,
        lineHeight: "14px"
      },
      permLabel: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      permDot: {
        flex: "0 0 auto",
        color: "var(--dsw-alias-state-warn-primary, #8a6100)",
        fontWeight: 700,
        fontSize: "12px"
      },
      permChevron: {
        flex: "0 0 auto",
        color: "var(--dsw-alias-label-caption)",
        fontSize: "10px",
        transition: "transform .12s"
      },
      permMenu: {
        position: "absolute",
        bottom: "32px",
        left: 0,
        zIndex: 30,
        minWidth: "240px",
        display: "flex",
        flexDirection: "column",
        padding: "4px",
        border: "1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.28))",
        borderRadius: "var(--dsw-radius-lg, 8px)",
        background: "var(--dsw-alias-bg-layer-1, #fff)",
        boxShadow: "var(--dsw-shadow-lv2, 0 4px 16px rgba(0,0,0,.14))"
      },
      permItem: {
        border: "none",
        background: "transparent",
        color: "var(--dsw-alias-label-primary, inherit)",
        font: "inherit",
        fontSize: "13px",
        lineHeight: "20px",
        textAlign: "left",
        padding: "6px 10px",
        borderRadius: "var(--dsw-radius-md, 6px)",
        cursor: "pointer",
        whiteSpace: "nowrap"
      },
      permItemDanger: { color: "var(--dsw-alias-state-error-primary, #b3261e)" },
      permHint: {
        padding: "4px 10px 2px",
        fontSize: "11px",
        lineHeight: "16px",
        color: "var(--dsw-alias-label-tertiary, inherit)",
        opacity: 0.8,
        whiteSpace: "normal"
      },
      // ── 命中敏感策略的**二次确认弹窗**（只在用户点批准时出现，不是常驻 UI）──
      confirmBackdrop: {
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        background: "rgba(0, 0, 0, .38)"
      },
      confirmCard: {
        width: "100%",
        maxWidth: "520px",
        maxHeight: "80vh",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        padding: "16px 18px",
        borderRadius: "var(--dsw-radius-xl, 12px)",
        border: "1px solid var(--dsw-alias-state-error-primary, rgba(220,60,60,.5))",
        background: "var(--dsw-alias-bg-layer-1, #fff)",
        boxShadow: "var(--dsw-shadow-lv2, 0 8px 28px rgba(0,0,0,.28))",
        color: "var(--dsw-alias-label-primary, inherit)"
      },
      confirmTitle: { fontSize: "15px", fontWeight: 600, lineHeight: "22px" },
      confirmBody: { fontSize: "13px", lineHeight: "20px", opacity: 0.85 },
      confirmList: { display: "flex", flexDirection: "column", gap: "6px", overflowY: "auto", maxHeight: "40vh" },
      confirmItem: {
        padding: "8px 10px",
        borderRadius: "var(--dsw-radius-md, 6px)",
        background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08))",
        borderLeft: "3px solid var(--dsw-alias-state-error-primary, #b3261e)"
      },
      confirmPath: {
        fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)",
        fontSize: "12px",
        lineHeight: "18px",
        wordBreak: "break-all"
      },
      confirmReason: { fontSize: "12px", lineHeight: "18px", opacity: 0.8 },
      confirmDanger: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-state-error-primary, #b3261e)" },
      confirmActions: { display: "flex", justifyContent: "flex-end", gap: "8px", paddingTop: "4px" },
      // 逐条失败原因：**原地**贴在出错条目下方
      rowError: {
        padding: "3px 10px 6px",
        fontSize: "12px",
        lineHeight: "17px",
        wordBreak: "break-word",
        color: "var(--dsw-alias-state-error-primary, #b3261e)"
      },
      // alerts 横幅：**非阻断**（没有按钮、不需要点掉；role=status 而非 alert 对话框）
      alert: {
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        padding: "8px 10px",
        marginBottom: "6px",
        borderRadius: "var(--dsw-radius-md, 6px)",
        border: "1px solid var(--dsw-alias-state-error-primary)",
        // ⚠ `--dsw-alias-state-error-tertiary` 在**当前主题里根本没有定义**（实测主题 CSS：
        // warn-tertiary 有，error-tertiary 无）⇒ 必须带 fallback，否则该声明非法、背景变透明、
        // 红色提示条只剩 1px 边框（这条是我 T11 复核 token 时自己发现的）。
        background: "var(--dsw-alias-state-error-tertiary, rgba(220,60,60,.14))",
        // 同 S3d：tinted 背景上的**文字**用前景 token（否则暗色下同色相中低对比）
        color: "var(--dsw-alias-label-primary)",
        fontSize: "12px",
        lineHeight: "17px"
      },
      alertTitle: { fontWeight: 600 },
      alertText: { opacity: 0.9 },
      alertHint: { opacity: 0.75 },
      actionHint: { flexBasis: "100%", textAlign: "right", fontSize: "11px", lineHeight: "16px", opacity: 0.7 },
      /** G4：摘要放进标题条（要求 4「在面板标题处显示汇总」） */
      stripSummary: { fontSize: "12px", opacity: 0.9, fontWeight: 500 },
      /** G1：档位变化导致授权失效的内联提示（非阻断、无按钮） */
      staleNotice: {
        flexBasis: "100%",
        textAlign: "right",
        fontSize: "11px",
        lineHeight: "16px",
        // S3f：amber-600 当正文色在白底只有 2.79:1 ⇒ 用前景 token；"警告"语义由文案里的 ⚠ 前缀承载
        color: "var(--dsw-alias-label-primary)"
      },
      // S3e：设置行里的「默认收起」开关（第 2 条退路；纯客户端偏好，不需要 host 改 schema）
      inlineToggle: {
        font: "inherit",
        fontSize: "12px",
        lineHeight: "18px",
        marginTop: "4px",
        padding: "2px 8px",
        borderRadius: "var(--dsw-radius-md, 6px)",
        border: "1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.35))",
        background: "transparent",
        color: "var(--dsw-alias-label-primary, inherit)",
        cursor: "pointer"
      },
      // S3e：收起后的常驻重开 chip（挂在 conversation.input.dock，不依赖 composer 选举）
      chipRow: { display: "flex", justifyContent: "center", padding: "2px 0 4px" },
      chip: {
        font: "inherit",
        fontSize: "12px",
        lineHeight: "18px",
        padding: "3px 10px",
        borderRadius: "999px",
        border: "1px solid var(--dsw-alias-state-warn-secondary)",
        background: "var(--dsw-alias-state-warn-tertiary)",
        color: "var(--dsw-alias-label-primary)",
        cursor: "pointer",
        // S3h：分级文案把 pill 拉长了 ⇒ 永不换行；极窄屏退化为省略号（完整含义在 title 里）
        whiteSpace: "nowrap",
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis"
      }
    };
    const DR = { "data-darkreader-ignore": "" };
    function safeStorage(name) {
      try {
        const store2 = window[name];
        store2.getItem("__winstage_probe__");
        return store2;
      } catch {
        return null;
      }
    }
    const sessionStore = safeStorage("sessionStorage");
    const localStore = safeStorage("localStorage");
    function readStr(store2, key) {
      try {
        return store2 ? store2.getItem(key) : null;
      } catch {
        return null;
      }
    }
    function writeStr(store2, key, value) {
      try {
        if (!store2) return;
        if (value === null || value === void 0) store2.removeItem(key);
        else store2.setItem(key, value);
      } catch {
      }
    }
    const DISMISS_KEY = "winstage.dismissedSnapshot";
    const STICKY_KEY = "winstage.collapsedSticky";
    const PREF_KEY = "winstage.defaultCollapsed";
    if (readStr(sessionStore, STICKY_KEY) === "1") store.stickyCollapsed = true;
    function nextDismissed(state) {
      const { dismissed, generatedAt, remembered, defaultCollapsed, applied, pending } = state || {};
      let next = dismissed;
      if (next && next !== generatedAt) next = void 0;
      let consumed = applied === true;
      if (!consumed && pending === true && Boolean(generatedAt)) {
        consumed = true;
        if (defaultCollapsed === true) next = generatedAt;
      }
      if (!next && remembered === generatedAt) next = generatedAt;
      return { dismissed: next, applied: consumed };
    }
    function stickyCollapseNext(state) {
      const { sticky, readyEmpty, dismissedMatches, decisionCollapsed } = state || {};
      if (readyEmpty === true) return { sticky: false, collapsed: false, reset: true };
      const nextSticky = sticky === true || decisionCollapsed === true;
      return { sticky: nextSticky, collapsed: nextSticky || dismissedMatches === true, reset: false };
    }
    function isCollapsedNow(snapshot) {
      return stickyCollapseNext({
        sticky: store.stickyCollapsed === true,
        readyEmpty: Boolean(snapshot && snapshot.pending !== true),
        dismissedMatches: Boolean(snapshot && snapshot.generatedAt && store.dismissed === snapshot.generatedAt),
        decisionCollapsed: false
      }).collapsed;
    }
    function markStickyCollapsed() {
      store.stickyCollapsed = true;
      writeStr(sessionStore, STICKY_KEY, "1");
    }
    function resetStickyCollapse() {
      store.stickyCollapsed = false;
      store.dismissed = void 0;
      writeStr(sessionStore, STICKY_KEY, null);
      writeStr(sessionStore, DISMISS_KEY, null);
    }
    function collapseSnapshot(generatedAt) {
      store.dismissed = generatedAt;
      writeStr(sessionStore, DISMISS_KEY, generatedAt ?? null);
      markStickyCollapsed();
      store.publish({});
    }
    function restorePanel() {
      store.dismissed = void 0;
      writeStr(sessionStore, DISMISS_KEY, null);
      resetStickyCollapse();
      store.publish({});
    }
    function collapsedState() {
      const snapshot = store.state.snapshot;
      const pending = Boolean(snapshot && snapshot.pending === true);
      const collapsed = isCollapsedNow(snapshot);
      return { pending, collapsed, files: snapshot?.counts?.files ?? 0, generatedAt: snapshot?.generatedAt };
    }
    function opLabel(t, op) {
      if (op === "create") return t("opCreate");
      if (op === "modify") return t("opModify");
      if (op === "delete") return t("opDelete");
      if (op === "mkdir") return t("opMkdir");
      return op;
    }
    function useStoreState() {
      const [state, setState] = React.useState(store.state);
      React.useEffect(() => store.subscribe(() => setState(store.state)), []);
      return state;
    }
    function trustLine(t, trust) {
      if (!trust || typeof trust !== "object" || !trust.trust) return null;
      const level = trust.trust.level;
      const text = level === "trusted" ? t("trustTrusted") : level === "attention" ? t("trustAttention", { count: (trust.trust.blockers || []).length }) : level === "degraded" ? t("trustDegraded") : level === "lost" ? t("trustLost") : level === "write-unconfirmed" ? t("trustWriteUnconfirmed") : level === "off" ? t("trustOff") : level === "unknown" ? t("trustUnknown") : null;
      if (text === null) return null;
      const detail = t("trustDetail", {
        lane: trust.tier?.launchMode ?? "?",
        degrades: trust.firstDegrade?.degradeCount ?? 0,
        lost: trust.stageRoot?.lossCount ?? 0,
        approvals: trust.approvals?.unsettledCount ?? 0,
        writes: trust.writes?.count ?? 0,
        reads: trust.readVisibility?.reads ?? 0,
        /**
         * R11-C 修复②配套（取证用）：把**判据本身**显示出来 ——
         * `hostLevel` = 宿主 `buildTrustCard()` 给的 level；`degraded` = `tier.degraded`；
         * `tierEff` = 实际档位。这样"面板为什么这么判"可直接从截图读出，不用靠推断；
         * 万一以后 host 端判据变了，界面也会把差异暴露出来而不是静默。
         */
        hostLevel: level,
        tierEff: trust.tier?.tierEffective ?? "?",
        degraded: trust.tier?.degraded === true ? "yes" : "no",
        /**
         * D11 取证字段：这份卡来自哪个查询（`scoped` = 带 `?session=`；`unscoped` = 不带），
         * 以及补打那次是否成功。⇒ "面板与宿主路由是否同源"可直接从截图判定，
         * 不必再去猜是 host 的目录解析问题还是前端取值问题。
         */
        tierSource: trust.tierSource ?? "scoped",
        tierAlt: trust.tierAlternate ? `scoped=${trust.tierAlternate.scoped ? "tier" : "empty"}/unscoped=${trust.tierAlternate.unscoped ? "tier" : "empty"}` : "n/a"
      });
      const tierDegraded = trust.tier?.degraded === true;
      const writesUnconfirmed = (trust.writes?.count ?? 0) > 0;
      const rootLostProven = writesUnconfirmed;
      const lossCount = trust.stageRoot?.lossCount ?? 0;
      const degradeText = tierDegraded ? t("trustDegradedAction", { lane: trust.tier?.launchMode ?? "?" }) : null;
      const lossNote = lossCount > 0 ? rootLostProven ? t("trustRootLostAction") : t("trustLossNoise", { count: lossCount }) : null;
      let headline = text;
      if (tierDegraded && !rootLostProven) headline = degradeText;
      else if (level === "lost" && !rootLostProven) headline = t("trustBaseUnverifiable");
      const detailParts = [detail];
      if (lossNote && !rootLostProven) detailParts.push(lossNote);
      return {
        level,
        ok: trust.trust.ok === true,
        /** 降档提示同时进正文行（不只详情），保证可见 */
        notice: tierDegraded ? degradeText ?? null : null,
        /** 判据不足时的自述：面板拿到的那份卡片里没有档位字段（与宿主路由不同源） */
        basisNotice: level === "lost" && !rootLostProven && !tierDegraded ? t("trustBaseUnverifiable") : null,
        detail: detailParts.filter(Boolean).join(" \xB7 ")
      };
    }
    function WinStageReview({ matched, fallback, t, poller, executeCommand }) {
      const state = useStoreState();
      const [selected, setSelected] = React.useState(() => /* @__PURE__ */ new Set());
      const [expanded, setExpanded] = React.useState(() => /* @__PURE__ */ new Set());
      const [expandedNoise, setExpandedNoise] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const failures = state.failures instanceof Map ? state.failures : /* @__PURE__ */ new Map();
      const notice = state.notice;
      const pollError = typeof state.error === "string" && state.error.length > 0 ? state.error : void 0;
      const trust = trustLine(t, state.trust);
      const storeSourceText = state.storeSource === "host-route" ? t("trustSourceRoute") : state.storeSource === "legacy-compat-path" ? t("trustSourceLegacy") : void 0;
      const showFailure = (text, paths) => {
        const clean = typeof text === "string" && text.length > 0 ? text : void 0;
        const map = /* @__PURE__ */ new Map();
        if (clean && Array.isArray(paths) && paths.length > 0) {
          for (const [path, line] of failureByPath(clean, paths)) map.set(path, line);
          if (map.size === 0 && paths.length === 1) map.set(paths[0], clean);
        }
        const onPanel = new Set((state.snapshot && state.snapshot.files || []).map((file) => file.path));
        store.failureRows = new Set([...map.keys()].filter((path) => onPanel.has(path)));
        store.failureNotice = clean;
        store.publish({ notice: clean, failures: map });
      };
      const [consented, setConsented] = React.useState(() => /* @__PURE__ */ new Map());
      const [pendingConfirm, setPendingConfirm] = React.useState(null);
      React.useEffect(() => {
        if (poller && matched) poller.observe(matched.owner);
      }, [poller, matched]);
      const snapshot = state.snapshot;
      const files = snapshot && snapshot.files || [];
      const toggle = (setter, key) => {
        setter((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      };
      const toggleFile = (file) => {
        const inSet = selected.has(file.path);
        const needsConsent = riskOf(file) !== "normal" && consented.get(file.path) !== riskSignature(file);
        const granting = !inSet || needsConsent;
        const nextSelected = new Set(selected);
        const nextConsented = new Map(consented);
        if (granting) {
          nextSelected.add(file.path);
          if (riskOf(file) !== "normal") nextConsented.set(file.path, riskSignature(file));
          else nextConsented.delete(file.path);
        } else {
          nextSelected.delete(file.path);
          nextConsented.delete(file.path);
        }
        setSelected(nextSelected);
        setConsented(nextConsented);
      };
      const COMMAND_TIMEOUT_MS = 2e4;
      const act = (line, targets) => {
        if (busy) return;
        if (!matched?.sessionId) {
          showFailure(t("noSession"));
          return;
        }
        if (!executeCommand) {
          showFailure(t("commandNoOp"));
          return;
        }
        setBusy(true);
        showFailure(void 0);
        const pending = Promise.resolve().then(() => executeCommand(matched.sessionId, line));
        const timeout = new Promise((resolve) => {
          setTimeout(
            () => resolve({ kind: "error", text: t("commandTimeout", { seconds: Math.round(COMMAND_TIMEOUT_MS / 1e3) }) }),
            COMMAND_TIMEOUT_MS
          );
        });
        Promise.race([pending, timeout]).then((value) => {
          const payload = value && typeof value === "object" && value.result && typeof value.result === "object" ? value.result : value;
          const kind = payload && typeof payload.kind === "string" ? payload.kind : value === void 0 ? "error" : "success";
          if (kind !== "success") {
            const text = typeof payload?.text === "string" && payload.text.length > 0 ? payload.text : value === void 0 ? t("unknownCommand") : t("commandNoOp");
            showFailure(text, Array.isArray(targets) ? targets : void 0);
          }
        }).catch((error) => showFailure(String(error?.message ?? error), Array.isArray(targets) ? targets : void 0)).finally(() => {
          setBusy(false);
          if (poller) poller.refresh();
        });
      };
      function approveCommandLine(paths, mode, confirm) {
        const flags = `${mode === "rebase" ? "--rebase " : ""}${confirm === true ? "--confirm-mask " : ""}`;
        return `/winstage approve ${flags}${paths.map((path) => `"${path}"`).join(" ")}`;
      }
      const sendApprove = (paths, mode, confirm) => {
        act(approveCommandLine(paths, mode, confirm), paths);
      };
      const approvePaths = (paths, mode) => {
        if (paths.length === 0) {
          const frozen = files.filter((file) => file.frozenOnly === true).length;
          const risky = files.filter(
            (file) => file.frozenOnly !== true && riskOf(file) !== "normal" && !(selected.has(file.path) && consented.get(file.path) === riskSignature(file))
          ).length;
          showFailure(t("nothingToApprove", { total: files.length, frozen, risky }));
          return;
        }
        const sensitive = files.filter((file) => paths.includes(file.path) && Boolean(file.safety));
        if (sensitive.length > 0) {
          setPendingConfirm({
            paths,
            rebase: mode === "rebase",
            items: sensitive.map((file) => ({ path: file.path, reason: file.riskReason ?? null, danger: isDanger(file) }))
          });
          return;
        }
        sendApprove(paths, mode, false);
      };
      const approveSelected = () => {
        approvePaths(authorizedPaths(files, selected, consented, true), "approve");
      };
      const staleConsent = files.filter((file) => selected.has(file.path) && riskOf(file) !== "normal" && consented.get(file.path) !== riskSignature(file));
      const noiseSplit = splitNoiseFiles(files);
      const grouped = groupByRisk(noiseSplit.work);
      const groupList = [
        { key: "normal", level: t("levelL1"), label: t("groupInside"), items: grouped.normal, header: styles.groupHeader },
        {
          key: "outside",
          level: t("levelL2"),
          label: t("groupOutside"),
          items: grouped.outside,
          header: { ...styles.groupHeader, color: "var(--dsw-alias-label-primary)", borderLeft: "3px solid var(--dsw-alias-state-warn-primary)" }
        },
        {
          key: "sensitive",
          level: t("levelL3"),
          label: t("groupSensitive"),
          items: grouped.sensitive,
          header: { ...styles.groupHeader, color: "var(--dsw-alias-label-primary)", borderLeft: "3px solid var(--dsw-alias-state-error-primary)" }
        }
      ].filter((group) => group.items.length > 0);
      const riskBadge = (file) => {
        const risk = riskOf(file);
        if (risk === "normal") return null;
        const danger = isDanger(file);
        const style = danger ? { ...styles.badgeBase, ...styles.badgeDanger } : risk === "sensitive" ? { ...styles.badgeBase, ...styles.badgeSensitive } : { ...styles.badgeBase, ...styles.badgeOutside };
        const label = danger ? t("badgeDanger") : risk === "sensitive" ? t("badgeSensitive") : t("badgeOutside");
        return h("span", { style }, label);
      };
      const renderFile = (file) => {
        const open = expanded.has(file.path);
        const risk = riskOf(file);
        const danger = isDanger(file);
        const note = noteOf(file);
        const actionable = isActionable(file);
        const frozenText = actionable ? null : frozenReasonText(t, file);
        const rows = [];
        if (danger) {
          rows.push(h("div", { key: "note", style: styles.note }, note !== null ? note : t("dangerHidden")));
        } else if (file.diff && file.diff.length > 0) {
          for (const [index, line] of file.diff.entries()) {
            rows.push(
              h(
                "div",
                {
                  key: index,
                  style: line.type === "add" ? { color: "var(--dsw-alias-label-primary)" } : { color: "var(--dsw-alias-label-primary)" }
                },
                `${line.type === "add" ? "+" : "-"} ${line.text}`
              )
            );
          }
        } else if (note !== null) {
          rows.push(h("div", { key: "note", style: styles.note }, note));
        } else {
          rows.push(h("div", { key: "none", style: { opacity: 0.6 } }, t("noDiff")));
        }
        if (file.truncated) rows.push(h("div", { key: "trunc", style: { opacity: 0.6 } }, "\u2026"));
        if (!actionable) rows.push(h("div", { key: "frozen", style: styles.frozenReason }, frozenText));
        const rowStyle = risk === "normal" ? styles.fileRow : { ...styles.fileRow, ...danger ? styles.rowDanger : risk === "sensitive" ? styles.rowSensitive : styles.rowOutside };
        return h(
          "div",
          { key: file.path, style: { display: "flex", flexDirection: "column" } },
          h(
            "div",
            { style: rowStyle },
            // D1：可批准行才有勾选框；冻结存档行放一个**不可交互**的「存档」徽章
            actionable ? h("input", {
              ...DR,
              type: "checkbox",
              checked: selected.has(file.path),
              onChange: () => toggleFile(file),
              "aria-label": file.path,
              title: risk === "normal" ? file.path : t("riskCheckHint", { path: file.path })
            }) : h("span", { ...DR, style: styles.frozenBadge, "data-winstage-frozen": "1", title: frozenText }, t("frozenBadge")),
            h(
              "button",
              {
                ...DR,
                type: "button",
                style: styles.path,
                onClick: () => toggle(setExpanded, file.path),
                title: file.path
              },
              h("span", { style: { ...styles.badge, marginRight: "6px" } }, opLabel(t, file.op)),
              riskBadge(file),
              file.path
            ),
            h("span", { style: styles.meta }, t("reviewCounts", { added: file.totals?.added ?? 0, removed: file.totals?.removed ?? 0 })),
            file.baselineStale === true && h(
              "span",
              { ...DR, "data-winstage-baseline-stale": "1", style: styles.staleBadge, title: t("baselineStaleTitle") },
              t("baselineStale")
            )
          ),
          // 缺陷②（F5b）：**逐行**说清是哪种漂移（"真实文件在暂存后出现"等）。
          // 只靠一个"基线已过期"徽标，用户看不出磁盘上已经有一份内容而批准会覆盖它。
          file.baselineStale === true && h(
            "div",
            { ...DR, "data-winstage-baseline-stale-note": "1", style: styles.staleNote },
            baselineStaleReasonText(t, file) ?? t("baselineStaleDrifted")
          ),
          risk !== "normal" && h("div", { style: styles.riskReason }, file.riskReason ? t("riskReason", { reason: file.riskReason }) : t("riskReasonUnknown")),
          !actionable && h("div", { style: styles.frozenReason, ...DR }, frozenText),
          // 失败原因**原地**贴在这一条下面（store 里的逐条映射；不在视野内的问题随之消失）
          failures.has(file.path) && h(
            "div",
            { ...DR, "data-winstage-row-error": "1", style: styles.rowError },
            t("rowFailed", { message: failures.get(file.path) })
          ),
          open && h("pre", { style: styles.diff }, ...rows)
        );
      };
      const levels = levelCounts(files, snapshot?.riskCounts, snapshot?.truncated, snapshot?.counts?.totalFiles ?? snapshot?.counts?.files);
      const summaryText = t("reviewLevels", {
        files: `${levels.total}${levels.truncated ? "+" : ""}`,
        levels: levelSegments(levels, t).join(" \xB7 ")
      });
      const alert = state.alert;
      const approveAll = () => {
        approvePaths(authorizedPaths(files, selected, consented), "approve");
      };
      const rebaseAndApprove = () => {
        approvePaths(authorizedPaths(files, selected, consented), "rebase");
      };
      const confirmDialog = pendingConfirm && h(
        "div",
        { role: "dialog", "aria-modal": "true", ...DR, "data-winstage-confirm": "1", style: styles.confirmBackdrop, onClick: () => setPendingConfirm(null) },
        h(
          "div",
          { style: styles.confirmCard, ...DR, onClick: (event) => event.stopPropagation() },
          h("div", { style: styles.confirmTitle }, t("confirmTitle", { count: pendingConfirm.items.length })),
          h("div", { style: styles.confirmBody }, t("confirmBody")),
          h(
            "div",
            { style: styles.confirmList },
            ...pendingConfirm.items.map(
              (item) => h(
                "div",
                { key: item.path, style: styles.confirmItem, ...DR },
                h("div", { style: styles.confirmPath }, item.path),
                item.reason ? h("div", { style: styles.confirmReason }, t("confirmReason", { reason: item.reason })) : null,
                item.danger ? h("div", { style: styles.confirmDanger }, t("confirmDanger")) : null
              )
            )
          ),
          h(
            "div",
            { style: styles.confirmActions },
            h("button", { ...DR, type: "button", style: styles.button, disabled: busy, onClick: () => setPendingConfirm(null) }, t("confirmCancel")),
            h(
              "button",
              {
                ...DR,
                type: "button",
                style: { ...styles.button, ...styles.danger },
                disabled: busy,
                "data-winstage-confirm-accept": "1",
                onClick: () => {
                  const pending = pendingConfirm;
                  setPendingConfirm(null);
                  sendApprove(pending.paths, pending.rebase ? "rebase" : "approve", true);
                }
              },
              t("confirmAccept")
            )
          )
        )
      );
      const panelElement = h(
        "div",
        { style: styles.root, ...DR, "data-winstage-panel": "1" },
        h(
          "div",
          { style: styles.card, ...DR },
          h(
            "div",
            { style: styles.strip, ...DR },
            h("span", null, t("reviewTitle")),
            // G4（独立复核）：要求 4 说"在面板标题处显示汇总" ⇒ 摘要在**标题条里**，
            // 正文首行只留文件数。位置改了、内容一字未减（`summaryText` 同一份）。
            h("span", { style: styles.stripSummary }, summaryText),
            h("span", { style: { opacity: 0.8 } }, t("reviewWaiting")),
            h(
              "span",
              { style: { marginLeft: "auto", display: "flex", gap: "8px", alignItems: "center" } },
              h("span", null, t("reviewFiles", { files: files.length })),
              h("span", null, t("reviewCounts", { added: snapshot?.counts?.additions ?? 0, removed: snapshot?.counts?.deletions ?? 0 }))
            )
          ),
          h(
            "div",
            { style: styles.body },
            // alerts：**非阻断**横幅（没有按钮、不需要点掉；点批准/拒绝照样能用）
            alert && h(
              "div",
              { role: "status", style: styles.alert, ...DR },
              h("div", { style: styles.alertTitle }, t("alertTitle", { count: alert.count ?? 0 })),
              alert.message ? h("div", { style: styles.alertText }, String(alert.message)) : null,
              h("div", { style: styles.alertHint }, alert.hint ? String(alert.hint) : t("alertHint"))
            ),
            h("div", { style: { fontSize: "12px", opacity: 0.6, wordBreak: "break-all" } }, snapshot?.workspaceRoot ?? ""),
            // ── WP3：可信性状态卡（**用户侧**；AI 侧零注入 —— 命令 stdout/stderr 不含它）──
            trust && h(
              "div",
              {
                ...DR,
                "data-winstage-trust": trust.level,
                role: "status",
                style: {
                  fontSize: "12px",
                  marginTop: "2px",
                  color: trust.ok ? "inherit" : "var(--dsw-alias-state-error-primary, #b3261e)",
                  opacity: trust.ok ? 0.85 : 1
                }
              },
              h("span", { style: { fontWeight: 600 } }, `${t("trustLabel")}\uFF1A`),
              h("span", { ...trust.notice ? { "data-winstage-trust-notice": "1" } : {} }, trust.text),
              // R11-C 修复②：降档提示**单独一行**（不是只挂在详情里）—— 保证"沙箱已降级"
              // 这件事在面板上可见，而不是只活在 12 px 灰字的 `档位 …` 摘要里。
              trust.notice && trust.notice !== trust.text ? h(
                "div",
                {
                  ...DR,
                  "data-winstage-trust-notice": "1",
                  style: { marginTop: "2px", fontWeight: 600 }
                },
                trust.notice
              ) : null,
              // R11-C 修复②（第二处误导）：判据不足时的自述行（与降档提示分开，便于取证区分）
              trust.basisNotice ? h(
                "div",
                {
                  ...DR,
                  "data-winstage-trust-basis-notice": "1",
                  style: { marginTop: "2px", fontWeight: 600 }
                },
                trust.basisNotice
              ) : null,
              h("div", { style: { opacity: 0.75, marginTop: "2px" } }, trust.detail),
              storeSourceText ? h("div", { style: { opacity: 0.6, marginTop: "2px" }, "data-winstage-store-source": state.storeSource }, storeSourceText) : null
            ),
            // 兜底读法（路由不可用）即使没拿到卡片也必须可见：否则用户只会看到"没有待审"
            !trust && storeSourceText ? h("div", { style: { fontSize: "12px", opacity: 0.6 }, "data-winstage-store-source": state.storeSource }, storeSourceText) : null,
            // D1：把"N 项里有多少项是不可批准的存档行"直接说清 —— 否则用户会以为
            // 计数里的每一条都能勾、都能批。
            (snapshot?.counts?.frozenOnly ?? 0) > 0 && h(
              "div",
              { ...DR, "data-winstage-frozen-summary": "1", style: styles.frozenSummary },
              t("frozenSummary", { count: snapshot.counts.frozenOnly })
            ),
            // 基线已过期：**必须**在正文里说清，否则用户只会看到一条必然失败的"批准"
            (snapshot?.counts?.staleBaseline ?? 0) > 0 && h(
              "div",
              { ...DR, "data-winstage-stale-summary": "1", style: styles.staleSummary },
              t("staleSummary", { count: snapshot.counts.staleBaseline })
            ),
            // Method A 主线：AI 进程树读了/改了什么的分类统计（宿主 `snapshot.audit`）。
            // 没有审计（未开启/本会话无记录）时**不渲染**，绝不显示空括号。
            snapshot?.audit?.summary && h(
              "div",
              { ...DR, "data-winstage-audit": "1", style: { fontSize: "12px", opacity: 0.85, marginTop: "2px" } },
              t("auditSummary", {
                read: snapshot.audit.summary.filesRead ?? 0,
                write: snapshot.audit.summary.filesWritten ?? 0,
                inws: snapshot.audit.summary.filesWrittenInWorkspace ?? 0,
                outside: snapshot.audit.summary.filesWrittenOutside ?? 0,
                deleted: snapshot.audit.summary.filesDeleted ?? 0,
                rread: snapshot.audit.summary.registryRead ?? 0,
                rwrite: snapshot.audit.summary.registryWritten ?? 0
              })
            ),
            ...groupList.map(
              (group) => h(
                "div",
                { key: group.key, style: { display: "flex", flexDirection: "column" } },
                h(
                  "div",
                  { style: group.header },
                  h("span", { style: styles.groupBadge, ...DR }, group.level),
                  h("span", null, group.label),
                  h("span", { style: styles.groupCount }, `(${group.items.length})`)
                ),
                ...group.items.map(renderFile)
              )
            ),
            // ── M5：沙箱自身副作用 / PowerShell 临时探针（默认折叠，仍可勾选可批准）──
            noiseSplit.noise.length > 0 && h(
              "div",
              { "data-winstage-noise": "1", style: { display: "flex", flexDirection: "column", marginTop: "4px" } },
              h(
                "button",
                {
                  ...DR,
                  type: "button",
                  "aria-expanded": expandedNoise ? "true" : "false",
                  style: styles.groupHeader,
                  title: t("noiseHint"),
                  onClick: () => setExpandedNoise((current) => !current)
                },
                h("span", { style: styles.groupBadge, ...DR }, t("noiseBadge")),
                h(
                  "span",
                  null,
                  t("noiseSummary", { count: noiseSplit.noise.length, work: noiseSplit.work.length })
                ),
                h("span", { style: styles.groupCount }, expandedNoise ? "\u25BE" : "\u25B8")
              ),
              expandedNoise ? h("div", { style: { opacity: 0.7, fontSize: "12px", padding: "2px 0" } }, t("noiseHint")) : null,
              ...expandedNoise ? noiseSplit.noise.map(renderFile) : []
            ),
            (notice || pollError) && h(
              "div",
              { role: "alert", "data-winstage-notice": "1", style: { fontSize: "12px", color: "var(--dsw-alias-state-error-primary, #b3261e)" } },
              t("failed", { message: notice ?? pollError })
            ),
            busy && h("div", { style: { fontSize: "12px", opacity: 0.7 } }, t("busy"))
          ),
          h(
            "div",
            { style: styles.actionRow },
            h(
              "button",
              {
                ...DR,
                type: "button",
                style: styles.button,
                disabled: busy,
                title: t("selectAllScope"),
                onClick: () => setSelected(new Set(selectablePaths(files)))
              },
              t("selectAll")
            ),
            h("button", { ...DR, type: "button", style: styles.button, disabled: busy, onClick: () => setSelected(/* @__PURE__ */ new Set()) }, t("clearSelection")),
            h(
              "button",
              {
                ...DR,
                type: "button",
                style: styles.button,
                disabled: busy,
                onClick: () => collapseSnapshot(snapshot?.generatedAt)
              },
              t("dismiss")
            ),
            h(
              "button",
              {
                ...DR,
                type: "button",
                style: { ...styles.button, ...styles.danger },
                disabled: busy,
                onClick: () => act("/winstage reject")
              },
              t("rejectAll")
            ),
            selected.size > 0 && h(
              "button",
              { type: "button", style: { ...styles.button, ...styles.primary }, disabled: busy, onClick: approveSelected },
              t("approveSelected")
            ),
            /**
             * 缺陷②（F5b）：**基线已过期**时，拒绝文案给出的出路必须在面板上**可点**。
             *
             * 背景：旧设计删掉了「重新对齐基线」按钮，理由是"每次修改都自动对齐"——
             * 而"自动对齐"正是缺陷②要拿掉的那条丢数据路径。现在有损漂移不会被自动对准、
             * 批准会被 `STALE_BASELINE` 拒绝，如果面板上再没有按钮，用户就被卡在
             * "点批准失败 → 让你 rebase → 没有按钮"里。
             *
             * 只对**已勾选**的项出现，并且走 `authorizedPaths()` 同一份可写集合
             * （不比普通「批准所选」多覆盖任何一个文件，只是先把它们对齐到真实文件）；
             * 命令面是既有的 `/winstage approve --rebase`，不是新流程。
             */
            selected.size > 0 && files.some((file) => selected.has(file.path) && file.baselineStale === true && isActionable(file)) && h(
              "button",
              {
                ...DR,
                type: "button",
                "data-winstage-rebase-selected": "1",
                style: styles.button,
                disabled: busy,
                title: t("baselineStaleTitle"),
                onClick: rebaseAndApprove
              },
              t("rebaseAndApprove")
            ),
            // ★ 不再有「重新对齐基线」**全局**按钮（用户要求）：全局对齐会把**没有勾选**的
            //   条目也一起对齐，而"对齐"对**有损**漂移来说就是"把外部写入变成可批准"。
            //   缺陷②（F5b）之后：无损漂移仍会自动对准；有损漂移必须在面板上**显式**处理 ⇒
            //   上面那个「重新对齐并批准所选」（只对已勾选、且只走 authorizedPaths 的可写集合）
            //   就是唯一入口，终端仍有 `/winstage rebase`。
            h(
              "button",
              {
                ...DR,
                type: "button",
                style: { ...styles.button, ...styles.primary },
                disabled: busy,
                onClick: approveAll
              },
              t("approveAll")
            ),
            // 内联文案说清「批准全部」的范围（**不用弹窗拦截**）
            h("div", { style: styles.actionHint }, t("approveAllScope")),
            // G1：档位变化导致授权失效时，用**内联**文案说明（不弹窗、不阻断其它操作）
            staleConsent.length > 0 && h("div", { style: styles.staleNotice, ...DR }, t("consentStale", { count: staleConsent.length }))
          )
        ),
        confirmDialog
      );
      if (fallback) {
        return h(
          "div",
          {
            "data-winstage-review-split": "1",
            style: { display: "flex", flexDirection: "column", gap: "8px", minWidth: 0 }
          },
          panelElement,
          fallback
        );
      }
      return panelElement;
    }
    function WinStagePermission({ locked, sessionId, t, openPanel, executeCommand, setEnabled }) {
      const state = useStoreState();
      const snapshot = state.snapshot;
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const boxRef = React.useRef(null);
      React.useEffect(() => {
        if (!open) return void 0;
        const onDoc = (event) => {
          if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener("mousedown", onDoc);
        return () => document.removeEventListener("mousedown", onDoc);
      }, [open]);
      const files = snapshot?.counts?.files ?? 0;
      const stale = snapshot?.counts?.staleBaseline ?? 0;
      const run = (line) => {
        if (busy) return;
        if (!sessionId || !executeCommand) {
          store.publish({ notice: t("commandNoOp") });
          return;
        }
        setBusy(true);
        Promise.resolve().then(() => executeCommand(sessionId, line)).then((value) => {
          const payload = value && typeof value === "object" && value.result && typeof value.result === "object" ? value.result : value;
          const kind = payload && typeof payload.kind === "string" ? payload.kind : value === void 0 ? "error" : "success";
          if (kind !== "success") {
            store.publish({
              notice: typeof payload?.text === "string" && payload.text.length > 0 ? payload.text : value === void 0 ? t("unknownCommand") : t("commandNoOp")
            });
          }
        }).catch((error) => store.publish({ notice: String(error?.message ?? error) })).finally(() => setBusy(false));
      };
      return h(
        "div",
        { ref: boxRef, style: styles.permRoot, ...DR, "data-winstage-permission": "1" },
        h(
          "button",
          {
            ...DR,
            type: "button",
            "aria-haspopup": "true",
            "aria-expanded": open ? "true" : "false",
            disabled: locked,
            style: styles.permTrigger,
            title: t("permTitle"),
            onClick: () => setOpen((value) => !value)
          },
          h("span", { style: styles.permMark, "aria-hidden": "true" }, "W"),
          h("span", { style: styles.permLabel }, files > 0 ? t("permPending", { files }) : t("permIdle")),
          stale > 0 && h("span", { style: styles.permDot, title: t("baselineStaleTitle") }, "!"),
          h("span", { style: { ...styles.permChevron, transform: open ? "rotate(180deg)" : "none" } }, "\u25BE")
        ),
        open && h(
          "div",
          { role: "menu", style: styles.permMenu, ...DR },
          files > 0 ? h(
            "button",
            {
              ...DR,
              type: "button",
              role: "menuitem",
              style: styles.permItem,
              onClick: () => {
                setOpen(false);
                openPanel();
              }
            },
            t("permOpenPanel", { files })
          ) : h(
            "button",
            {
              ...DR,
              type: "button",
              role: "menuitem",
              style: styles.permItem,
              disabled: busy,
              onClick: () => {
                setOpen(false);
                run("/winstage refresh");
                openPanel();
              }
            },
            t("permRefresh")
          ),
          // 「重新对齐基线」菜单项已删除（与卡片按钮同一决定：对齐是自动的，
          //  见审阅卡片处注释）。要立刻处理时终端仍有 `/winstage rebase`。
          h(
            "button",
            {
              ...DR,
              type: "button",
              role: "menuitem",
              style: { ...styles.permItem, ...styles.permItemDanger },
              onClick: () => {
                setOpen(false);
                Promise.resolve(setEnabled(false)).then((ok) => {
                  if (ok === false) store.publish({ notice: t("error") });
                }).catch((error) => store.publish({ notice: `${t("error")}\uFF08${String(error?.message ?? error)}\uFF09` }));
              }
            },
            t("permDisable")
          ),
          h("div", { style: styles.permHint }, t("permDisableHint"))
        )
      );
    }
    function WinStageChip({ t }) {
      const state = useStoreState();
      const snapshot = state.snapshot;
      const pending = Boolean(snapshot && snapshot.pending === true);
      const collapsed = isCollapsedNow(snapshot);
      if (!pending || !collapsed) return null;
      const levels = levelCounts(snapshot.files, snapshot.riskCounts, snapshot.truncated, snapshot.counts?.totalFiles ?? snapshot.counts?.files);
      const segments = levelSegments(levels, t).join(" \xB7 ");
      const filesText = `${levels.total}${levels.truncated ? "+" : ""}`;
      const label = segments.length > 0 ? t("chipLabelLevels", { files: filesText, levels: segments }) : t("chipLabel", { files: filesText });
      return h(
        "div",
        { style: styles.chipRow, ...DR, "data-winstage-chip": "1" },
        h(
          "button",
          { ...DR, type: "button", style: styles.chip, title: t("chipTitle"), onClick: () => restorePanel() },
          label
        )
      );
    }
    function WinStageRow({ useValue, setEnabled, readStaging, t }) {
      const snapshot = useValue((s) => s);
      const [busy, setBusy] = React.useState(false);
      const [failed, setFailed] = React.useState(false);
      const [liveFacts, setLiveFacts] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        if (typeof readStaging !== "function") return () => {
        };
        Promise.resolve().then(() => readStaging()).then((facts) => {
          if (alive && facts) setLiveFacts(facts);
        }).catch(() => {
        });
        return () => {
          alive = false;
        };
      }, [readStaging]);
      const [prefCollapsed, setPrefCollapsed] = React.useState(() => readStr(localStore, PREF_KEY) === "1");
      const [lastAttempt, setLastAttempt] = React.useState(null);
      const writable = snapshot && snapshot.status === "ready" && snapshot.writable !== false;
      const value = snapshot && snapshot.value ? snapshot.value : void 0;
      const enabled = value && typeof value.enabled === "boolean" ? value.enabled : true;
      const unavailable = Boolean(snapshot && (snapshot.status === "unavailable" || snapshot.writable === false));
      const liveStaging = (liveFacts && typeof liveFacts === "object" ? liveFacts : void 0) ?? (store.state.staging && typeof store.state.staging === "object" ? store.state.staging : void 0);
      const liveEffective = liveStaging && liveStaging.effective === true ? "on" : liveStaging && liveStaging.effective === false ? "off" : "unknown";
      const liveOverride = liveStaging && liveStaging.shellOverride && liveStaging.shellOverride.forced === true;
      const liveOverrideText = liveStaging && liveStaging.shellOverride && typeof liveStaging.shellOverride.text === "string" ? liveStaging.shellOverride.text : null;
      const liveMismatch = liveStaging && liveStaging.mismatch && typeof liveStaging.mismatch === "object" ? liveStaging.mismatch : null;
      const statusText = unavailable ? t("unavailable") : !snapshot || snapshot.status === "loading" ? t("loading") : enabled ? t("on") : t("off");
      const stagingFaces = liveStaging && liveStaging.faces && typeof liveStaging.faces === "object" ? liveStaging.faces : null;
      const fileFaceText = !liveStaging ? null : liveStaging.effective === true ? t("faceFileOn") : liveStaging.effective === false ? t("faceFileOff") : null;
      const shellFaceText = !liveStaging ? null : liveStaging.shellOverride && liveStaging.shellOverride.forced === true ? String(liveStaging.shellOverride.value) === "1" ? t("faceShellEnvOn") : t("faceShellEnvOff") : stagingFaces ? t("faceShellFollow") : null;
      const faceText = [fileFaceText, shellFaceText].filter(Boolean).join(" \xB7 ");
      const effectiveText = faceText || (liveOverride && liveEffective !== "unknown" ? `${t("forcedPrefix")} ${liveEffective === "on" ? t("effectiveOn") : t("effectiveOff")} \xB7 ${liveOverrideText}` : liveMismatch ? `${t("effectivePrefix")} ${liveMismatch.effective === true ? t("effectiveOn") : t("effectiveOff")}` : null);
      const switchStyle = {
        position: "relative",
        flex: "0 0 auto",
        width: "38px",
        height: "22px",
        padding: 0,
        borderRadius: "999px",
        border: "1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.35))",
        background: enabled ? "var(--dsw-alias-brand-primary, #247bbf)" : "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.2))",
        cursor: writable && !busy ? "pointer" : "default",
        opacity: writable && !busy ? 1 : 0.55,
        transition: "background .15s, opacity .15s"
      };
      const knobStyle = {
        position: "absolute",
        top: "50%",
        left: enabled ? "19px" : "3px",
        transform: "translateY(-50%)",
        width: "14px",
        height: "14px",
        borderRadius: "50%",
        background: "var(--dsw-alias-bg-layer-1, #fff)",
        transition: "left .15s",
        pointerEvents: "none"
      };
      return h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: "16px",
            padding: "12px 0",
            borderBottom: "1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.2))"
          }
        },
        h(
          "div",
          { style: { flex: "1 1 auto", minWidth: 0 } },
          h(
            "div",
            { style: { fontSize: "13px", color: "var(--dsw-alias-text-l1, inherit)", lineHeight: "20px" } },
            t("title"),
            h("span", { style: { marginLeft: "8px", fontSize: "12px", opacity: 0.6 } }, statusText)
          ),
          h("div", { style: { marginTop: "2px", fontSize: "12px", opacity: 0.6, lineHeight: "18px" } }, t("description")),
          /**
           * R12 修复 · D7-d：**生效值那一行**（配置值与生效值不一致 / 被环境变量强制时出现）。
           *
           * `data-winstage-staging-effective` 是给 GUI 验收的稳定锚点：
           * 逐字读出 `on|off|unknown`，就能判定"界面说的"是不是"事实"。
           */
          h(
            "div",
            {
              ...DR,
              style: { marginTop: "2px", fontSize: "12px", lineHeight: "18px", opacity: 0.85 },
              "data-winstage-staging-effective": liveEffective,
              "data-winstage-staging-forced": liveOverride ? "1" : "0",
              ...liveMismatch ? { "data-winstage-staging-mismatch": "1" } : {}
            },
            effectiveText ? `${statusText} \xB7 ${effectiveText}` : null
          ),
          /**
           * R12 修复 · D7-c：开关"点了没反应"必须给出**可读原因与出路**。
           *
           * 三种已知成因各有各的出路，且都是**用户可核对的事实**：
           *   · 进程环境变量强制（`WINSTAGE_SHELL`）—— 换 `WINSTAGE_SHELL=0` 重启宿主；
           *   · profile 覆盖层固定 —— 改 `%DSH_HOME%\profiles\<profile>\cordis.patch.yml`；
           *   · 设置面不可写（`writable === false`）—— 命中上面 `unavailable` 的既有分支。
           */
          liveOverride ? h("div", { ...DR, style: { marginTop: "4px", fontSize: "12px", opacity: 0.75 }, "data-winstage-staging-forced-note": "1" }, t("forcedHint")) : null,
          // S3e 第 2 条退路：默认展开/默认收起。纯客户端偏好（localStorage），
          // 不改 host 的 Config schema（那不在本任务写范围），因此不需要重启就能生效。
          h(
            "button",
            {
              ...DR,
              type: "button",
              style: styles.inlineToggle,
              title: t("defaultCollapsedHint"),
              onClick: () => {
                const next = readStr(localStore, PREF_KEY) === "1" ? "0" : "1";
                writeStr(localStore, PREF_KEY, next);
                setPrefCollapsed(next === "1");
              }
            },
            prefCollapsed ? t("defaultCollapsedOn") : t("defaultCollapsedOff")
          ),
          unavailable && h("div", { style: { marginTop: "4px", fontSize: "12px", opacity: 0.7 } }, t("unavailable")),
          failed && h("div", { role: "alert", style: { marginTop: "4px", fontSize: "12px" } }, t("error")),
          /**
           * R12 修复 · D7-c：**点击结果的可见回执**（成功/失败/抛错三类，逐字可读）。
           * 旧实现失败时只显示 `error` 文案，`ok === undefined`（通道没回值）时**什么都不显示**
           * —— 那正是"无声 no-op"在界面上的样子。
           */
          lastAttempt ? h(
            "div",
            {
              ...DR,
              style: { marginTop: "4px", fontSize: "12px", opacity: 0.85 },
              "data-winstage-toggle-attempt": lastAttempt
            },
            lastAttempt === "accepted" ? t("toggleAccepted") : lastAttempt === "rejected" ? t("toggleRejected") : `${t("toggleThrew")} ${lastAttempt.replace(/^threw:/, "")}`
          ) : null
        ),
        h(
          "button",
          {
            ...DR,
            // 设置行的开关同样自绘，同样跳过 Dark Reader 二次改色
            type: "button",
            role: "switch",
            "aria-checked": enabled ? "true" : "false",
            "aria-label": t("title"),
            disabled: !writable || busy,
            style: switchStyle,
            onClick: () => {
              if (!writable || busy) return;
              setFailed(false);
              setBusy(true);
              setLastAttempt(null);
              Promise.resolve(setEnabled(!enabled)).then((ok) => {
                if (ok === false) {
                  setFailed(true);
                  setLastAttempt("rejected");
                } else {
                  setLastAttempt("accepted");
                }
                if (typeof readStaging === "function") {
                  Promise.resolve().then(() => readStaging()).then((facts) => {
                    if (facts) setLiveFacts(facts);
                  }).catch(() => {
                  });
                }
              }).catch((error) => {
                setFailed(true);
                setLastAttempt(`threw:${String(error?.message ?? error).slice(0, 120)}`);
              }).finally(() => setBusy(false));
            }
          },
          h("span", { style: knobStyle })
        )
      );
    }
    return {
      /** settings 通道（configForms）+ 槽位 + 本地化 + 只读文件/命令 Remote */
      inject: ["slots", "locale", "configForms", "remote", "remote.workspaceFiles", "remote.commands"],
      /**
       * ★ WP3-B：**离线断言的接缝**（不是新契约、不参与 DSH 装配）。
       *
       * 为什么必须开这个口：上面那些函数都在 factory 闭包里，外部只能通过"跑轮询 + 桩 ctx"
       * 才能间接打到它们。把真正决定"读哪一份快照"的三个入口亮出来，断言就能直接问
       * 三个问题（顺序即优先级）：
       *   ① `readReviewViaRoute()` 走的是宿主路由吗？
       *   ② 路由不可用时才落到 `readReviewViaLegacyPath()`（兼容旧布局）吗？
       *   ③ 返回的 `source` 如实标出来源了吗？
       */
      __winstageTestHooks: {
        PANEL_SNAPSHOT_ROUTE,
        PANEL_TRUST_ROUTE,
        readReview,
        readReviewViaRoute,
        readReviewViaLegacyPath,
        readTrustCard,
        trustLine,
        storeSourceOf: () => store.state.storeSource
      },
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, dicts), "winstage-sandbox: dictionaries");
        ctx.effect(() => {
          const style = document.createElement("style");
          style.setAttribute("data-winstage-composer-unhide", "1");
          style.textContent = COMPOSER_FALLBACK_UNHIDE_CSS;
          document.head.appendChild(style);
          return () => {
            try {
              style.remove();
            } catch {
            }
          };
        }, "winstage-sandbox: keep the composer bar visible while the panel is up");
        const form = ctx.configForms.get(NAMESPACE);
        const poller = createPoller(ctx, form);
        ctx.effect(() => () => poller.dispose(), "winstage-sandbox: review poller");
        try {
          const debug = typeof location !== "undefined" && /[?&]winstageDebug=1/.test(location.search);
          if (debug) {
            const face = ctx.configForms.describe();
            const dump = (tag) => {
              const snap = face.getSnapshot();
              const view = snap && snap.view;
              const namespaces = (view && view.namespaces ? view.namespaces : []).map((n) => n.ns);
              console.log("[winstage] configForms.describe()", tag, {
                status: snap && snap.status,
                error: snap && snap.error,
                writable: view && view.writable,
                hasDocument: view && view.hasDocument,
                namespaceCount: namespaces.length,
                namespaces,
                containsMine: namespaces.indexOf(NAMESPACE) >= 0,
                namespaceSuffixMatches: namespaces.filter((n) => String(n).indexOf("winstage") >= 0),
                myFormStatus: form.getSnapshot() && form.getSnapshot().status,
                review: {
                  status: store.state.status,
                  error: store.state.error,
                  counts: store.state.snapshot ? store.state.snapshot.counts : void 0,
                  workspaceRoot: store.state.workspaceRoot
                }
              });
            };
            dump("initial");
            const off = face.subscribe(() => dump("changed"));
            ctx.effect(() => off, "winstage-sandbox: debug describe subscription");
          }
        } catch (error) {
          console.log("[winstage] debug dump failed", error);
        }
        ctx.slots.inject(
          "settings.general.item",
          () => ctx.slots.register(
            {
              name: "settings.general.item",
              id: "winstage-sandbox",
              order: 40,
              locale: LOCALE_NS,
              inject: () => ({
                hooks: { value: form },
                setEnabled: (next) => form.set("enabled", next),
                /**
                 * R12 修复 · D7-d：给设置行一个**与会话无关**的读法，读它自己的根。
                 *
                 * 为什么必须是"行自己读"：面板的轮询器只在**有会话**时才跑
                 * （`observe(owner)` 才拿到 sessionId），而设置页可能在**没有任何会话**时
                 * 打开 —— R12 GUI 实测第一版就是这个形态：行内读到了 `unknown`，
                 * 于是"生效值"那一行显示不出来，用户仍然只看到配置值。
                 * 这里直接用与面板**同一个** `readReview()`（同一路由、同一自校验），
                 * 只是根来自本行 config，因此不需要会话身份即可读。
                 */
                readStaging: async () => {
                  const snap = form && typeof form.getSnapshot === "function" ? form.getSnapshot() : void 0;
                  const val = snap && snap.value || {};
                  const root = typeof val.workspaceRoot === "string" ? val.workspaceRoot.trim() : "";
                  if (root.length === 0) return void 0;
                  const sid = store.state.sessionId;
                  try {
                    const read = await readReview(ctx, sid, root);
                    if (read && read.snapshot && read.snapshot.staging) return read.snapshot.staging;
                    if (read && read.staging) return read.staging;
                    return void 0;
                  } catch {
                    return void 0;
                  }
                }
              })
            },
            WinStageRow
          )
        );
        let lastElected = false;
        const route = (owner) => {
          queueMicrotask(() => poller.observe(owner));
          const matched = routeOf(owner);
          lastElected = matched !== null;
          return matched ? { ...matched, owner } : null;
        };
        const composerEntry = {
          name: "conversation.composer",
          priority: COMPOSER_PRIORITY,
          select: route,
          locale: LOCALE_NS,
          inject: () => ({
            poller,
            executeCommand: (sessionId, line) => runCommand(ctx, sessionId, line)
          })
        };
        ctx.slots.inject("conversation.composer", () => {
          let dispose = null;
          const remount = () => {
            if (dispose) dispose();
            dispose = ctx.slots.register(composerEntry, WinStageReview);
          };
          remount();
          lastElected = poller.shouldElect();
          const off = store.subscribe(() => {
            const should = poller.shouldElect();
            if (should === lastElected) return;
            lastElected = should;
            remount();
          });
          return () => {
            off();
            if (dispose) dispose();
            dispose = null;
          };
        });
        try {
          ctx.slots.inject(
            "conversation.input.dock",
            () => ctx.slots.register(
              {
                name: "conversation.input.dock",
                id: "winstage-sandbox-chip",
                // T3b（用户诉求）：chip 必须渲染在**发送按钮那一行**与**任务元素**之上。
                //
                // 为什么是"把 order 变成 dock 里最小的"：
                //   · 平台在这条 list 槽位上已有的条目及其 order 是
                //       todo = 0、goal = 10、queue = 20（`dsh-client-ui-conversation` / `dsh-client-ui-goal`）；
                //     list 槽位按 `(priority ?? 0)` 再按 `(order ?? 0)` **升序**排
                //     （`dsh-client-ui-slots/lib/index.js:221`）。
                //     旧值 30 ⇒ chip 排在最后，正好**压在任务元素下面**（但在发送行上面）。
                //   · dock 整块本身排在发送行之前：宿主 `composerStack` 的子节点顺序是
                //       [HeroShell?, heroWorkspaceRow?, renderSlot('conversation.input.dock'),
                //        inputBar = renderSlot('conversation.composer.bar')]
                //     （`dsh-client-ui-conversation/lib/client.js:16224-16235`），
                //     且该容器是 `flex-direction: column`（`wSkVaW_composerStack`，同文件 :15721）
                //     ⇒ **DOM 顺序 = 视觉顺序**，dock 恒在发送行上方。
                //   ⇒ 取 −10（< todo 的 0）即同时满足"在任务元素之上"与"在发送行之上"。
                // 只改排序值：不换槽位、不改 priority、不碰选举逻辑。
                order: -10,
                locale: LOCALE_NS
              },
              WinStageChip
            )
          );
        } catch (error) {
          console.log("[winstage] reopen-chip slot registration failed:", error);
        }
        const permissionEntry = {
          name: "conversation.input.permission",
          priority: PERMISSION_PRIORITY,
          locale: LOCALE_NS,
          inject: () => ({
            openPanel: restorePanel,
            executeCommand: (targetSessionId, line) => runCommand(ctx, targetSessionId, line),
            setEnabled: (next) => form.set("enabled", next)
          })
        };
        try {
          ctx.slots.inject("conversation.input.permission", () => {
            let dispose = null;
            const readEnabled = () => readSwitch(form) === "on";
            const sync = () => {
              const on = readEnabled();
              if (on && !dispose) dispose = ctx.slots.register(permissionEntry, WinStagePermission);
              else if (!on && dispose) {
                dispose();
                dispose = null;
              }
            };
            sync();
            const offForm = form && typeof form.subscribe === "function" ? form.subscribe(sync) : () => {
            };
            const offStore = store.subscribe(sync);
            return () => {
              offForm();
              offStore();
              if (dispose) dispose();
              dispose = null;
            };
          });
        } catch (error) {
          console.log("[winstage] permission-slot takeover failed:", error);
        }
      }
    };
  }
});
