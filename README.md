# 峰谷价状态与余额 · `@local/dsh-peak-status`

DeepSeek Harness 插件：在顶部一栏显示 **当前是峰价还是谷价 / 距下次切换还有多久 / 账号剩余余额 / 本会话费用**；峰价时段工作时弹出一次提醒，回复「暂停」即进入收尾；双击胶囊可查看余额明细与本会话 Token 用量。

## 安装

1. 把本仓库克隆或下载到本地任意目录（目录里应当有 `package.json`）。
2. 在 Harness 里打开插件管理，选择「安装本地包 / install bundle」，把该目录的**绝对路径**传进去；也可以用 `plugin_manager` 工具，`action: install_bundle`、`target: <目录绝对路径>`。
3. 安装是 **link 方式**：插件运行时直接读这个目录，所以不要移动或删除它，否则插件会失效。改完 `index.js` 需要在插件管理里禁用再启用该行才会热生效；改完 `client.js` 需要刷新一次页面。
4. 卸载：插件管理里移除 bundle，或在同一工具里执行 `remove_bundle`，`target` 传 `@local/dsh-peak-status`。

包名里的 `@local` 只是本机约定；如果要发布到 npm，请改成你自己拥有的 scope（例如 `@your-name/dsh-peak-status`）或去掉 scope，改完需重新安装本插件。

## 界面

**胶囊（标题栏右侧）**——挂在 `conversation.session.header.utilities`：

```
● 谷价 · 22:52:09 · 距峰价 10h08m · 余额 ¥49.05 · 会话 ¥0.89
```

- 位置：正常文档流，排在「在应用中打开 / 定时 / 下载日志」之后。**不做居中**——宿主的标题栏没有中间插槽（`conversation.header.leading` 在标题左侧，`conversation.session.header.utilities` 在右侧），`conversation.session.header` 那一行也没有定位容器（挂载后测 `offsetParent` 回退到 `body`），没有可做绝对居中的参照盒；唯一能真居中的办法是整行替换 `conversation.session.header`（`single` + `shadows-shipped-ui`），代价不成比例。
- 也**不会**用窗口级 `position: fixed`：那会把胶囊送进桌面端标题栏的拖拽区，那里收不到指针事件，双击只会最大化窗口。
- 鼠标悬停：自绘浮层（不是 `title` 属性），实时刷新也不会闪断，内容为当前相位、倍数、下次切换的具体日期与剩余时间、分币种余额、本会话费用、是否已暂停。
- 双击（或聚焦后回车）：打开明细面板，Esc / 点背景关闭。

**明细面板**分三块：

1. 价格时段：当前相位、下次切换（今天/明天 + 时刻 + 目标相位）、当前时钟；
2. 账户余额：充值余额、赠金余额（按币种），合计，读取时间；
3. 本会话 Token：输入、缓存命中、输出、其中推理、合计、请求次数 / 工具调用、轮次 / 步骤、费用（峰价部分 + 谷价部分）、计价基准、模型。

**提醒浮层**——`shell.overlay`，**界面正中央**（`left/top: 50%` + `translate(-50%, -50%)`），标题与正文 20px。代理正在运行且当前为峰价时出现，**每个峰价时段只弹一次**：点「知道了」后写入 `localStorage`（按下次切换时刻区分时段），同一时段刷新页面也不再弹。**没有时限**：弹窗一直等到你确认，不自动消失，也只有进入谷价时段才自动收起。

> 当前为高峰时段（约谷价 2 倍）。回复「暂停」可优雅收尾：我会先写一份交接文档并暂停会话，等便宜时段再继续；不回复则照常推进。

## 峰谷规则

按 DeepSeek API 官方定价页（2026）：

- 高峰：北京时间 **周一至周五 09:00–12:00、14:00–18:00**（对应 UTC 01:00–04:00、06:00–10:00）；
- 谷价：其余全部时间，**含周末与中国法定节假日全天**（调休上班的周末同样按谷价）；
- 峰价为谷价的 2 倍。

法定节假日表在 `index.js` 顶部的 `HOLIDAYS`：内置 2026 年安排。这张表只能按年维护——DeepSeek 按**实际放假安排**计费，而「放哪几天、哪天调休上班」是国务院办公厅每年发布的通知，不是历法能算出来的（万年历能给「春节是哪天」，给不了「春节放哪 8 天」）。2027 年的通知截至 2026-10-19 尚未公布。

未收录年份的日期按普通工作日处理，明细面板会显示「假期表未覆盖当前年份」，不会闷声按工作日算。通知发布后把日期补进集合即可。

## 收尾协议

插件向系统提示词注入「峰谷价收尾协议」：用户在峰价提醒下回复「暂停」时，模型停止推进原任务、用 `write` 在工作目录写 `HANDOFF.md`（目标、已完成、未完成、下一步、关键文件、命令与结果、风险、恢复指令），回一句确认后结束本轮。

宿主侧另监听会话日志：以「暂停」开头的用户消息会把该会话标记为已暂停（6 小时有效），胶囊追加「已暂停」，下一条普通用户消息自动解除。

## 余额来源

通过 Harness 的 `deepseekAccount` 服务读取 DeepSeek 平台余额（需在应用内登录 DeepSeek 账号），缓存 60 秒。未登录显示「未登录」，服务缺失或请求失败显示「余额 --」，悬停或明细面板可见原因。

## Token 口径

`inputTokens` 与缓存命中的输入分开上报（实测本会话缓存命中 876 万，输入仅 13.7 万），因此面板把两者分列并显式求和：

```
合计 = 输入 + 缓存命中 + 输出
```

`reasoningTokens` 单列，不再从输出里扣除。

## 费用口径

按官方人民币价目（每 1M tokens，`[谷价, 峰价]`）：

| 模型 | 输入·缓存命中 | 输入·缓存未命中 | 输出 |
| --- | --- | --- | --- |
| deepseek-flash | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| deepseek-v4-pro | 0.15 / 0.30 | 4.5 / 9 | 13.5 / 27 |

每条 `assistant/message` 按**它发生那一刻**的相位计价，所以跨峰谷的会话会自动拆成峰、谷两笔。模型名含 `pro` 用 Pro 价目，其余按 Flash 价目；未知模型同样按 Flash 估算并在明细里标出 `pricedAs`。

## 接口

`GET /peak-status/state`，参数 `session=<会话 id>`（附带该会话的 Token 与费用）：

```json
{
  "ok": true, "now": 0, "peak": false, "phase": "off",
  "nextSwitchAt": 0, "nextPhase": "peak", "zone": "Asia/Shanghai",
  "running": true, "runningSessions": ["..."], "paused": [],
  "session": { "id": "...", "running": true, "paused": false },
  "balance": { "status": "ready", "wallets": [{ "currency": "CNY", "balance": "49.05" }],
               "bonusWallets": [{ "currency": "CNY", "balance": "0" }] },
  "balanceAt": 0,
  "usage": {
    "available": true, "promptTokens": 0, "totalTokens": 13863984,
    "inputTokens": 0, "cacheReadTokens": 0, "outputTokens": 0,
    "reasoningTokens": 0, "requests": 84, "toolCalls": 0, "turns": 3, "steps": 0,
    "costCNY": 0.8899, "costPeakCNY": 0, "costOffCNY": 0.8899,
    "pricedAs": "deepseek-flash",
    "model": "deepseek-flash", "provider": "deepseek-account"
  }
}
```

用量按 `session.seq` 缓存，日志没增长时复用上一次的折叠结果。

路由只接受同源请求（`Sec-Fetch-Site` 非 `same-origin`/`none` 直接 403），且不下发 CORS 授权——返回值里有余额。

## 实现

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主半：峰谷计算、余额、运行中会话、暂停标记、Token 折叠、只读路由、系统提示词片段 |
| `client.js` | 客户端半：标题栏胶囊、悬停浮层、明细面板、峰价提醒浮层 |
| `cordis.patch.yml` | 注册插件行 `deepseek-peak-status` |
| `locale/*.json` | 插件管理页显示名与说明 |
| `icon.svg` | 插件图标 |

## 已知限制

完整清单见同目录的 [`LIMITATIONS.txt`](./LIMITATIONS.txt)（位置与外观、峰谷判定、余额、Token 与费用、提醒与暂停、接口与安全、运行与维护，共 30 条）。最要紧的三条：

- 胶囊固定在标题栏右侧，不居中——宿主没有中间插槽，那一行也没有定位容器。
- 2027 年法定节假日未收录；未收录日期按普通工作日处理。
- 费用是本地按官方价目估算，不是账单；Token 用量只能读当前进程内已打开的会话。
