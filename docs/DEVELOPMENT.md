# 开发与构建

[← 返回项目首页](../README.md)

这里记录构建环境、部署配置和发布流程。安装及日常使用请看 [README](../README.md#快速开始)。

## 仓库结构

| 位置 | 用途 |
| --- | --- |
| `src/client/` | 检测侧栏、设置、消息显示恢复和界面文案 |
| `src/controller.ts`、`src/send.ts` | 检测状态、人工选择和发送拦截 |
| `src/detector.ts`、`src/regex-rules.ts` | 本地正则与自定义规则 |
| `src/embedded-model.ts`、`src/zeroclave-detector.ts` | BERT 和网关检测 |
| `src/vault.ts` | 当前浏览器的脱敏标记与恢复映射 |
| `src/index.ts`、`src/proxy.ts` | Host 配置与网关请求转发 |
| `integrations/deepseek-harness/` | 固定版本的构建清单、锁文件与校验和 |
| `.github/workflows/ci.yml` | CI 构建、检查和安装包生成 |

## 构建环境

插件依赖 Harness workspace 包，不支持在独立仓库中直接执行 `npm run build`。包内提供的是 `bundle` 脚本；Host 打包前需要先用 TypeScript 生成 `lib/types/`。

当前 CI 使用以下固定基线：

| 工具 | 版本 |
| --- | --- |
| DeepSeek Harness | `0.1.3-alpha.1` |
| Harness commit | `d347e703908d0406b7a7ef80e3a0e594d86b2215` |
| Node.js | `24.19.0` |
| pnpm | `11.7.0` |

对应文件位于 [集成目录](../integrations/deepseek-harness/d347e703908d0406b7a7ef80e3a0e594d86b2215/manifest.json)。构建顺序与 [CI](../.github/workflows/ci.yml) 一致：安装并构建原始 Harness，再加入插件。

### 准备 Harness

将两个仓库放在同级目录，使用上表中的 Node 和 pnpm 版本：

```bash
git clone https://github.com/ZeroClave/zeroclave-dsh-privacy.git
git clone https://github.com/deepseek-ai/deepseek-harness.git

cd deepseek-harness
git checkout d347e703908d0406b7a7ef80e3a0e594d86b2215

ZC_COMPANION=../zeroclave-dsh-privacy/integrations/deepseek-harness/d347e703908d0406b7a7ef80e3a0e594d86b2215
(cd "$ZC_COMPANION" && shasum -a 256 -c SHA256SUMS)
cp "$ZC_COMPANION/pnpm-lock.yaml" .
cp "$ZC_COMPANION/pnpm-workspace.yaml" .

pnpm install --frozen-lockfile
pnpm run build:lib:host
pnpm run build:lib:client
```

### 编译插件

继续在 Harness 根目录执行：

```bash
mkdir -p packages/experimental/zeroclave-privacy
rsync -a \
  --exclude=.git \
  --exclude=.github \
  --exclude=integrations \
  --exclude=node_modules \
  --exclude=lib \
  ../zeroclave-dsh-privacy/ packages/experimental/zeroclave-privacy/

pnpm install --frozen-lockfile --filter '@zeroclave/dsh-privacy...'
pnpm --filter '@zeroclave/dsh-privacy' exec tsc --project tsconfig.json
pnpm --filter '@zeroclave/dsh-privacy' run bundle
```

产物位于 `packages/experimental/zeroclave-privacy/lib/`，包含 Host 入口、浏览器 bundle 和类型声明。运行插件测试：

```bash
pnpm --filter '@zeroclave/dsh-privacy' test
```

如果修改依赖，需要同步更新集成锁文件及 `SHA256SUMS`。不要通过移除 `--frozen-lockfile` 隐藏依赖不一致。

### DSH 0.2 兼容

alpha.27 增加了 DSH `0.2.0-rc.2` 兼容，并保留 `0.1.3-alpha.1` 支持。新版会话选择通过 `retainedBy.mainView` 读取；旧版通过 `current` 读取。

0.2.0-rc.2 对应提交为 `639ed015397290b3745d163aafe02ffee4aa3f84`。在该版本中构建时，将插件放在 `packages/extensions/zeroclave-privacy`：新版构建器不允许普通插件依赖 `packages/experimental` 中的输入。上面的集成锁文件只对应 0.1.3 基线，不能直接用于 0.2 的依赖安装。

## 生成安装包

在已构建的 Harness 根目录执行：

```bash
mkdir -p artifacts
pnpm --filter '@zeroclave/dsh-privacy' pack --pack-destination ./artifacts
node packages/experimental/zeroclave-privacy/scripts/audit-package.mjs \
  artifacts/zeroclave-dsh-privacy-0.1.0-alpha.27.tgz
shasum -a 256 artifacts/zeroclave-dsh-privacy-0.1.0-alpha.27.tgz
```

`.tgz` 用于 DSH 安装。`audit-package.mjs` 检查文件范围、敏感路径、包大小，以及 Host 入口在未安装插件依赖时能否加载。

DeepSeek Stream 使用 `.zip`。CI 会根据同一构建产物另外生成 ZIP，顶层为一个插件目录，包含：

```text
zeroclave-dsh-privacy/
├── plugin.json
├── package.json
├── cordis.patch.yml
├── README.md
├── LICENSE
└── lib/
    ├── client.js
    ├── index.js
    └── types/
```

打包时只包含清单允许的文件，不包含源码、测试、source map 或本地依赖目录。README 的首图和开发文档使用仓库链接，不要求将文档素材装入插件包。

## CI 与发布

| 触发方式 | 结果 |
| --- | --- |
| 手动运行 workflow | 类型检查、构建、单元与集成测试、安装包审计，以及可下载的 Actions artifacts |
| 推送 `v*` 标签 | 自动执行上述检查；通过后创建 GitHub Release 并附带安装包 |

Artifacts 包含 `.tgz`、`.zip` 和 SHA-256 校验文件，保留 7 天。普通分支推送和 Pull Request 不会自动运行 CI；日常验证请在 GitHub Actions 页面手动运行 workflow。普通分支推送不会创建 Release。

发布前确认 `package.json` 与 `plugin.json` 版本一致。发布 alpha.27 的标签命令：

```bash
git tag -a v0.1.0-alpha.27 -m "Release v0.1.0-alpha.27"
git push origin v0.1.0-alpha.27
```

标签去掉 `v` 后必须与包版本完全一致。

## 部署配置

Host 配置位于 [cordis.patch.yml](../cordis.patch.yml)。以下示例关闭使用统计：

```yaml
- insert:
    - id: zeroclave-privacy
      name: '@zeroclave/dsh-privacy'
      config:
        gatewayBaseURL: https://zeroclave.com/v1
        timeoutMs: 15000
        telemetryEnabled: false
```

| 字段 | 用途 | Schema 默认值 |
| --- | --- | --- |
| `gatewayBaseURL` | ZeroClave Gateway 基础地址；只允许 HTTPS，本机回环地址可用 HTTP | `https://zeroclave.com/v1` |
| `timeoutMs` | 检测超时，100–30000 毫秒 | `15000` |
| `telemetryEnabled` | 是否提供统计能力 | `false` |
| `telemetryTimeoutMs` | 统计中继超时，100–10000 毫秒 | `2000` |

Schema 默认关闭统计，但当前发布配置显式开启。服务可用时默认启用；用户关闭或浏览器 GPC 会禁止发送新的统计。接收服务、站点标识和 provider 由部署配置决定，用户说明见 [README](../README.md#你的数据如何处理)。

统计事件包括 `privacy_active`、`protected_send` 和 `detector_used`；统计结果只适合观察近似使用趋势，不用于计费、安全决策或精确人数统计。

### 网关检测

浏览器请求同源 `POST /api/zeroclave-privacy/detect`，DSH Host 转发至配置的 Gateway。浏览器无需配置 ZeroClave API Key。连接测试只发送固定合成样本，不发送当前草稿。

Host 和 Gateway 可见检测原文。网关返回实体位置与类型，客户端生成替换内容；这不是浏览器直达 TEE 的端到端加密通道。

### 本地规则与恢复映射

自定义正则使用 JavaScript 语法，支持 `i`、`m`、`s`、`u` 标志，以及整体匹配或捕获组。规则在保存前需通过样本测试，保存在当前浏览器站点的 `localStorage`，不会跨设备同步。

规则在一次性 Web Worker 中执行，并限制输入长度、规则数量和匹配数量。超时、规则错误或发送期间规则变化会阻止发送。当前没有 RE2 导入、导出功能。

恢复映射保存在当前浏览器 IndexedDB。模型需要保留替换标记才能恢复；Markdown 代码和链接目的地址不会自动还原。历史、搜索及非 Chat 视图可能只显示 Host 侧的脱敏内容。

## 贡献与反馈

反馈问题时请说明 DSH 与插件版本、检测方式、操作步骤及预期行为，优先提供合成文本。不要提交真实个人信息、密钥或内部部署配置。

修改检测、发送或恢复行为时，检查相关类型与已有回归用例；修改公共行为时同步更新用户说明。版本升级应同时更新两个清单和文档中的安装包示例。
