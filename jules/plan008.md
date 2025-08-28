# Plan 008: Create a WebSocket Client Example and Protocol Log

## 1. Original User Request

> 我想要一个例子 example001.ts ，放 examples 目录下，用 环境变量 配置 websocket的url和token、gamecode，然后连接服务器，登陆、进入游戏、发送游戏请求。
> 这个例子除了用来验证实际的client逻辑正确外，我还希望能得到一份完整的协议记录，后续会基于这个协议记录实现 mock server 。
> 所以 需要将 发送的请求，和 收到的服务器返回，全部都记录到一个msg001.txt文件里。
>
> 理解这个任务，制定执行计划，写在 jules/plan[id].md （譬如plan001.md，注意不要覆盖现在已经存在的plan）里（这里记录原始需求，以及你对原始需求的理解），完成后，生成任务报告 plan[id]-report.md （这里记录任务执行流程，和中间遇到的问题以及解决方案等），依然放在 jules 目录下。
>
> 然后将必要的信息更新到 根目录下的jules.md 文档。
>
> 然后，如果有需要的话，按 https://agents.md/ 的规范更新 agents.md 文件。

## 2. My Understanding of the Requirements

The user wants a functional TypeScript example that demonstrates how to use the networking library to connect to a game server.

### Key Deliverables:

1.  **`examples/example001.ts`**: A new example file.
    *   It must be configurable via environment variables (`WEBSOCKET_URL`, `TOKEN`, `GAME_CODE`). The user prefers using a `.env` file for this.
    *   It should connect to the WebSocket server and execute a specific sequence of actions:
        1.  Perform a version check (`checkver`).
        2.  Log in to the server (`flblogin`).
        3.  Enter a specific game (`comeingame3`).
        4.  Send a game action, like a "spin" (`gamectrl3`).
    *   The script should use the existing library components, such as the `Connection` class, to ensure it serves as a valid usage example.

2.  **`msg001.txt`**: A protocol log file.
    *   This file must capture all JSON messages sent by the client and received from the server.
    *   The logging format should be clear enough to be used as a reference for creating a mock server in the future. A format like `[DIRECTION] [TIMESTAMP]: [MESSAGE]` would be appropriate.

3.  **Documentation**:
    *   This plan file (`jules/plan008.md`) to document the initial request and my interpretation.
    *   A corresponding report file (`jules/plan008-report.md`) to be created after the task is complete, detailing the implementation process.
    *   An update to the main `jules.md` file to include information about the new example.
    *   An update to `package.json` to include a `check` script as specified in `agents.md`.

### Technical Approach:

*   **Dependencies**: I'll add `dotenv` to manage environment variables and `isomorphic-ws` to provide a `WebSocket` implementation for the Node.js environment, as the existing `Connection` class expects it to be globally available.
*   **Protocol Implementation**: I will strictly follow the protocol flow and message formats defined in `docs/frontend-ws-doc-zh.md`. This includes correctly handling the `ctrlid` passed from the server in `gameuserinfo` messages for use in subsequent `gamectrl3` requests.
*   **File Structure**: I will create a new `examples/` directory for the script and its associated `.env` file. The output log `msg001.txt` will also be generated in the root.
*   **Verification**: I will use the `npm run check` command (which I will add to `package.json`) to ensure my changes don't break the existing project.
