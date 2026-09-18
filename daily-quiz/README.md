# daily-quiz 使用说明

一个自动完成公司「EHS 每日问答」的小工具：读取当日试卷数据 → 按数据里自带的正确答案生成提交请求 → SM2 加密 → 调用接口提交；可配置为**每个工作日定时自动运行**，并从日志里查看每次结果。

> 面向使用者的操作手册。想了解内部实现与设计取舍，见同目录的 `AGENTS.md`。

## 1. 它每次会做什么

```
1/5 拉指针文件        获得当日数据文件名（每天滚动）
2/5 拉数据文件        当日全部试卷；按厂区过滤后打印列表前 N 条
3/5 题目详情          按配置的「答题范围」逐份渲染题目（题干/选项/正确答案）
4/5 构建提交体        每份试卷 × 每个工号各生成一份 SM2 密文，并本地解密自检
5/5 提交              真实调用提交接口，解析响应（首次提交 / 已参与过）
```

## 2. 环境要求

- Windows（定时任务部分基于任务计划程序）
- Node.js ≥ 20（推荐 22/24）
- pnpm

## 3. 安装

```powershell
cd D:\testCode\demo\daily-quiz
pnpm install
```

## 4. 配置（`config.js`）

`config.js` 与线上页面加载的 `/config.js` 结构一致，脚本只读取其中的键值（不执行代码）。

| 配置项 | 说明 |
| --- | --- |
| `VITE_API_URL` | 提交接口域名，默认 `https://ehs30sfun.asymchem.com.cn` |
| `VITE_SM_PUBLIC_KEY` / `VITE_SM_PRIVATE_KEY` | SM2 公钥（加密提交体）与私钥（本地解密自检/响应解密），**从线上 `/config.js` 复制** |
| `QUIZ_JOB_NUMBERS` | 要提交的工号列表，数组；多个工号会逐个提交 |
| `QUIZ_SCOPE` | 答题范围：`"public"` 只答公共题 / `"custom"` 只答 `QUIZ_CATEGORIES` / `"all"` 当天该厂区全部 |
| `QUIZ_CATEGORIES` | 仅 `custom` 生效的类别列表，如 `["公共题","制剂生产"]` |
| `QUIZ_PUBLIC_CATEGORY` | 仅 `public` 生效的类别名，默认 `"公共题"` |
| `QUIZ_FACTORY` | 厂区，默认 `TJ2` |
| `QUIZ_ONLY_TODAY` | `true` 只处理当天的试卷（默认）；`false` 处理所有未过期的 |

示例：

```js
window.__env__ = {
  VITE_API_URL: "https://ehs30sfun.asymchem.com.cn",
  VITE_SM_PUBLIC_KEY: "04....（从线上 config.js 复制）",
  VITE_SM_PRIVATE_KEY: "....（同上）",

  QUIZ_JOB_NUMBERS: ["你的工号"],
  QUIZ_SCOPE: "public",
  QUIZ_CATEGORIES: ["公共题", "制剂生产"],
  QUIZ_PUBLIC_CATEGORY: "公共题",
  QUIZ_FACTORY: "TJ2",
  QUIZ_ONLY_TODAY: true
};
```

> `QUIZ_ONLY_TODAY` 为 `true` 时，若当天还没出题（数据里没有 `startTime` 是今天的试卷），第 3 步会提示「命中 0 份」并跳过提交，属正常情况。

## 5. 手动运行

```powershell
pnpm start                     # 真实提交（会写入"已参与"记录）
pnpm start -- --dry-run        # 只构建提交体、不发送（自测用，推荐先跑这个）
pnpm start -- --code 你的工号   # 临时指定工号，忽略 config 里的列表
pnpm start -- --skip-payload   # 只做前三步：看列表和题目详情
pnpm start -- --json           # 结构化输出，便于程序处理
pnpm run simulate              # 答题模拟：演示"选项随机"与判定规则（不发写请求）
```

常用参数一览：

| 参数 | 作用 |
| --- | --- |
| `--dry-run` | 只构建、不提交 |
| `--code <工号>` / `--code-base64 <值>` | 临时指定工号（优先级最高） |
| `--submit-exam-id <试卷id>` | 只处理这一份试卷 |
| `--factory <厂区>` / `--detail-category <类别>` | 临时覆盖厂区 / 临时把范围缩到某类别 |
| `--limit <n>` | 列表打印条数（默认 3） |
| `--skip-payload` | 跳过第 4、5 步 |
| `--full` / `--raw` / `--out <文件>` | 数据文件响应体：完整打印 / 不美化 / 存文件 |
| `--t <值>` / `--no-t` | 手动指定 / 不附加 `t` 版本参数 |
| `--config <路径>` | 指定 `config.js` 路径（默认项目根目录） |

运行结束看最后几行即可：

- 出现 `提交成功` 或 `已参与过该考试（result.status = already_submitted）` → 本次正常
- 出现 `业务失败（code=...）` 或 `提交失败：...` → 需要处理（见第 10 节）

## 6. 配置定时任务（每个工作日自动运行）

### 6.1 方式一：图形界面

1. `Win+R` 输入 `taskschd.msc` 回车（改已有任务时，建议"以管理员身份运行"打开）
2. 右侧「创建任务」（不是"创建基本任务"）
3. **常规**：名称填 `DailyQuiz`；按需选"只在用户登录时运行"（不需要密码）或"不管用户是否登录都运行"（需输入账户密码）
4. **触发器** → 新建：
   - 开始任务：按预定计划
   - 每周；**每隔 `1` 周**；勾选 **周一~周五**；开始时间填你要的时刻（本项目当前配置为 `16:20:00`，日期保持当天即可）
   - 高级设置：勾「任务的运行时间超过此值则停止执行」填 `15 分钟`；「已启用」**必须勾上**
5. **操作** → 新建：

   | 字段 | 填写 |
   | --- | --- |
   | 程序或脚本 | `powershell.exe` |
   | 添加参数 | `-NoProfile -ExecutionPolicy Bypass -File "D:\testCode\demo\daily-quiz\run-daily.ps1"` |
   | 起始于 | `D:\testCode\demo\daily-quiz` |

6. **设置**：勾选
   - 「如果错过计划启动，则尽快启动任务」
   - 「如果任务失败，按以下频率重新启动：`30 分钟`，最多 `5` 次」
   - 「如果任务已在运行，则不启动新实例」
   - 取消「如果任务没有计划再次运行，则在此之后删除该任务」
7. **条件**：勾选「只有在以下网络连接可用时才启动」（下拉选"任何连接"）；笔记本建议**取消**「只有在计算机使用交流电源时才启动」
8. 确定保存

### 6.2 方式二：PowerShell 一键创建（推荐，便于换机重建）

以管理员身份打开 PowerShell 后执行：

```powershell
$taskName = "DailyQuiz"
$workDir  = "D:\testCode\demo\daily-quiz"

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$workDir\run-daily.ps1`"" `
  -WorkingDirectory $workDir

$trigger = New-ScheduledTaskTrigger -Weekly `
  -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At "16:20"

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 30) `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
  -MultipleInstances IgnoreNew -RunOnlyIfNetworkAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Description "EHS 每日问答自动提交" -Force
```

## 7. 配置好后如何验证

**第 1 步：先手动跑脚本，确认业务链路正常**

```powershell
cd D:\testCode\demo\daily-quiz
pnpm start -- --dry-run      # 只构建不提交，确认能拉数据、能生成密文
pnpm start                   # 真实提交一次，确认接口返回正常
```

**第 2 步：手动触发任务，确认任务能拉起脚本**

```powershell
Start-ScheduledTask -TaskName DailyQuiz
Start-Sleep -Seconds 20
Get-ScheduledTaskInfo -TaskName DailyQuiz | Format-List LastRunTime,LastTaskResult,NextRunTime
```

**第 3 步：检查日志（关键证据）**

```powershell
Get-ChildItem D:\testCode\demo\daily-quiz\logs | Sort-Object LastWriteTime -Descending | Select-Object -First 3
Get-Content "D:\testCode\demo\daily-quiz\logs\daily-quiz-$(Get-Date -Format 'yyyy-MM-dd').log" -Encoding UTF8 -Tail 40
```

日志里每轮都有开始/结束标记，结尾应能看到：

```
[2026-09-18 16:29:06] ==================== 运行结束：退出码 0，耗时 1.3s ====================
```

**判定标准**

| 检查项 | 正常表现 | 异常处理 |
| --- | --- | --- |
| `LastTaskResult` | `0x0` | `0x1` 说明脚本以非 0 退出，看日志尾部找原因；`0x80070002` 多为路径填错 |
| 日志文件 | 当天 `daily-quiz-YYYY-MM-DD.log` 体积在增长 | 文件不存在：确认"起始于"目录正确、`logs` 目录可写 |
| 日志结尾 | `退出码 0`，且有 `提交成功`/`已参与过该考试` | `fetch failed` 多为网络抖动，等任务自动重试或手动再跑 |
| 系统侧 | 事件查看器 → 应用程序和服务日志 → Microsoft → Windows → TaskScheduler → Operational | 该日志默认关闭，需先执行：`wevtutil sl Microsoft-Windows-TaskScheduler/Operational /e:true` |

**第 4 步：看每天的汇总（可选）**

```powershell
Select-String -Path D:\testCode\demo\daily-quiz\logs\*.log -Pattern "运行结束" -Encoding UTF8 | Select-Object -Last 10
```

## 8. 日志与巡检

- 位置：`logs\daily-quiz-YYYY-MM-DD.log`（**按天分文件**，当天多次运行追加同一文件）
- 内容：每轮的开始标记（时间/工作目录/node 路径）、完整五步输出、结束标记（退出码 + 耗时）
- 轮转：`run-daily.ps1` 默认删除 30 天前的日志，可用 `-KeepDays` 调整
- 查看中文正常：用 `-Encoding UTF8` 读，或直接用 VS Code 打开（自动识别 UTF-8）

日常只需一条命令：

```powershell
Get-ScheduledTaskInfo -TaskName DailyQuiz | Format-List LastRunTime,LastTaskResult; Get-Content "D:\testCode\demo\daily-quiz\logs\daily-quiz-$(Get-Date -Format 'yyyy-MM-dd').log" -Encoding UTF8 -Tail 20
```

## 9. 修改 / 暂停 / 删除任务

```powershell
# 暂停（不再定时触发，仍可手动运行）
Disable-ScheduledTask -TaskName DailyQuiz
Enable-ScheduledTask  -TaskName DailyQuiz

# 删除
Unregister-ScheduledTask -TaskName DailyQuiz -Confirm:$false

# 手动跑一次
Start-ScheduledTask -TaskName DailyQuiz
```

改时间/范围：时间在任务「触发器」里改；答题范围改 `config.js` 的 `QUIZ_SCOPE`（脚本每次运行都会重新读取配置，改完立即生效，不需要重装任务）。

## 10. 常见问题

| 问题 | 说明 |
| --- | --- |
| 会不会重复答题？ | 不会。同一工号 + 同一试卷再次提交，服务端返回 `already_submitted`（"您已经参加过该考试"），不会重复计分。 |
| 忘记运行会漏答吗？ | 任务勾了"错过则尽快启动"，开机/联网后会补跑；重试窗口是失败后每 30 分钟一次、共 5 次。 |
| 想让多个工号都提交？ | 在 `QUIZ_JOB_NUMBERS` 里配数组，脚本会对每个工号各提交一次。 |
| 只想答某几个类别？ | 设 `QUIZ_SCOPE: "custom"` 并在 `QUIZ_CATEGORIES` 里列出类别名。 |
| 当天还没出题怎么办？ | 第 3 步会提示"命中 0 份"并跳过提交，退出码仍为 0（不算失败），不影响下一次。 |
| 任务结果一直是 1？ | 打开当天日志看结尾报错：`fetch failed` 是网络问题；`读不到配置文件` 检查"起始于"目录；`找不到 node` 说明运行环境 PATH 不同。 |
| 日志中文乱码？ | 用 `-Encoding UTF8` 读取，或 VS Code 打开；文件本身是 UTF-8，没有损坏。 |
| 怎么确认它真的跑过？ | 看 `LastRunTime` 是否更新 + 当天日志里的"运行开始/运行结束"标记。 |

## 11. 注意事项

- `config.js` 里有 SM2 私钥与真实工号，**不要提交到公开仓库或外发**。
- `pnpm start` 默认真实提交；调试请优先加 `--dry-run`。
- 本工具以你本人的工号按页面相同协议提交，请仅用于自己的账号。
