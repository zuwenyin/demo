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
pnpm start                # ⚠️ 默认真实提交，会写入"已参与"记录
```

常用参数：`--dry-run`、`--code <工号>`、`--submit-exam-id <id>`、`--factory <厂区>`、`--limit <n>`、`--skip-payload`、`--json`、`--out <文件>`、`--t <值>`/`--no-t`、`--config <路径>`（默认根目录 `config.js`）。

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
- 响应 `{code,type,message,result:"<密文>",...}`，`result` 用私钥解密：首次 `status:"submitted"`；重复提交 `status:"already_submitted"`（后端按「工号+试卷」去重，**重复提交不会重复计分**）。后端 `isPassed` 语义不可靠，页面显示结果其实是前端本地算的。
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
2. 答题范围配置化：`QUIZ_SCOPE = public | custom | all` + `QUIZ_ONLY_TODAY`；优先级 `--submit-exam-id` > `--detail-category` > `config.js`。
3. 答案直接来自数据里的 `correctAnswer`（原系统把答案下发给前端）。
4. **选项随机，且"显示字母 ≠ 内部值"**：渲染按显示位置编字母，`el-radio.label`（提交值）按原始索引编字母；判定/提交都在"原始字母"坐标系。⇒ 自动作答必须用 `correctAnswer` 原样提交；脚本第三步打印的 A/B/C/D 是**接口原始顺序**，不代表页面字母。用 `pnpm run simulate` 可直观看到。
5. 提交粒度 = 试卷 × 工号（每个组合一份密文），串行提交。
6. body 形态固定为"裸 hex 字符串"（页面 axios 行为），已实测被服务端接受；`--body-mode json` 仅备用对照。
7. 无人值守两层：任务计划程序（定时 + 任务级重试）+ `run-daily.ps1`（按天日志、退出码传递）；**进程内无重试**。

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
- `run-daily.ps1` 必须存为 **UTF-8 with BOM**；写日志用 `Add-Content -Encoding UTF8`；读子进程输出前设 `[Console]::OutputEncoding = UTF8`。
- 新增参数：在 `fetch-exam-data.ts` 的 `BOOLEAN_FLAGS`/`valueHandlers` 表里加一行；数字用 `toPositiveInt` 兜底。

## 运维

任务 `DailyQuiz`：周一~周五 16:20；错过则尽快启动；失败每 30 分钟重试 ×5；超时 15 分钟；不并发；仅网络可用时启动。
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
| 偶发 `fetch failed` | CDN/网络抖动 → 现靠任务级重试；进程内重试仍是待办 |
| 密文比页面短 1 字节 | 库输出不带 C1 的 `04` → 已补回 |
| 重复运行仍会请求一次提交 | 未做"已答跳过" → 后端返回 `already_submitted`，不影响成绩 |
| 多选题字母顺序 | 页面提交按点击顺序 `join()`、判定 `sort()`；当前按 `correctAnswer` 原样提交（现数据均为升序），**遇到乱序需先确认** |

## 待办

1. 接入 `GetCompletedExamsByHtml` 做"已答跳过"（同时作为安全重试的前置校验）
2. 进程内重试（GET 无条件、POST 重试前复查已答，退避 0.5/1/2s）
3. 失败钉钉告警（由 `run-daily.ps1` 在非 0 退出时发送）
4. `simulate-answer.ts` 样式统一到 `terminal-style.ts`

## 安全

`config.js` 含 SM2 私钥与真实工号，勿入库/外发；调试只用本人账号并优先 `--dry-run`。原系统缺陷（答案随数据下发 + 提交接口无鉴权）建议反馈加固：提交接口校验登录态、数据剔除答案字段、服务端幂等、数据目录签名 URL。
