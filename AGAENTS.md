
你是本项目的 Codex 开发代理。本项目是
@zeroclave/dsh-privacy：面向 DeepSeek Harness Web UI 的 ZeroClave Privacy Firewall 插件。

## 项目上下文

本项目不是完全独立构建的 npm 项目，而是依赖 DeepSeek Harness monorepo 的构建环境。

必须使用与仓库匹配的 Harness 版本：

- Harness revision:
  d347e703908d0406b7a7ef80e3a0e594d86b2215
- Node.js:
  24.19.0（项目要求 Node 22.19.0 或更高版本）
- pnpm:
  11.7.0
- Harness 集成文件：
  integrations/deepseek-harness/d347e703908d0406b7a7ef80e3a0e594d86b2215/

除非用户明确要求，否则不要升级或替换 Harness revision、Node、pnpm、锁文件或 workspace 配置。

## 工作范围

你可以修改：

- src/
- tests/
- README.md
- scripts/
- package.json
- tsconfig.json
- tsdown.config.ts
- cordis.patch.yml
- .github/workflows/
- 必要的项目配置和文档

不要擅自修改：

- integrations/deepseek-harness/... 中的固定依赖快照
- Harness 外部源码
- 用户已有的未提交修改
- 构建产物或临时目录
- 密钥、凭据、环境变量中的敏感信息

如果发现工作区已有修改，先检查并保留这些修改，不要使用 git reset --hard、git checkout -- 或其他破坏性命令覆盖它们。

## 修改前的要求

在修改代码前：

1. 阅读相关源码、测试和 README。
2. 确认修改涉及的插件边界：
   - 浏览器端检测、脱敏和恢复逻辑
   - DSH Host 代理
   - IndexedDB/localStorage 持久化
   - telemetry
   - Cordis patch
   - bundle 配置
3. 不要根据猜测重构与任务无关的代码。
4. 对涉及隐私、安全、发送边界、恢复映射或 Host API 的变更，必须检查现有测试和安全说明。

## 构建环境

在匹配的 DeepSeek Harness checkout 根目录执行构建。通常流程如下：

```bash
cp /home/r_user/aaa/yinqian_lab/zeroclave_lab/zeroclave-dsh-privacy/integrations/deepseek-harness/d347e703908d0406b7a7ef80e3a0e594d86b2215/pnpm-lock.yaml \
  pnpm-lock.yaml

cp /home/r_user/aaa/yinqian_lab/zeroclave_lab/zeroclave-dsh-privacy/integrations/deepseek-harness/d347e703908d0406b7a7ef80e3a0e594d86b2215/pnpm-workspace.yaml \
  pnpm-workspace.yaml

pnpm install --frozen-lockfile
pnpm run build:lib:host
pnpm run build:lib:client
```

然后将本项目放置或同步到：

```text
packages/experimental/zeroclave-privacy
```

执行插件构建：

```bash
pnpm install --frozen-lockfile --filter '@zeroclave/dsh-privacy...'
pnpm --filter '@zeroclave/dsh-privacy' exec tsc --project tsconfig.json
pnpm --filter '@zeroclave/dsh-privacy' run bundle
```

本项目没有独立的 dev/watch 脚本。修改代码后应重新执行类型检查和 bundle 构建。

## 测试要求

代码变更后，根据修改范围运行以下检查：

```bash
pnpm --filter '@zeroclave/dsh-privacy' test
```

浏览器 smoke test：

```bash
pnpm --filter '@zeroclave/dsh-privacy' exec playwright install --with-deps chrome
pnpm --filter '@zeroclave/dsh-privacy' exec node tests/browser-smoke.mjs
```

生产包构建：

```bash
pnpm --filter '@zeroclave/dsh-privacy' pack
```

包审计：

```bash
node scripts/audit-package.mjs path/to/package.tgz
sha256sum path/to/package.tgz
```

如果无法运行某项检查，必须说明：

- 未运行的命令
- 失败原因
- 可能受到影响的范围

不要声称未执行的测试已经通过。

## TypeScript 和代码风格

遵守 tsconfig.json 中的严格约束：

- strict
- noUncheckedIndexedAccess
- exactOptionalPropertyTypes
- noFallthroughCasesInSwitch
- noUnusedLocals
- noUnusedParameters

默认遵循现有代码风格：

- TypeScript 使用 ES module
- 使用单引号
- 不使用分号
- 使用明确、窄化的类型
- 避免不必要的类型断言
- 避免无关的全局状态
- 优先小型、职责清晰的模块
- 保持现有命名和目录结构
- 不引入未经必要性评估的新依赖

项目没有完整的 ESLint/Prettier 规范，因此应优先保持邻近代码的一致性，并以 TypeScript、测试和 CI 约束为准。

## 安全和隐私约束

这是隐私插件。任何改动都必须避免：

- 将原始用户消息发送到不必要的远程服务
- 将原始敏感值写入 Host 日志或 telemetry
- 绕过浏览器端脱敏流程
- 在检测失败时错误地当作“无敏感信息”
- 破坏 IndexedDB 恢复映射的会话隔离
- 把 API key、HMAC key 或其他秘密写入客户端 bundle、package 文件或 Cordis 配置
- 把 source map、测试文件、源码或敏感文件打入生产包

除非用户明确要求，否则不要改变以下安全语义：

- telemetry 默认关闭
- Global Privacy Control 会禁用 telemetry
- 检测服务错误或 partial 结果会阻止发送
- 发送前必须完成脱敏
- 恢复映射保留在浏览器本地
- 浏览器端使用同源 Host 代理访问 Gateway
- 不在浏览器端放置 Gateway API key

## Bundle 和发布约束

不要绕过 tsdown.config.ts。该配置负责：

- DSH client bundle
- 浏览器依赖别名
- Hugging Face Transformers Web 版本
- ONNX Runtime Web
- client bundle 压缩
- 隐藏 source map
- ZeroClave logo 内联

package.json 的 files 字段和 scripts/audit-package.mjs 定义了生产包边界。生产包不得包含：

- src/
- tests/
- node_modules/
- coverage/
- source map
- .env
- 密钥或证书
- 用户机器路径

不要增加 prepare、install、postinstall 等生命周期脚本，除非用户明确要求并同时更新安全审计。

## 文档要求

如果修改了命令、构建方式、Harness 版本、发布方式或安全行为，必须同步更新 README.md。

README 中必须明确区分：

1. 本地开发构建
2. 本地 DSH Web profile 安装
3. 生产 bundle 构建
4. npm/pnpm tarball 发布
5. CI 验证流程

不要把源码目录描述成可独立从 GitHub URL 安装的 npm 包，除非同时实现了自包含构建和 prepare 流程。

## Git 和变更管理

- 不自动提交、推送或创建 PR，除非用户明确要求。
- 不修改用户未要求的文件。
- 不删除文件或目录，除非用户明确要求。
- 使用 apply_patch 进行文件编辑。
- 修改后检查 git diff 和 git status。
- 最终报告应列出：
  - 修改的文件
  - 实现的行为
  - 运行过的验证命令
  - 未运行或失败的验证
  - 仍需用户注意的兼容性或发布问题

## 任务执行原则

先给出简短的实施计划，然后读取相关文件并开始工作。

优先进行最小、局部、可验证的修改。

如果用户要求“修复”，应实现修复并验证。
如果用户只要求“诊断”或“审查”，不要擅自修改代码。
如果需求会改变安全边界、发布方式、依赖版本或 Harness 兼容性，先说明影响，再执行。

最终回答必须简洁、准确，并明确区分：
- 已完成
- 已验证
- 未验证
- 建议的下一步
