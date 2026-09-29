# 直接导入 Qwen3.5 PII 模型的实施方案

目标：用户直接选择 `Qwen3.5-0.8B-pii-v2-merged` 这类 Hugging Face/Transformers 模型目录，在浏览器本地完成 WebGPU 推理；不要求先转换 GGUF，也不要求另选 manifest JSON。

## 总体约束

- 输入为 Transformers 目录：`config.json`、`model.safetensors`（或分片）、tokenizer 文件和 chat template。
- 首个目标架构为 `qwen3_5`，必须读取 metadata 精确识别，不能按文件名判断。
- 推理运行在独立 Web Worker + WebGPU 中；不静默回退 CPU。
- 原文、权重和 tokenizer 只在当前浏览器会话处理，不上传远程服务。
- 加载、推理、输出校验、Worker 或 GPU 失败时阻止发送，不自动退回正则。
- 不持久化模型文件；刷新、重启或文件句柄失效后重新选择。

## 阶段一：冻结直接导入契约

### 文件选择

提供“选择本地模型目录”。目录至少包含 `config.json`、`model.safetensors`（或分片及 index）、`tokenizer.json`/等价 tokenizer、`tokenizer_config.json`，以及 `chat_template.jinja` 或 tokenizer config 中的 `chat_template`。可选读取 `generation_config.json`，但插件固定安全上限，不能完全信任其中的生成参数。

### 分层架构

```
PrivacyController → LocalModelDetector → TransformersModelAdapter
                  → WebWorkerRuntimeAdapter → WebGPU backend
```

控制器不得直接依赖 safetensors、Qwen3.5 或 WebGPU 对象；格式解析、架构适配、tokenizer、prompt 和运行时错误由适配层负责。

## 阶段二：目录发现与校验

读取用户选择的文件列表，按相对路径建立内存索引。支持单文件和 safetensors 分片；若有 index，必须验证所有 shard 存在且无缺失/重复。

解析 `config.json` 并验证 `model_type: "qwen3_5"`、文本生成架构、hidden size、层数、词表大小和最大位置长度。检查 safetensors header、tensor 名称、dtype、shape 与 config 一致；检查 tokenizer、special tokens、chat template、总大小、上下文长度和显存预算。不能把 `config.json` 当 manifest，也不能把 safetensors 当 GGUF。

架构注册表至少包含 `qwen3_5 → Qwen3.5 Transformers adapter`。未知架构在 GPU 初始化前拒绝，并显示“架构不支持”。

## 阶段三：取消必选 manifest

模型能力按优先级读取：`config.json`；`tokenizer_config.json`/`chat_template.jinja`；`generation_config.json`（仅建议值）；插件内置 Qwen3.5 PII 协议默认值。不要求用户选择 manifest JSON。未来可支持可选 `zeroclave.local-model.json`，但它不能放宽结构校验。适配器固定使用 `zeroclave.local-model.v1` 输出协议。

## 阶段四：直接导入 UI 与生命周期

流程为：选择目录（或备用的全部模型文件）→ 显示发现结果 → 验证 → 加载 → Worker 初始化 WebGPU、tokenizer 和权重 → 预热 → ready。显示模型 ID、架构、版本、权重文件、tokenizer、模板和大小。替换模型前取消加载/推理并释放旧资源；卸载终止 Worker、释放 GPU buffer 并清除 metadata。不得保存绝对路径、句柄、权重内容或原文到 telemetry。

## 阶段五：safetensors WebGPU 运行时

Worker 负责目录索引、safetensors reader、tokenizer、prompt、WebGPU 推理和输出解析；主线程只接收进度、状态和已校验结果。初始化为：检查 WebGPU → adapter/device → limits 和显存预算 → tokenizer/template → 单文件或分片权重 → Qwen3.5 图 → 预热 → ready。

处理 WebGPU 不可用、device lost、内存不足、Worker 崩溃、加载/推理超时；失败时释放资源、设置错误状态并阻止发送。先在 Apple Silicon、NVIDIA Windows、NVIDIA Linux 验证。若 backend 不支持 bfloat16，应明确报错并提供经过验证的 float16/量化变体，不得静默转换或回退 CPU。

## 阶段六：Qwen3.5 适配器

优先使用目录 chat template；固定系统提示词，要求只输出 PII 检测 JSON；将原文包裹为不可信数据；明确实体类型、UTF-16 offset 和片段字段；固定 temperature、最大输出 token、停止条件和上下文上限；优先 JSON grammar/constrained decoding。记录 Transformers、dtype 和 tokenizer 版本；未经验证的 Qwen3.5 变体显示“未验证”。

## 阶段七：输出协议与转换

模型输出至少含实体类型、起止位置、原文片段和可选 confidence。依次校验 JSON、顶层结构、数组、类型、非负整数、越界、起点小于终点、片段匹配、confidence、重叠实体，再转换为 `PrivacyFinding`，与正则结果合并并生成 `ScanResult`。统一使用 JavaScript UTF-16 offset，测试中文、emoji、组合字符和中英文混合。截断、额外自然语言、非法区间、片段不匹配、未知类型、超限、超时或 partial 均失败，不能生成空结果放行。

## 阶段八：整合检测流程

`local-model` 支持 `unconfigured`、`loading`、`ready`、`error`、`partial`，并区分模型加载状态和单次推理状态。当前 detector 为 `local-model` 时：先运行正则 → 调用 Qwen3.5 → 等待完整结果 → 合并、排序、去重 → 生成审计结果 → 仅完整成功才允许发送。失败时保留错误、更新审计、显示原因、阻止发送，不自动降级正则。结果 metadata 包含请求/实际 detector、架构和版本、fallback 标志、推理状态及 finding 来源。

## 阶段九：设置界面与验收

界面包含选择模型目录、验证/加载/取消/卸载/测试、模型信息、WebGPU 状态、资源提示和错误原因。不再显示“Choose GGUF”或必选“Choose manifest JSON”。测试模型只能使用内置合成样本，覆盖 email、person、phone、中文、emoji、重叠实体、超长文本、非法输出和超时。

必须验收：直接导入 `Qwen3.5-0.8B-pii-v2-merged`；单文件和分片 safetensors；缺失文件、损坏 header、dtype/shape 不匹配、架构不支持、WebGPU 不可用、Worker 崩溃、替换和卸载。模型未加载、加载失败、推理失败、输出非法或 partial 时发送始终被阻止；既有 manual confirmation / automatic redaction 策略继续生效。

## 阶段十：后续扩展

可选目录 manifest、更多 Transformers 架构和量化格式、File System Access 安全句柄、持久化缓存或 CPU fallback，均须在明确验证后单独加入。
