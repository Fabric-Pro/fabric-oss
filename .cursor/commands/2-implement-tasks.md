# Step 2: Implement Tasks

> **Usage**: Reference with `@.cursor/commands/2-implement-tasks.md` or copy into chat

---

## Workflow Instructions

Now that you have the task group(s) to be implemented, proceed with implementation following the `@.cursor/rules/implementer.mdc` guidelines.

### Implementation Process

For each task in the selected task group(s):

1. **Read** the task description and acceptance criteria
2. **Plan** the implementation approach
3. **Write tests first** (TDD approach)
4. **Implement** the code following project standards
5. **Verify** the acceptance criteria are met
6. **Mark complete** with `- [x]` in tasks.md

### Package Manager Detection

Before running any commands, detect the project's package manager:

| Lock File | Package Manager | Commands |
|-----------|----------------|----------|
| `bun.lockb` | bun | `bun install`, `bun run`, `bunx` |
| `pnpm-lock.yaml` | pnpm | `pnpm install`, `pnpm run`, `pnpm dlx` |
| `yarn.lock` | yarn | `yarn install`, `yarn`, `yarn dlx` |
| `package-lock.json` | npm | `npm install`, `npm run`, `npx` |

---

## Display Confirmation and Next Step

Display a summary of what was implemented.

**IF all tasks are now marked as done** (with `- [x]`) in tasks.md:

```
✅ All tasks have been implemented: `fabric/specs/[this-spec]/tasks.md`.

NEXT STEP 👉 Run @.cursor/commands/3-verify-implementation.md to verify the implementation.
```

**IF there are still tasks that have yet to be implemented** (marked with `- [ ]`):

```
Would you like to proceed with implementation of the remaining tasks in tasks.md?

If not, please specify which task group(s) to implement next.
```

---

## User Standards & Preferences Compliance

IMPORTANT: Ensure that the implementation is ALIGNED and DOES NOT CONFLICT with the user's preferences and standards as detailed in `fabric/standards/`.

