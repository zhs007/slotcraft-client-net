# Plan 016: Correct Player Choice Flow

## 1. Goal

To fix critical bugs in the player choice game flow based on user feedback, ensuring the implementation strictly adheres to the server's `cmdret`-based protocol.

## 2. Rationale

The previous implementation (Plan 015) made an incorrect assumption about the game protocol. It transitioned to the `WAITTING_PLAYER` state immediately upon receiving a `gamemoduleinfo` message, without waiting for the `cmdret` of the initial `spin`. This violated the core design principle of the protocol, leading to race conditions and incorrect promise handling.

This plan refactors the logic to align with the correct flow as specified by the user:
1.  State transitions must only occur after a `cmdret` confirms the completion of a sent command.
2.  The `spin` promise must resolve normally, and the decision to enter `WAITTING_PLAYER` is made in the `cmdret` handler.
3.  A new `PLAYER_CHOICING` state will be introduced to represent the period after a player has made a selection and is waiting for the server's response, analogous to the `SPINNING` state.

## 3. Task Breakdown

1.  **Create New Plan and Report Files**: Document this new plan in `jules/plan016.md` and create `jules/plan016-report.md`.
2.  **Update Type Definitions (`src/types.ts`)**: Add the new `PLAYER_CHOICING` state to the `ConnectionState` enum.
3.  **Refactor `SlotcraftClient` Logic (`src/main.ts`)**:
    *   **`updateCaches`**: Remove the state transition logic from the `gamemoduleinfo` handler. It should only cache data.
    *   **`handleMessage` (`cmdret` handler)**:
        *   Modify the `gamectrl3` handler. When the state is `SPINNING`, it should inspect the cached `gamemoduleinfo` to decide whether to transition to `WAITTING_PLAYER` or `SPINEND`/`IN_GAME`.
        *   Add logic for the `PLAYER_CHOICING` state. When a `gamectrl3` `cmdret` is received in this state, transition to `SPINEND` or `IN_GAME`.
    *   **`selectOptional`**: Update this method to transition to the new `PLAYER_CHOICING` state and remove the now-unnecessary manual promise rejection logic.
4.  **Update Integration Test (`tests/integration.test.ts`)**:
    *   Rewrite the "Player Choice Flow" test to match the corrected protocol flow.
    *   Ensure the mock server sends a `cmdret` for the initial `spin`.
    *   Assert the correct state sequence: `... -> SPINNING -> WAITTING_PLAYER -> PLAYER_CHOICING -> SPINEND`.
5.  **Run Checks and Verify**: Run `npm run check` to ensure all tests, linting, and build steps pass.
6.  **Update Documentation**: Update `jules.md` and `agents.md` to reflect the corrected, more robust implementation.
7.  **Submit**: Request a final code review and submit the changes.

## 4. Success Criteria

- All bugs reported by the user are fixed.
- The client's state machine correctly and consistently follows the `cmdret`-based protocol.
- All existing and new tests pass.
- `npm run check` completes successfully.
- Documentation is updated to reflect the final, correct implementation.
