<div align="center">

# 🛡️ ZeroClave Privacy Firewall

### 面向 DeepSeek Harness 的本地优先隐私守护插件

在消息发送给模型之前，发现敏感实体、展示脱敏结果，并让用户决定什么可以离开浏览器。

[![CI](https://github.com/ZeroClave/zeroclave-dsh-privacy/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ZeroClave/zeroclave-dsh-privacy/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-0ca66d.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/DeepSeek%20Harness-Web%20%7C%20Desktop%20Web%20Surface-1769d1.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Version](https://img.shields.io/badge/version-alpha.27-f0a51b.svg)](package.json)

[🚀 上传到 DeepSeek Stream](https://deepseek.stream/upload) · [📚 开发指南](https://deepseek.stream/guide) · [💬 ZeroClave 社区](https://zeroclave.com/community)

</div>

> [!WARNING]
> 当前版本仍处于 alpha。插件只检测消息文本；图片、文件、音频、工具参数和附件元数据不在检测范围内。检测结果不是合规保证，仍可能存在误报和漏报。

## ✨ 为什么使用 ZeroClave

| 🧭 先看再发 | 🔐 默认不改草稿 | 🧩 三种检测器 |
| --- | --- | --- |
| 发送前查看当前输入、敏感实体和脱敏输出 | 原文留在 composer，只有确认后的内容发送给模型 | 本地正则、浏览器本地 BERT、ZeroClave Gateway |

## ⚡ 三步工作流

```text
输入消息  →  检测敏感实体  →  编辑/取消保护/确认脱敏  →  发送
                         ↘  发送失败：保留原草稿
```

手动确认模式下，“隐私检测”“查看详情”和按回车使用同一个检测面板。用户可以在面板内修改脱敏值、取消保护或恢复保护，点击“确认脱敏并发送”直接继续 Harness 原生发送流程。附件、队列和草稿清理仍由 Harness 管理。

## 功能概览

- 在 composer 发送边界执行检测和脱敏，保留用户原始草稿，发送失败时不会丢失输入。
- 默认使用“手动确认”：检测完成后查看敏感实体和脱敏输出，再确认发送。
- 可切换“自动脱敏”：检测成功后直接发送脱敏文本。
- 在确认界面逐项编辑脱敏值、取消某一项保护，或使用“撤销”恢复保护。
- 支持自定义敏感实体、正则规则，以及规则的新增、编辑、复制、启用、停用和删除。
- 支持还原：模型回复保留替换标记时，可在消息显示和复制时恢复对应内容。
- 可选匿名使用统计，默认由部署配置决定，用户始终可以关闭。

## Harness 版本兼容

alpha.27 的安装声明包含 DSH `0.2.0-rc.2`，同时保留 DSH `0.1.3-alpha.1` 兼容。侧栏会话选择适配两代接口，发送取消和检测失败会释放 Harness 创建的临时消息。浏览器和桌面版使用同一插件包。

CI 仍使用下文的 0.1.3 构建基线。针对 0.2.0-rc.2 的构建使用上游提交 `639ed015397290b3745d163aafe02ffee4aa3f84`，将插件放在 `packages/extensions/zeroclave-privacy`；新版构建器不允许第三方插件依赖 `packages/experimental` 中的输入。

## 检测方式

在插件的“检测设置”中选择检测器：

| 检测器 | 执行位置 | 网络行为 | 适用场景 |
| --- | --- | --- | --- |
| 本地正则 | 浏览器 | 不联网 | 结构化字段、密钥、合同编号、账号、邮箱、电话等 |
| 浏览器本地 BERT | 浏览器 WebAssembly | 首次使用下载模型文件；不会上传消息文本 | 英文自然语言补充检测 |
| ZeroClave API | DSH Host + ZeroClave Gateway | 浏览器只请求同源 DSH Host，由 Host 转发 HTTPS 请求 | 增强实体识别，适合需要网关检测的部署 |

本地正则无需下载，适合中文合同中的结构化字段。BERT 模型主要面向英文；中文合同建议以本地正则为主。BERT 不可用时可以在设置中明确切换到本地正则，不会默认为安全。

ZeroClave 检测失败或返回不完整结果时不会被视为“没有敏感信息”，发送会被阻止。检测页提供重新检测和“改用本地正则”；切换后需要重新检测并确认发送。BERT 未加载或加载失败时也会阻止发送，需要加载模型或明确选择本地正则。用户选择的检测方式保存在当前浏览器。

### ZeroClave 网关边界

浏览器请求的地址是同源路径：

```text
POST /api/zeroclave-privacy/detect
```

DSH Host 将请求转发到配置的网关地址，默认目标为：

```text
https://zeroclave.com/v1/pii/detect
```

浏览器不需要 ZeroClave API key，也不依赖网关站点的 CORS 配置。连接测试只发送固定的合成文本 `ZeroClave synthetic connection test: demo@example.com`，不会发送当前草稿。

这不是浏览器到 TEE 的端到端加密通道。选择 ZeroClave 时，DSH Host 和 Gateway 在检测阶段可以看到原文；模型收到的是后续脱敏结果。网关响应只包含实体位置和类型，替换值由客户端生成。

## 发送流程

### 手动确认

1. 插件检测当前消息文本。
2. 右侧面板显示“当前输入”“脱敏输出”和敏感实体列表。
3. 用户可以修改脱敏值、取消某一项保护，或者在“保留原文”中逐项恢复。相同内容的多处命中可展开查看，并选择仅修改此处或全部相同内容。
4. 保存编辑后点击“确认脱敏并发送”。按钮显示发送中并阻止重复提交；发送成功后收起确认面板，由 Harness 清理本次草稿。
5. 点击“取消发送”则保留原草稿。

取消保护会明确提示该内容将以原文发送给大模型。同一草稿重新检测时保留人工修改，草稿文字改变后重新检测并重置旧选择，避免将旧实体位置应用到新文字。检测预览的占位符只在内存中保留，确认发送时才持久化本地恢复映射。只有发送成功后输入框才会清空；失败时保留输入和人工修改，可在原面板重试。

### 自动脱敏

检测成功后，插件直接将脱敏文本交给 Harness composer。原始草稿不会被插件改写，只有发送给会话和模型的文本使用脱敏结果。

## 本地规则和自定义实体

打开插件的“正则规则”页可以管理规则。每条规则包括：

- 名称和 JavaScript 正则表达式；
- `i`、`m`、`s`、`u` 标志；
- 整体匹配或捕获组作为脱敏范围；
- 实体类型、类别、严重级别和启用状态。

规则在保存前必须通过测试。规则保存在当前浏览器 origin 的 `localStorage` 中，不会同步到其他浏览器或设备。规则执行在一次性 Web Worker 中，并受到输入长度、规则数量和匹配数量限制；超时、规则错误或规则在发送期间发生变化时，发送会被阻止。

检测结果中的“+”按钮可以为当前消息添加自定义敏感实体，填写原文和替换内容后即可纳入本次检测和发送。

## 数据和隐私边界

- 插件只处理当前消息文本，不检测附件、图片、音频、工具调用参数或文件内容。
- 本地正则和浏览器本地 BERT 不会把消息文本发送到检测服务。
- ZeroClave 会把检测请求从浏览器转发到 DSH Host，再由 Host 通过 HTTPS 请求 Gateway；Host 和 Gateway 可见检测原文。
- 发送到模型前，敏感实体会被替换为客户端生成的占位符或用户编辑后的值。
- 原文到占位符的映射保存在浏览器 IndexedDB，仅用于当前浏览器显示和复制恢复，不进入模型请求或 Host 会话日志。
- 清除浏览器数据、更换浏览器或 origin、以及在其他设备打开会话，都会使本地恢复映射不可用。
- 启用隐私功能时，插件会阻止无法保留会话映射的低级 `conversation.send(text)` 路径；请使用正常 composer。

## 匿名使用统计

插件支持可选的匿名使用统计。统计服务和接收地址属于具体部署配置，不在开源项目中固定或公开：

- `privacy_active`：是否执行了隐私检测；
- `protected_send`：受保护的请求是否成功发送；
- `detector_used_*`：实际使用的检测器。

事件不包含输入文本、命中内容、规则、会话内容、错误、请求 ID 或设备属性。事件可能被伪造，因此只适合观察近似产品趋势，不适合计费、安全决策或精确 DAU。

部署配置中的 `telemetryEnabled` 控制是否提供遥测能力。用户可以在“检测设置”关闭“共享匿名使用统计”；Global Privacy Control（GPC）也会强制关闭该选项。启用后，配置的统计服务可能处理连接元数据，但插件不会发送文本、命中内容、规则、会话内容或每日 ID。事件可能被伪造，因此只适合观察近似产品趋势。

## 配置

插件 Host 配置位于 `cordis.patch.yml` 的插件条目中：

```yaml
- insert:
    - id: zeroclave-privacy
      name: '@zeroclave/dsh-privacy'
      config:
        gatewayBaseURL: https://zeroclave.com/v1
        timeoutMs: 15000
        telemetryEnabled: true
        telemetryTimeoutMs: 2000
```

主要字段：

| 字段 | 说明 | 默认值 |
| --- | --- | --- |
| `gatewayBaseURL` | ZeroClave Gateway 基础地址，只允许 HTTPS；本机回环地址可使用 HTTP | `https://zeroclave.com/v1` |
| `timeoutMs` | ZeroClave 检测超时时间，范围 100 至 30000 ms | `15000` |
| `telemetryEnabled` | 是否向浏览器提供遥测能力；当前发布配置默认开启，用户可以在设置中关闭 | `false`（配置示例开启） |
| `telemetryTimeoutMs` | 遥测中继超时时间，范围 100 至 10000 ms | `2000` |

配置 schema 默认关闭遥测；当前发布包通过 `cordis.patch.yml` 开启匿名统计。下游部署可以关闭，或在自己的部署配置中选择 provider、endpoint 和站点标识，不要把内部地址或密钥提交到公开仓库。

## 构建和测试

插件依赖 DeepSeek Harness 的 workspace 包，不能直接在独立目录执行 `npm run build`。当前包提供的是 `bundle` 脚本，不提供 `build` 脚本。

仓库记录了经过校验的 Harness revision：

```text
revision: d347e703908d0406b7a7ef80e3a0e594d86b2215
tag: dsh-v0.1.3-alpha.1
Node: 24.19.0
pnpm: 11.7.0
```

推荐构建流程：

```bash
git clone https://github.com/ZeroClave/zeroclave-dsh-privacy.git
git clone https://github.com/deepseek-ai/deepseek-harness.git

cd deepseek-harness
git checkout d347e703908d0406b7a7ef80e3a0e594d86b2215
mkdir -p packages/experimental/zeroclave-privacy
rsync -a --delete \
  --exclude=.git \
  --exclude=.github \
  --exclude=integrations \
  ../zeroclave-dsh-privacy/ packages/experimental/zeroclave-privacy/

pnpm install --frozen-lockfile
pnpm run build:lib:host
pnpm run build:lib:client
pnpm install --frozen-lockfile --filter '@zeroclave/dsh-privacy...'
pnpm --filter '@zeroclave/dsh-privacy' exec tsc --project tsconfig.json --noEmit
pnpm --filter '@zeroclave/dsh-privacy' run bundle
pnpm --filter '@zeroclave/dsh-privacy' test
```

生成 npm/DSH 命令行安装包：

```bash
pnpm --filter '@zeroclave/dsh-privacy' pack --pack-destination ./artifacts
node packages/experimental/zeroclave-privacy/scripts/audit-package.mjs artifacts/*.tgz
shasum -a 256 artifacts/*.tgz
```

DeepSeek Stream 上传页只接受标准 `.zip`。CI 会另外生成一个 ZIP，顶层包含单一插件目录以及 `plugin.json`、`package.json`、`cordis.patch.yml`、`README.md`、`LICENSE` 和 `lib/`：

```bash
rm -rf stream-package
mkdir -p stream-package/zeroclave-dsh-privacy/lib/types
cp plugin.json package.json cordis.patch.yml README.md LICENSE \
  stream-package/zeroclave-dsh-privacy/
cp lib/client.js lib/index.js stream-package/zeroclave-dsh-privacy/lib/
rsync -a --include='*/' --include='*.d.ts' --exclude='*' \
  lib/types/ stream-package/zeroclave-dsh-privacy/lib/types/
(cd stream-package && zip -qr ../zeroclave-dsh-privacy.zip zeroclave-dsh-privacy)
```

从 GitHub Actions 的 artifact 中下载 `zeroclave-dsh-privacy-<commit>.zip`，直接上传到 [DeepSeek Stream 插件发布页](https://deepseek.stream/upload)。上传页要求插件压缩包为 ZIP，并在包内提供标准清单文件；不要上传 `.tgz`。

GitHub Actions 会在 `main`、`alpha` push、Pull Request 和手动运行时执行类型检查、构建、单元/集成测试和安装包审计。push 和手动运行会上传 `.tgz`、Stream 用 `.zip` 以及对应的 SHA-256 校验文件。

## GitHub Release

正式发布时，先确认 `package.json` 和 `plugin.json` 版本一致，再创建同版本标签：

```bash
git tag -a v0.1.0-alpha.27 -m "Release v0.1.0-alpha.27"
git push origin v0.1.0-alpha.27
```

推送 `v*` 标签会触发 CI。所有检查通过后，Actions 会自动创建 GitHub Release，并附上 `.zip`、`.tgz` 和 SHA-256 校验文件。版本标签必须去掉 `v` 后与包版本完全一致。

## 本地安装到 DSH

桌面版打开“插件 → 添加插件”，在“包名或地址”中填入下载好的 `.tgz` 文件的绝对路径，安装完成后点击“立即启用”。也可以填写包含 `package.json` 和 `lib/` 的已编译插件目录。升级已安装版本时，需要先卸载旧版再安装新版。`.zip` 用于 DeepSeek Stream 上传。

在匹配的 Harness checkout 中执行：

```bash
pnpm dsh plugin --profile web add ./packages/experimental/zeroclave-privacy
pnpm dsh web --no-open
```

修改插件源码或替换构建包后，需要重新构建并重启对应 DSH Web profile。DSH 支持 Git 仓库安装，但本仓库不提交编译后的 `lib/`，因此请使用 Actions 或 Release 生成的 `.tgz` 安装包。

## 已知限制

- 检测结果不是合规保证，仍可能存在误报和漏报。
- BERT 模型主要面向英文，中文合同不应只依赖 BERT。
- ZeroClave 不是 E2EE 通道；网关和 DSH Host 在检测阶段可见原文。
- 直接 Host API、自动化脚本和 composer 之外的发送路径不在浏览器适配器的完整保护范围内。
- 本地恢复映射不跨浏览器、设备或 origin 同步。
- 自定义规则使用 JavaScript 正则语法，当前没有 RE2 导入/导出功能。
- 浏览器历史、搜索和非 Chat 视图可能只保留 Host 侧的脱敏表示。

## 💬 社区与支持

微信群、版本公告、安装指引和反馈入口统一维护在 ZeroClave Community：

<div align="center">

### [进入 ZeroClave Community →](https://zeroclave.com/community)

获取最新群组入口、插件发布信息和社区支持。请不要在 README 或 issue 中公开分享个人邀请链接、内部部署地址或遥测配置。

</div>

## 🌐 发布与安装

- **DeepSeek Stream**：上传 CI 生成的 `.zip`，包内包含 `plugin.json`、`package.json`、`cordis.patch.yml`、`README.md`、`LICENSE` 和 `lib/`。
- **本地 DSH**：使用匹配 Harness workspace 构建出的 `.tgz`，通过 `dsh plugin --profile web add` 安装。
- **桌面 GUI**：插件是 Web client + Host 插件，可以随 Desktop 内嵌的 DSH Web Surface 加载；当前 manifest 仍声明为 `platform: web`，桌面原生能力不在插件范围内。

发布包、CI、安装和版本兼容性说明见上面的“构建和测试”章节。

## 许可证

本项目使用 Apache-2.0 许可证。内置 BERT 模型的许可证和使用限制请以其模型卡为准。
