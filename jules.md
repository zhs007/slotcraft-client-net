# 项目概要：游戏网络库

## 1. 核心目标

开发一个健壮、高效且轻量级的 TypeScript 前端网络库。该库将作为游戏应用层与游戏服务器之间的通信桥梁，处理 WebSocket 连接、协议交互、状态同步和错误恢复。

## 2. 核心功能

- **连接管理**: 提供 `connect(token)` 方法来处理 WebSocket 连接、版本检查和登录流程。
- **状态机**: 内部管理从“未连接”到“游戏中”的完整生命周期状态 (`IDLE`, `CONNECTING`, `CONNECTED`, `IN_GAME`, `RECONNECTING`, `DISCONNECTED`)。
- **协议封装**: 提供简洁的 API (`send`, `enterGame`)，使开发者无需关心 `cmdid`, `msgid` 等协议细节。
- **事件驱动**: 通过 `on(event, callback)` 与游戏模块解耦。支持 `connect`, `disconnect`, `reconnecting`, `message`, 和 `raw_message` 等事件。
- **自动重连**: 在网络意外断开时，自动尝试重新连接。
- **Keep-Alive**: 登录成功后，自动处理心跳消息，维持长连接。
- **请求超时**: `send` 方法返回的 Promise 会在超时后自动-reject。

## 3. 技术规约

- **语言**: TypeScript，提供完整的类型定义。
- **依赖**: 最小化原则，优先使用平台原生 API（如浏览器 `WebSocket`）。
- **测试**: 使用 Vitest 进行单元测试，逻辑代码覆盖率目标 > 80%。
- **打包**: 兼容 Vite 环境，可通过 `npm install` 直接集成。
- **文档**: 提供中英双语的详细使用文档和 API 参考。

## 4. 关键设计原则

- **接口简洁**: 对游戏层暴露的接口应尽可能简单。`connect` 处理连接和登录，`enterGame` 处理进游戏，`send` 处理通用指令。
- **状态明确**: 库内部精确追踪当前状态，并能正确处理在任何状态下收到的用户请求或服务器消息。
- **错误处理**: 严格遵循服务器文档定义的 `cmdret` 流程，并通过 Promise rejection 向上传递错误。
- **无阻塞**: 所有网络操作均为异步非阻塞。
- **高容错**: 网络问题不应导致游戏崩溃，库会尝试自动重连。

## 5. 目录结构

```
.
├── docs/              # 文档 (服务器协议、使用说明)
├── dist/              # 打包后的产物
├── src/               # 源代码
│   ├── types.ts       # 核心类型定义
│   ├── connection.ts  # WebSocket 封装
│   ├── main.ts        # 主模块 (NetworkClient)
│   └── event-emitter.ts # 事件分发器
├── tests/             # 测试文件
├── examples/          # 示例代码
├── jules/             # 开发计划
├── .gitignore
├── package.json
├── tsconfig.json
└── jest.config.js
```

## 6. 示例 (Examples)

为了方便开发者理解和快速上手，项目在 `examples/` 目录下提供了一个可以直接运行的示例脚本。

- **`examples/example001.ts`**:
  - **功能**: 使用 `NetworkClient` 演示了完整的客户端生命周期：`connect`, `enterGame`, `send`。
  - **配置**: 通过根目录的 `.env` 文件进行配置（`WEBSOCKET_URL`, `TOKEN`, `GAME_CODE`）。
  - **协议日志**: 该示例演示了如何通过监听 `raw_message` 事件来记录所有与服务器的上下行通信到 `msg001.txt` 文件。这份日志可以作为开发和调试，乃至实现 Mock Server 的重要依据。
  - **运行**: `npx ts-node examples/example001.ts`
