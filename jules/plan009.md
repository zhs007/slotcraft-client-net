# Plan to Address Code Review Feedback (report-001)

## 1. Understanding and Goal

The initial request is to analyze the code review report `codereview/report-001.md` and apply the necessary fixes to the codebase. The report covers a TypeScript WebSocket client library and provides a prioritized list of issues and suggestions.

My goal is to implement all the high-priority (P1) and medium-priority (P2) suggestions, as the highest-priority (P0) issues were found to be already resolved. This will improve the library's robustness, usability, and maintainability.

## 2. Task Decomposition

### Step 1: Refactor `src/connection.ts`
- **Action:** Add a public getter for `readyState`.
- **Action:** Widen the type of the `data` parameter in the `send` method to `string | ArrayBufferLike | Blob | ArrayBufferView`.
- **Rationale:** This addresses suggestions for better state visibility and API compatibility.

### Step 2: Refactor `src/event-emitter.ts`
- **Action:** Modify the `once` and `off` methods to allow for the removal of `once` listeners using the original callback reference.
- **Rationale:** This fixes a limitation in the event emitter where `once` listeners could not be easily unsubscribed before firing.

### Step 3: Refactor `src/main.ts`
- **Action:** Introduce a configurable logger via `SlotcraftClientOptions`, defaulting to the `console` object.
- **Action:** Emit more granular events for `login`, `enter_game`, and `disconnect` in addition to the existing generic `state` event.
- **Rationale:** This improves the library's observability and makes it easier for consumers to hook into key lifecycle moments and control logging in production.

### Step 4: Improve Library Exports
- **Action:** Create a barrel file at `src/index.ts` to export all public APIs.
- **Action:** Update `package.json`'s `main` and `types` fields to point to the new entry point.
- **Rationale:** This provides a clean, single entry point for the library, improving the developer experience for consumers.

### Step 5: Documentation and Verification
- **Action:** Create this plan document (`jules/plan009.md`).
- **Action:** Install dependencies (`npm install`).
- **Action:** Run all verification checks (`npm run check`), which includes linting, testing, and building the project.
- **Action:** Create a final report document (`jules/plan009-report.md`).
- **Action:** Update the root `jules.md` with a summary of the work performed.
- **Rationale:** This ensures the project is in a healthy state after the changes and fulfills all parts of the user's request.
