# Agent Instructions

This document provides instructions for AI agents working on this codebase.

## About This Project

This project is a TypeScript-based networking library for a frontend application to communicate with a game server. Its primary goal is to provide a stable, resilient, and easy-to-use API for game developers, while handling the complexities of network state, protocol specifics, and error recovery internally.

## Key Principles

- **TypeScript First**: All code must have complete and accurate type definitions.
- **Minimal Dependencies**: Do not add new production dependencies without a strong justification.
- **High Test Coverage**: All logical code must be covered by unit tests. The target coverage is >90%.
- **Clarity and Simplicity**: The internal code should be well-commented, and the public API must remain simple and intuitive.

## Development Workflow

1.  **Understand the Goal**: Before writing code, understand the requirements from the issue description and the project's existing architecture.
2.  **Write/Update Tests**: For any new feature, write tests first. For any bug fix, first write a failing test that reproduces the bug.
3.  **Implement the Change**: Write the code to make the tests pass.
4.  **Verify**: Run all checks to ensure your change is correct and does not introduce regressions.

## How to Verify Your Work

Before submitting your changes, you **must** run the following commands and ensure they all pass without errors.

1.  **Install Dependencies**:

    ```bash
    npm install
    ```

2.  **Run All Tests**: This command executes all unit and integration tests.

    ```bash
    npm test
    ```

3.  **Check Test Coverage**: This command runs tests and generates a coverage report. Ensure your changes are well-covered and that the overall coverage does not drop below 90%.

    ```bash
    npm run test:coverage
    ```

4.  **Build the Project**: Ensure the project can be successfully compiled into JavaScript.
    ```bash
    npm run build
    ```

## Programmatic Checks

You can run all verification steps using a single command defined in `package.json`.

**Agent, to validate your work, run this command:**

```bash
npm run check
```

_(Note: The `check` script will be configured in `package.json` to execute the commands listed above)._
