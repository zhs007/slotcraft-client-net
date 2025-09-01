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
│   ├── main.ts        # 主模块 (SlotcraftClient)
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
  - **功能**: 使用 `SlotcraftClient` 演示了完整的客户端生命周期：`connect`, `enterGame`, `send`。
  - **配置**: 通过根目录的 `.env` 文件进行配置（`WEBSOCKET_URL`, `TOKEN`, `GAME_CODE`）。
  - **协议日志**: 该示例演示了如何通过监听 `raw_message` 事件来记录所有与服务器的上下行通信到 `msg001.txt` 文件。这份日志可以作为开发和调试，乃至实现 Mock Server 的重要依据。
  - **运行**: `npx ts-node examples/example001.ts`

## 7. 开发日志 (Development Log)

### 2025-08-29: 提升测试覆盖率 (Plan 009)

- **目标**: 将项目测试覆盖率提升至 90% 以上，以保证代码质量和长期可维护性。
- **实施**:
  - **引入 Mock Server**: 创建了 `tests/mock-server.ts`，使用 `ws` 库模拟 WebSocket 服务器行为，用于集成测试。
  - **编写集成测试**: 新增了 `tests/integration.test.ts`，全面测试了客户端的连接、登录、游戏流程、收集奖励、状态管理和错误处理等功能。
  - **提升覆盖率**: 通过新的测试套件，成功将 `src` 目录的测试覆盖率提升至 **91.6%**。
- **产出**:
  - `jules/plan009.md`
  - `jules/plan009-report.md`
  - `tests/mock-server.ts`
  - `tests/integration.test.ts`

### 2025-08-31: Code Review Follow-up (Plan 010)

- **目标**: 根据 `codereview/report-001.md` 的反馈，修复潜在问题并改进代码质量。
- **实施**:
  - **修复 `once()` bug**: 解决了 `event-emitter` 中 `once` 监听器无法被 `off` 的问题。
  - **优化 `send()` 接口**: 将 `Connection.send()` 的参数类型限制为 `string`，使其更符合当前协议需求。
  - **实现可配置日志**: 允许在客户端初始化时注入自定义 logger，以替代 `console`。
  - **改进类型导出**: 创建了 `src/index.ts` 作为统一出口，导出了所有公共类型，提升了库的可用性。
- **产出**:
  - `jules/plan010.md`
  - `jules/plan010-report.md`
  - `src/index.ts`
