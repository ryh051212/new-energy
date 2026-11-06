# 代码可读性与自动收尾检查

本项目采用「易读、易懂、易维护」的代码规范，完整规则保存在根目录 `AGENTS.md`，以后在本项目启动的 Codex 会话都会读取。优先展开复杂表达式、使用明确命名与中文注释，保留接口、业务公式、未知值语义、异步取消和资源释放。

## 执行流程

```text
① 用户要求修改功能 → Codex 读取 AGENTS.md → 完成代码与可读性调整
  ↓
② Codex 准备结束本轮 → .codex/hooks.json 的 Stop 事件
  ↓
③ scripts/checks/code-quality-hook.mjs → 比较源码内容快照
  ├─ 源码未变且上次通过 → 直接结束，不重复构建
  └─ 源码有变化或上次失败 → scripts/checks/code-quality.mjs
       ↓（顺序执行，每项最多 120 秒，某项失败仍检查后续项）
       结构检查 → 前端测试 → 生产构建 → 两处后端测试 → Hook 流程测试
       ↓
④ 更新 .code-quality/report.json 和 state.json
  ├─ 首次停止 → 请求 Codex 按规则复查本轮代码和检查报告
  │    ├─ 需要修正 → 直接修改 → npm run quality → 再次停止
  │    └─ 已符合规范 → 无需改动 → 再次停止
  └─ 已处于 Stop 续轮 → 不再强制续写；仍有失败时明确提示
  ↓
⑤ 用户收到修改文件、原因、验证结果与风险说明
```

这是 Codex 会话生命周期 hook，每轮完成修改后自动检查。它不会在编辑器每次保存时触发，也不依赖提交 Git。手工或其他工具修改的代码会在下次 Codex Stop 时按源码变化检查；也可立即手动运行。

## 首次启用

1. 在项目根目录重新打开 Codex 会话，让它加载 `.codex/hooks.json`。
2. 在 Codex 的 hook 审查界面信任此项目的 hook；CLI 可输入 `/hooks`。项目本身也需要处于受信任状态。不要通过脚本修改信任记录。
3. 完成一次代码修改后，检查 `.code-quality/report.json` 是否更新。

官方说明：[Hooks](https://learn.chatgpt.com/docs/hooks)。Codex 要求用户审查并信任非托管 hook；未信任时会跳过执行。`Stop` 返回 `decision: block` 会让 Codex续写一轮，`stop_hook_active` 用于防止重复续写。只有命令和 MCP hook 会实际执行，不能直接把自然语言 prompt 填成 agent hook。

配置中的 Windows 命令先指定 PowerShell 的 UTF-8 输出编码，再从 Git 根目录定位脚本，避免中文路径被错误解码；支持空格路径和从子目录启动。其他平台使用常规 shell 与 Node。脚本根目录由自身文件位置确定。

## 手动运行与报告

```sh
npm run quality
```

手动命令每次都执行全部检查，返回非零退出码表示失败。现有 `npm test`、`npm run test:backend`、`npm run check:structure` 均可单独运行；`npm run test:tooling` 验证 hook 的快照识别、单次续轮、失败汇总与损坏缓存恢复。

`.code-quality/report.json` 保存检查时间（ISO UTC）、检查文件、各项状态、耗时和命令输出。`.code-quality/state.json` 保存最近源码哈希与检查状态，用于去重。两者只保存在本机，已由 `.gitignore` 排除。删除该目录可使下次 Stop 完整重查。

首次运行没有旧快照，会检查现有全部源码。后续快照覆盖 `src/`、`backend/`、`tests/`、`scripts/` 中的代码与 JSON、SQL，以及包配置、Vite 配置、`AGENTS.md` 和 hook 配置；不扫描虚拟环境、构建产物或数据交付包。自动检查不启动业务 API，不导入业务数据。

自动工具负责测试和构建，可读性、业务语义和是否应当封装由 Codex 根据实际代码复查。检查本身不自动改写源文件；Stop 续轮把复查任务交给 Codex。环境缺依赖或权限不足时保留失败输出，不静默降级。失败后只请求一次自动续轮，避免无限循环。

## 本次优化范围

- `functionalZones.js`：展开活动强度、主导功能区、情景贡献、需求档位与评分的判断，保留原分类、阈值与排序。
- `gridTemporalDemand.js`：展开空间密度、P95 基准、强度、逐时贡献与曲线组装，区分缺失、已知零值、稀疏样本回退，维持原公式和全区共享尺度。
- `useAdaptivePopup.js`：展开锚点、最大高度和窄屏偏移分支，保留帧合并、关闭后取消回调和移除监听。
- `check-structure.mjs`：用明确循环代替递归列表中的多层三元表达式，保留原检查口径。
- `test-backend.mjs`：简化解释器选择，并将已有 `backend/tests/` 纳入统一测试；因此之前未执行的测试失败也会开始暴露。

保留当前工作区中其他既有改动，不批量重排全仓库。后续功能修改继续遵循同一套规范。
