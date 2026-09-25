# ZeroClave Privacy Firewall

面向 DeepSeek Harness 的本地优先隐私守护插件。

在消息发送给模型之前，检测敏感实体、展示脱敏结果，并让用户决定哪些内容可以发送。

版本：0.1.0-alpha.24
平台：DeepSeek Harness Web，以及 Desktop 内嵌的 Web Surface

项目地址：https://github.com/ZeroClave/zeroclave-dsh-privacy
DeepSeek Stream：https://deepseek.stream/upload
开发指南：https://deepseek.stream/guide
ZeroClave 社区：https://zeroclave.com/community

当前版本仍处于 alpha。插件只检测消息文本；图片、文件、音频、工具参数和附件元数据不在检测范围内。检测结果不是合规保证，仍可能存在误报和漏报。

## 功能

- 发送前查看当前输入、敏感实体和脱敏输出。
- 原文保留在 composer 中，只有确认后的内容发送给模型。
- 支持手动确认和自动脱敏两种发送策略。
- 支持逐项编辑脱敏值、取消保护和撤销取消保护。
- 支持自定义敏感实体和本地正则规则。
- 支持规则新增、编辑、复制、启用、停用和删除。
- 支持消息显示和复制时恢复本地替换映射。
- 支持中文和英文界面。
- 支持可选匿名使用统计，用户可以随时关闭。

## 检测方式

本地正则：

- 在浏览器中运行，不联网。
- 适合中文合同、结构化字段、合同编号、账号、邮箱、电话和密钥。

浏览器本地 BERT：

- 在浏览器 WebAssembly 中运行。
- 首次使用需要下载模型文件，不会上传消息文本。
- 主要面向英文自然语言补充检测。
- 中文合同建议优先使用本地正则。

ZeroClave API：

- 浏览器只请求同源 DSH Host。
- DSH Host 通过 HTTPS 转发到 ZeroClave Gateway。
- 适合需要增强实体识别的部署。

ZeroClave 检测失败或返回不完整结果时，不会被视为安全，发送会被阻止。需要回退时，请在检测设置中明确选择本地正则。

## 发送流程

1. 插件检测当前消息文本。
2. 右侧面板显示当前输入、脱敏输出和敏感实体列表。
3. 用户可以修改脱敏值、取消某项保护或撤销取消操作。
4. 点击“确认脱敏并发送”后，直接发送当前脱敏文本并清空草稿。
5. 点击“取消发送”则保留原草稿。

只有发送成功后输入框才会清空；发送失败时原输入仍然保留。

自动脱敏策略会在检测成功后直接使用脱敏文本继续发送。原始草稿不会被插件改写。

## ZeroClave 网关边界

浏览器请求地址为：

POST /api/zeroclave-privacy/detect

默认网关地址为：

https://zeroclave.com/v1/pii/detect

浏览器不需要 ZeroClave API key，也不依赖网关站点的 CORS 配置。连接测试只发送固定合成文本 demo@example.com，不会发送当前草稿。

ZeroClave 模式不是浏览器到 TEE 的端到端加密通道。检测阶段 DSH Host 和 Gateway 可以看到原文；模型收到的是后续脱敏结果。网关响应只包含实体位置和类型，替换值由客户端生成。

## 数据和隐私边界

- 插件只处理当前消息文本，不检测附件、图片、音频、工具调用参数或文件内容。
- 本地正则和浏览器本地 BERT 不会把消息文本发送到检测服务。
- 原文到替换标记的映射保存在浏览器 IndexedDB，仅用于当前浏览器显示和复制恢复。
- 映射不会进入模型请求或 Host 会话日志。
- 清除浏览器数据、更换浏览器或 origin、以及在其他设备打开会话，都会使本地恢复映射不可用。
- 启用隐私功能时，插件会阻止无法保留会话映射的低级 conversation.send(text) 路径；请使用正常 composer。

## 匿名使用统计

匿名使用统计由部署配置控制，用户可以在检测设置中关闭共享匿名使用统计。

只统计三类低粒度事件：

- privacy_active：是否执行了隐私检测。
- protected_send：受保护的请求是否成功发送。
- detector_used：实际使用的检测器。

事件不包含输入文本、命中内容、规则、会话内容、错误、请求 ID 或设备属性。事件可能被伪造，因此统计只适合观察近似产品趋势，不适合计费、安全决策或精确 DAU。

## 配置

Host 配置位于 cordis.patch.yml 的插件条目中。

默认配置示例：

- gatewayBaseURL：https://zeroclave.com/v1
- timeoutMs：15000
- telemetryEnabled：false
- telemetryTimeoutMs：2000

开源默认关闭遥测。下游部署如需启用，应在自己的部署配置中选择 provider、endpoint 和站点标识，不要把内部地址或密钥提交到公开仓库。

## 安装

DeepSeek Stream：

从 GitHub Release 下载 ZIP，然后上传到 https://deepseek.stream/upload。上传 ZIP 必须包含 plugin.json、package.json、cordis.patch.yml、README.md、LICENSE 和 lib。

本地 DSH：

使用匹配 Harness workspace 构建出的 TGZ，通过以下命令安装：

`pnpm dsh plugin --profile web add ./zeroclave-dsh-privacy-0.1.0-alpha.24.tgz`

然后启动：

`pnpm dsh web --no-open`

桌面 GUI：

插件是 Web client 加 Host 插件，可以随 Desktop 内嵌的 DSH Web Surface 加载。当前 manifest 声明为 platform: web，插件不使用桌面原生 API。

## 构建

插件依赖 DeepSeek Harness workspace，不能在独立目录执行 npm run build。

推荐流程：

1. 检出 DeepSeek Harness revision d347e703908d0406b7a7ef80e3a0e594d86b2215。
2. 将本仓库复制到 Harness 的 packages/experimental/zeroclave-privacy。
3. 在 Harness 根目录执行 pnpm install --frozen-lockfile。
4. 执行 pnpm run build:lib:host。
5. 执行 pnpm run build:lib:client。
6. 执行 pnpm --filter '@zeroclave/dsh-privacy' run bundle。
7. 执行 pnpm --filter '@zeroclave/dsh-privacy' test。

GitHub Actions 会在 main、alpha、Pull Request、v* 标签和手动运行时执行构建、测试和包审计。

## GitHub Release

正式发布时，确认 package.json 和 plugin.json 版本一致，然后创建同版本标签：

`git tag -a v0.1.0-alpha.24 -m "Release v0.1.0-alpha.24"`

`git push origin v0.1.0-alpha.24`

推送 v* 标签会触发 CI。所有检查通过后，Actions 会自动创建 GitHub Release，并附上 ZIP、TGZ 和 SHA-256 校验文件。

## 已知限制

- 检测结果不是合规保证，仍可能存在误报和漏报。
- BERT 主要面向英文，中文合同不应只依赖 BERT。
- ZeroClave 不是 E2EE 通道；网关和 DSH Host 在检测阶段可见原文。
- 直接 Host API、自动化脚本和 composer 之外的发送路径不在浏览器适配器的完整保护范围内。
- 本地恢复映射不跨浏览器、设备或 origin 同步。
- 自定义规则使用 JavaScript 正则语法，当前没有 RE2 导入/导出功能。

## 社区与支持

微信群、版本公告、安装指引和反馈入口统一维护在 ZeroClave Community：

https://zeroclave.com/community

## 许可证

本项目使用 Apache-2.0 许可证。内置 BERT 模型的许可证和使用限制请以其模型卡为准。
