# LumaBridge

独立实现的 QQ 机器人后端兼容层，从可核验的能力和连接诊断开始。

An independently implemented compatibility layer for QQ bot backends, starting with explicit capabilities and read-only connection diagnostics.

**当前版本：`0.1.0-alpha.0`。项目仍处于起点。** 本版本提供内存中的核心模型和只读 OneBot HTTP 诊断工具；尚未提供完整网关、真实消息收发、WebSocket、MCP 或自研原生协议实现。

## 当前可以做什么

| 模块 | 当前范围 | 边界 |
| --- | --- | --- |
| Core | 能力注册、单账号后端约束、发送状态模型 | 状态只保存在内存中；没有生产消息队列 |
| Doctor | 调用 `get_version_info`、`get_status`、`get_login_info` | 只读探测；不登录账号、不发送消息、不修改后端配置 |
| 开发验证 | 类型检查、本地自动测试、构建 | 不等同于真实 QQ 登录与收发验收 |

Doctor 返回的信息反映后端在探测时刻的回答。版本接口可用、后端自报在线，都不能单独证明图片、文件、撤回或其他动作可用。当前也没有承诺任一 NapCat 或 SnowLuma 版本已通过实机兼容性验证。

## 开始使用

需要 **Node.js 24** 和 **pnpm 11.25.0**，以及你自行安装、配置并有权使用的 OneBot HTTP 后端。

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
cp examples/config.example.json lumabridge.local.json
```

在 `lumabridge.local.json` 中设置后端地址：

```json
{
  "backend": {
    "url": "http://127.0.0.1:3000",
    "tokenEnv": "LUMABRIDGE_BACKEND_TOKEN"
  },
  "timeoutMs": 5000
}
```

通过环境变量 `LUMABRIDGE_BACKEND_TOKEN` 提供后端 token，再运行：

```bash
pnpm run doctor --config ./lumabridge.local.json
```

`pnpm run doctor --help` 可离线查看用法。诊断输出默认隐藏账号 ID；退出码 `0` 表示后端自报在线且健康，`2` 表示可查询但离线、不健康或状态未知，`1` 表示配置、参数或请求失败。没有鉴权的本地测试后端可省略 `tokenEnv`；配置了该字段但环境变量缺失时会拒绝连接。

示例地址适用于后端与 Doctor 位于同一主机的情况。容器内的 `127.0.0.1` 指向该容器；跨主机使用时，应按实际网络设置地址和受保护的连接。请勿把 token、真实账号信息或本地配置提交到仓库。

## 我们准备解决的问题

不同后端可能使用相同动作名，却在消息标识、文件资源、事件格式或失败行为上有差异。LumaBridge 的方向是把这些差异变成明确的能力与契约：调用前知道是否支持，调用后保留结果依据，结果未知时不盲目重发。

后续将依次实现规范化事件、WebSocket 接入、持久化消息映射与队列、受控发送、真实环境验收，以及 SDK 和 MCP。以上都是路线计划，不属于当前版本已经交付的功能。详见 [架构说明](docs/architecture.md) 与 [路线图](docs/roadmap.md)。

## 贡献与许可

欢迎提交可复现的问题、脱敏的协议样例、测试和实现。提交前请阅读 [贡献指南](CONTRIBUTING.md)；安全问题见 [安全政策](SECURITY.md)。

LumaBridge 自有代码和文档采用 [Apache License 2.0](LICENSE)。本仓库不包含或分发 NapCat、SnowLuma、QQ 客户端、其原生组件或登录数据；第三方后端的许可由各自项目规定。独立实现是本项目的开发方式，不代表已经取得其他项目的许可，也不是任何形式的法律保证。来源和依赖政策见 [第三方说明](THIRD_PARTY_NOTICES.md)。

本项目与腾讯、NapCat、SnowLuma 无隶属或授权关系。
