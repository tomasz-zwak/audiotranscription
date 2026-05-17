# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime

This project uses [Bun](https://bun.sh) as its runtime, package manager, and bundler. Do not use `npm`, `npx`, or `node` — use `bun` equivalents.

## Commands

```bash
bun install          # install dependencies
bun run index.ts     # run the entry point
bun test             # run tests (Bun's built-in test runner)
```

## Memory convention

When the user prefixes any text with `#`, treat it as an explicit instruction to save that information to memory immediately. Pick the most appropriate memory type (user, feedback, project, or reference) and confirm once it has been saved.

Example: `# I prefer concise responses without bullet points` → save as feedback memory.

## Project state

This project was initialized with `bun init` and is not yet implemented. `index.ts` is the entry point (`"module": "index.ts"` in `package.json`). TypeScript is configured in strict mode with ESNext targets and bundler module resolution (`tsconfig.json`).
