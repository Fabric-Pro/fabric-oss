# Task List Creation Process

You are creating a tasks breakdown from a given spec and requirements for a new feature.

## User Standards & Preferences Compliance

**IMPORTANT**: Before creating tasks, you MUST check for and adhere to the user's project standards.

### Step 0: Load Standards & Detect Project Configuration

#### 0a. Load Standards

Check if standards exist and load them:

1. Check for standards directory: `fabric/standards/`
2. If it exists, **read ALL standards files recursively**:
   - Use glob pattern `fabric/standards/**/*.md` to find all markdown files
   - This includes all subdirectories (global, frontend, backend, infrastructure, and any custom directories the user has created)
   - Read every `.md` file found in the standards directory tree

3. When creating the tasks list, ensure adherence to ALL loaded standards:
   - Tasks follow documented coding principles and patterns
   - Task groupings align with documented architectural boundaries
   - Sub-tasks include necessary standards compliance (e.g., testing requirements)
   - Tasks don't propose approaches that conflict with established conventions

If no standards directory exists, proceed without standards constraints but inform the user:
```
ℹ️ No project standards found at fabric/standards/
   Consider running /shape-standards to establish project conventions.
```

#### 0b. Detect Package Manager

**IMPORTANT**: Detect the project's package manager by checking for lockfiles. Use the detected package manager for ALL tasks involving package installation, script running, or dependency management.

**Detection Order** (first match wins):
1. `bun.lockb` → Use **bun** (`bun install`, `bun run`, `bunx`)
2. `pnpm-lock.yaml` → Use **pnpm** (`pnpm install`, `pnpm run`, `pnpm dlx`)
3. `yarn.lock` → Use **yarn** (`yarn install`, `yarn run`, `yarn dlx`)
4. `package-lock.json` → Use **npm** (`npm install`, `npm run`, `npx`)
5. No lockfile found → Default to **npm** but note in tasks that the user should verify their preferred package manager

**Command Mapping**:
| Action | npm | yarn | pnpm | bun |
|--------|-----|------|------|-----|
| Install deps | `npm install` | `yarn install` | `pnpm install` | `bun install` |
| Add package | `npm install <pkg>` | `yarn add <pkg>` | `pnpm add <pkg>` | `bun add <pkg>` |
| Run script | `npm run <script>` | `yarn <script>` | `pnpm <script>` | `bun run <script>` |
| Execute bin | `npx <cmd>` | `yarn dlx <cmd>` | `pnpm dlx <cmd>` | `bunx <cmd>` |

When creating tasks, **always use the detected package manager commands** instead of hardcoding npm/npx.

