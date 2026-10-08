# ZeroClave Privacy Firewall

ZeroClave Privacy Firewall 是面向 DeepSeek Harness 的隐私检测和脱敏插件。

在消息发送给大模型之前，插件会检测敏感实体，展示原文和脱敏结果，并允许用户决定哪些内容可以发送。

版本：0.1.0-alpha.27

平台：DeepSeek Harness Web，以及 Desktop 内嵌的 Web Surface。

## 功能

- 检测姓名、手机号、邮箱、身份证号、合同编号、银行信息、API Key 和其他敏感实体。
- 手动确认模式：发送前逐项查看敏感实体和脱敏结果。
- 自动脱敏模式：检测成功后直接发送脱敏文本。
- 编辑脱敏结果、取消某一项保护，或撤销取消保护。
- 原始草稿保持不变，发送成功后才清空输入。
- 添加自定义敏感实体和管理本地正则规则。
- 在消息显示和复制时恢复本地替换映射。
- 支持中文和英文界面。

## 检测方式

### 本地正则

在浏览器中运行，无需下载模型，也不会向检测服务发送消息文本。适合中文合同、结构化字段、账号、合同编号、邮箱、电话和密钥。

### 浏览器本地 BERT

在浏览器 WebAssembly 中运行。首次使用需要下载模型文件，但不会上传消息文本。该模型主要面向英文自然语言检测，中文合同建议优先使用本地正则。

### ZeroClave API

浏览器请求同源 DSH Host，再由 Host 通过 HTTPS 转发到配置的 ZeroClave Gateway。该方式提供增强实体识别，不需要在浏览器中配置 ZeroClave API Key。

ZeroClave 检测失败或结果不完整时，不会被视为安全，发送会保持阻止。需要回退时，请在检测设置中明确选择其他检测方式。

## 发送流程

1. 在 Harness composer 中输入消息。
2. 插件检测消息文本中的敏感实体。
3. 查看当前输入、脱敏输出和敏感实体列表。
4. 修改脱敏结果、取消选定实体的保护，或撤销取消操作。
5. 点击“确认脱敏并发送”，发送脱敏内容。

取消保护时，插件会明确提示相关内容将以原文发送给大模型。

## 隐私边界

- 只检测消息文本，不检测图片、文件、音频、工具参数和附件元数据。
- 本地正则和浏览器本地 BERT 不会上传消息文本。
- 使用 ZeroClave API 时，DSH Host 和 Gateway 在检测阶段可以看到原文。
- 浏览器本地替换映射保存在 IndexedDB，不会发送给模型，也不会写入 Host 会话日志。
- 匿名使用统计可以在“检测设置”中关闭。

## 匿名使用统计

部署可以选择是否启用匿名使用统计。插件只统计三类低粒度事件：

- 是否执行了隐私检测。
- 受保护的请求是否成功发送。
- 实际使用的检测器。

事件不包含输入文本、命中内容、规则、会话内容、错误、请求 ID 或设备属性。事件可能被伪造，因此统计只用于观察近似产品趋势。

## 安装

DeepSeek Stream：

从 GitHub Release 下载 ZIP 文件，然后上传到：

https://deepseek.stream/upload

本地 DSH：

桌面版打开“插件 → 添加插件”，在“包名或地址”中填入 TGZ 文件的绝对路径。安装完成后点击“立即启用”。已有旧版时，先卸载再安装新版。

在匹配的 Harness workspace 中使用 TGZ 包：

`pnpm dsh plugin --profile web add ./zeroclave-dsh-privacy-0.1.0-alpha.27.tgz`

然后启动 Web profile：

`pnpm dsh web --no-open`

## 兼容性

- DeepSeek Harness 0.1.3-alpha.1 和 0.2.0-rc.2。
- DeepSeek Harness Web。
- Desktop 内嵌的 DSH Web Surface。
- Apache-2.0 License。

## 相关链接

GitHub：

https://github.com/ZeroClave/zeroclave-dsh-privacy

DeepSeek Stream：

https://deepseek.stream/upload

开发指南：

https://deepseek.stream/guide

ZeroClave 社区：

https://zeroclave.com/community

## 已知限制

检测结果不是合规保证，仍可能存在误报和漏报。ZeroClave 不是端到端加密通道；检测阶段 DSH Host 和 Gateway 可以看到原文。
