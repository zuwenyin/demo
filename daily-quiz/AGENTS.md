# daily-quiz（Agent 速查）

自动完成公司「EHS 每日问答」：拉当日试卷 → 按数据自带的正确答案生成提交体 → SM2 加密 → 真实提交。
已接入 Windows 任务计划程序，工作日定时运行。

## 命令

```bash
pnpm install
pnpm start -- --dry-run   # 改代码后先用这个自测（只构建不发送）
pnpm run simulate         # 答题模拟：验证"随机选项"与判定规则，不发写请求
pnpm run payload          # 独立入口：只为指定试卷构建提交体
pnpm run typecheck
pnpm start                # ⚠️ 默认真实提交，会写入"已参与"记录（重复提交返回 code=400「您已经参加过该考试」，按成功处理）
```

故障路径自测（验证退出码链路，30 秒；会往当天日志追加失败记录，属正常现象）：

```powershell
# 1) 拉数据失败 → 期望退出码 1
$env:UPSTREAM_ORIGIN='https://127.0.0.1:9'; powershell -NoProfile -ExecutionPolicy Bypass -File .\run-daily.ps1; "exit=$LASTEXITCODE"; Remove-Item Env:UPSTREAM_ORIGIN
# 2) 提交失败（临时配置把 API 指向不可达地址，重试次数设 0 更快）→ 期望退出码 1，日志出现「fetch failed ← <cause>」
(Get-Content .\config.js -Raw -Encoding UTF8) -replace 'https://ehs30sfun\.asymchem\.com\.cn', 'https://127.0.0.1:9' | Set-Content .\config.selftest.js -Encoding UTF8
$env:SUBMIT_RETRIES='0'; pnpm start -- --config .\config.selftest.js; "exit=$LASTEXITCODE"
Remove-Item Env:SUBMIT_RETRIES; Remove-Item .\config.selftest.js
# 3) 重复提交 → 期望「已参加过该考试…按成功处理」+ 退出码 0
pnpm start
```

常用参数：`--dry-run`、`--code <工号>`、`--submit-exam-id <id>`、`--factory <厂区>`、`--limit <n>`、`--skip-payload`、`--json`、`--out <文件>`、`--t <值>`/`--no-t`、`--all-days`/`--no-catch-up`、`--config <路径>`（默认根目录 `config.js`）。

## 接口（实测结论）

| 接口 | 说明 |
| --- | --- |
| `GET .../exam-data/exam_data_latest.json`（CDN） | 指针文件：`{"current":"exam_data_YYYY-MM-DD_HH-mm-ss.json"}`；**每天滚动，勿硬编码 examId** |
| `GET .../exam-data/<current>?t=<版本号>`（CDN） | 全部试卷；`t = Math.floor(Date.now()/300000)` |
| `POST https://ehs30sfun.asymchem.com.cn/api/StudentExam/SubmitByHtml` | body = **裸 SM2 密文 hex**（不带引号），`Content-Type: application/json` |
| `GET .../api/StudentExam/GetCompletedExamsByHtml?code=<base64工号>` | 已答记录（页面在用，**本仓库未接入**，是"已答跳过/安全重试"的基石） |

提交明文（加密前 `encodeURIComponent`）：

```json
{"ExaminationId":850128069288005,"Code":"QUxTMTI1NTY=","Answers":[{"QuestionId":826692026257494,"AnswerContent":"ABCD"}]}
```

- `Code = base64(工号明文)`；`AnswerContent`：单选/多选 = **内部字母**（= `correctAnswer`，如 `"A"`/`"ABCD"`）、判断 = `"对"`/`"错"`、填空简答 = 文本。
- 加密 `sm2.doEncrypt(..., VITE_SM_PUBLIC_KEY)`，cipherMode=1（C1C3C2），**C1 带 `04` 前缀**（页面 `SmCryptoV2` 格式；npm `sm-crypto` 不带，代码里手动补）。
- 响应 `{code,type,message,result:"<密文>",...}`，`result` 用私钥解密：首次 `code:200` + `result.status:"submitted"`；**重复提交实测是 `code:400` + message「您已经参加过该考试」（`result` 为 null）**，前端代码里那个 `status:"already_submitted"` 实际不出现（判重统一走 `isAlreadySubmittedResult`）。后端按「工号+试卷」去重，**重复提交不会重复计分**。后端 `isPassed` 语义不可靠，页面显示结果其实是前端本地算的。
- 两个接口**都没有身份认证**（CDN 公开 + 提交只认密文里的 `Code`）。页面副本：`问答列表.html`/`iiii.html`（列表）、`题目详情.html`（答题）。

## 数据模型与取值口径

```ts
试卷 { id, examinationName, startTime, endTime, questions[] }
题目 { id, questionName, questionText/*HTML*/, factory, category,
      questionType/*1单选2多选3判断4填空5简答*/, options/*JSON字符串数组*/, correctAnswer, points, explanation }
```

厂区/类别/列表显示名/日期一律取 `questions[0]`（`factory` / `category` / `questionName || examinationName` / `startTime`）。

## 关键决策（改动前必读）

1. 列表顺序 = 接口数组顺序，列表页只按 `questions[0].factory` 过滤、**不排序**；所以"选中某厂区后的第一条"≠ 数组第一条。
2. 答题范围配置化：`QUIZ_SCOPE = public | custom | all` + `QUIZ_ONLY_TODAY`；优先级 `--submit-exam-id` > `--detail-category` > `config.js`。**当天没命中且快照最新日期早于今天**（上游约 15:20 才发布当天数据）时，自动回退为补答该快照日期里「类别命中 + `endTime` 未过期」的试卷（`selectCatchUpExams`，`--no-catch-up` 关闭；`--all-days` 直接关掉日期过滤）。快照已是今天则不补答。
3. 答案直接来自数据里的 `correctAnswer`（原系统把答案下发给前端）。
4. **选项随机，且"显示字母 ≠ 内部值"**：渲染按显示位置编字母，`el-radio.label`（提交值）按原始索引编字母；判定/提交都在"原始字母"坐标系。⇒ 自动作答必须用 `correctAnswer` 原样提交；脚本第三步打印的 A/B/C/D 是**接口原始顺序**，不代表页面字母。用 `pnpm run simulate` 可直观看到。
5. 提交粒度 = 试卷 × 工号（每个组合一份密文），串行提交。
6. body 形态固定为"裸 hex 字符串"（页面 axios 行为），已实测被服务端接受；`--body-mode json` 仅备用对照。
7. 无人值守三层：任务计划程序（定时 + 任务级重试）+ `run-daily.ps1`（按天日志、退出码兜底）+ 进程内重试（**GET 用 `UPSTREAM_RETRIES` 默认 3**、提交用 `SUBMIT_RETRIES` 默认 2，间隔均 0.5/1/2s；只对网络错误 / 超时 / 5xx / 429 重试，业务失败不重试）。**提交失败必须传导为退出码 1**，否则任务级的"失败重启"不会触发。`describeError`/`isRetryableError`/`isRetryableStatus`/`delay` 统一放在 `upstream.ts` 导出，别再在别处重复实现。

## 结构

```
config.js         # window.__env__：API、SM2 公钥/私钥、QUIZ_JOB_NUMBERS、QUIZ_SCOPE
run-daily.ps1     # 任务入口：按天日志、退出码、日志轮转（UTF-8 with BOM！）
src/
  fetch-exam-data.ts      # 主流程 1/5 指针 → 2/5 数据 → 3/5 详情 → 4/5 提交体 → 5/5 提交
  submit-payload.ts       # 配置/工号/范围解析、提交体构建与打印、真实提交与响应处理
  simulate-answer.ts      # 答题模拟（复刻页面随机与判定）
  build-submit-payload.ts # 只构建提交体
  upstream.ts             # 上游常量与请求（fetchUpstream/fetchUpstreamJson/loadExamData）
  exam-types.ts / exam-utils.ts / terminal-style.ts  # 类型 / 纯函数工具 / 终端样式
logs/daily-quiz-YYYY-MM-DD.log
```

## 工程约定

- **终端输出是契约**：改动后用「基线对比」验证——跑 `--dry-run` / `simulate` / `payload` 各存一份输出，过滤动态内容（密文、`t=`、响应头、洗牌顺序）后 `Compare-Object` 应零差异。
- TS 严格模式（`noUnusedLocals/Parameters`、`verbatimModuleSyntax`）：删代码要同步删 import；类型导入用 `import type`；相对导入必须带 `.js`。
- 退出码：`0` 成功、`1` 失败；统一 `process.exitCode = 1`，**不要用 `process.exit()`**（Windows 管道下会 libuv 断言崩溃，退出码变 9）。
- 判定成功的口径：`HTTP ok` + 无 `errors` + `code` 为 200 或无 `code`；**重复提交（`code=400` +「您已经参加过该考试」）也算成功**，统一走 `isAlreadySubmittedResult()`。**任一"试卷 × 工号"提交失败必须置 `process.exitCode = 1`**：只写日志不返回非 0 时，任务计划程序的「失败重启」一次都不会触发（2026-10-27 踩过：日志写"提交失败：fetch failed"，任务结果是 0x0）。
- `run-daily.ps1` 必须存为 **UTF-8 with BOM**；写日志用 `Add-Content -Encoding UTF8`；读子进程输出前设 `[Console]::OutputEncoding = UTF8`。
- 新增参数：在 `fetch-exam-data.ts` 的 `BOOLEAN_FLAGS`/`valueHandlers` 表里加一行；数字用 `toPositiveInt` 兜底。

## 运维

任务 `DailyQuiz`：周一~周五 16:20；错过则尽快启动；不并发；仅网络可用时启动；失败后重启（本机实测 3 次 / 每 10 分钟，README 建议 5 次 / 每 30 分钟）；超时上限（本机实测 72 小时，建议改 15 分钟——配 `IgnoreNew` 时卡死会连累后续几天）。实际值用 `schtasks /Query /TN DailyQuiz /V /FO LIST` 查，改法见 README 第 9 节。
操作：`powershell.exe` + `-NoProfile -ExecutionPolicy Bypass -File "D:\testCode\demo\daily-quiz\run-daily.ps1"`，起始于项目目录（改任务需管理员权限）。

```powershell
Get-ScheduledTaskInfo -TaskName DailyQuiz | Format-List LastRunTime,LastTaskResult      # 0x0 成功
Get-Content D:\testCode\demo\daily-quiz\logs\daily-quiz-$(Get-Date -Format 'yyyy-MM-dd').log -Encoding UTF8 -Tail 40
```

## 已知坑

| 症状 | 原因 → 处理 |
| --- | --- |
| 任务结果 1 且没生成日志 | 重定向目标目录不存在 → `run-daily.ps1` 已自动创建 `logs` |
| 日志中文乱码 | PS 5.1 按 GBK 读无 BOM 的 UTF-8 脚本 → 脚本存 UTF-8 with BOM，读取加 `-Encoding UTF8` |
| 日志只有头部没有 node 输出 | `Out-File -Append` 静默失败 → 已改 `Add-Content -Encoding UTF8` |
| 偶发 `fetch failed`（含 `Client network socket disconnected before secure TLS connection was established`） | 该 CDN 新建连接约 15% 在 TLS 握手阶段被重置（实测走 TUN / 走 127.0.0.1:7897 都一样，与请求头无关）→ GET 已内置重试 3 次（0.5/1/2s，`UPSTREAM_RETRIES`）+ 提交重试 2 次 + 任务级重试 |
| 日志写"提交失败"但任务结果 0x0 | 提交失败没传导到退出码 → 已修：`printSubmitStep` 返回失败明细、`main` 置 1；`run-daily.ps1` 另有"node 无退出码 / 输出含提交失败 → 按 1"兜底 |
| 密文比页面短 1 字节 | 库输出不带 C1 的 `04` → 已补回 |
| 重复运行仍会请求一次提交 | 未做"已答跳过" → 后端返回 `code=400`「您已经参加过该考试」，脚本按成功处理，不影响成绩 |
| 多选题字母顺序 | 页面提交按点击顺序 `join()`、判定 `sort()`；当前按 `correctAnswer` 原样提交（现数据均为升序），**遇到乱序需先确认** |

## 待办

1. 接入 `GetCompletedExamsByHtml` 做"已答跳过"（同时作为安全重试的前置校验）
2. ~~GET（指针文件 / 数据文件）进程内重试仍缺~~ 已补（`upstream.ts` 的 `fetchUpstream`，`UPSTREAM_RETRIES` 默认 3）；POST 的"重试前复查已答"仍未做（现靠服务端「您已经参加过该考试」响应兜底）
3. 失败钉钉告警（由 `run-daily.ps1` 在非 0 退出时发送）
4. `simulate-answer.ts` 样式统一到 `terminal-style.ts`

## 安全

`config.js` 含 SM2 私钥与真实工号，勿入库/外发；调试只用本人账号并优先 `--dry-run`。原系统缺陷（答案随数据下发 + 提交接口无鉴权）建议反馈加固：提交接口校验登录态、数据剔除答案字段、服务端幂等、数据目录签名 URL。
