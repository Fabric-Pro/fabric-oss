# Process for Orchestrating a Spec's Implementation

Now that we have a spec and tasks list ready for implementation, we will proceed with orchestrating implementation of each task group by a dedicated agent using the following MULTI-PHASE process.

Follow each of these phases and their individual workflows IN SEQUENCE:

## Pre-Requisite: Detect Project Configuration

### Detect Package Manager

**IMPORTANT**: Before orchestrating any tasks, detect the project's package manager by checking for lockfiles. Use the detected package manager for ALL implementation prompts and commands.

**Detection Order** (first match wins):
1. `bun.lockb` → Use **bun** (`bun install`, `bun run`, `bunx`)
2. `pnpm-lock.yaml` → Use **pnpm** (`pnpm install`, `pnpm run`, `pnpm dlx`)
3. `yarn.lock` → Use **yarn** (`yarn install`, `yarn run`, `yarn dlx`)
4. `package-lock.json` → Use **npm** (`npm install`, `npm run`, `npx`)
5. No lockfile found → Default to **npm** but note that the user should verify their preferred package manager

**Command Mapping**:
| Action | npm | yarn | pnpm | bun |
|--------|-----|------|------|-----|
| Install deps | `npm install` | `yarn install` | `pnpm install` | `bun install` |
| Add package | `npm install <pkg>` | `yarn add <pkg>` | `pnpm add <pkg>` | `bun add <pkg>` |
| Run script | `npm run <script>` | `yarn <script>` | `pnpm <script>` | `bun run <script>` |
| Execute bin | `npx <cmd>` | `yarn dlx <cmd>` | `pnpm dlx <cmd>` | `bunx <cmd>` |

Store the detected package manager and use it when:
- Generating implementation prompts
- Writing orchestration.yml
- Creating any bash scripts or commands for specialists

