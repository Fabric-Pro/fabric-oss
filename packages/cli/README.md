# @fabricorg/cli

Use the `fabric` command to work with Fabric projects, coding instructions,
Living Memory, saved agents, workflows and MCP from a terminal.

## Install

Requires Node.js 22 or later.

```sh
npm install --global @fabricorg/cli
# Or
pnpm add --global @fabricorg/cli
```

## Authentication

Run `fabric auth login` for an organization browser sign-in, or add
`--project <id>` for a sign-in scoped to one project. For key-based automation,
set `FABRIC_API_KEY` (for example, `fab_xxx`) or save a key with
`fabric auth login --key <api-key>`. Sign-in data is stored in deployment
profiles in the local CLI config. Run `fabric config path` to locate the file.
Use `--agent-runs` or `--agent-schedules` to request additional grants during
an organization browser sign-in.

REST commands using the shared client prefer `FABRIC_API_KEY`, then a matching
project sign-in when the caller supplies a project, then the deployment's saved
key or organization sign-in. `fabric mcp tools` and `fabric mcp call` require
an environment or saved API key. `fabric mcp serve` uses the SDK's environment
configuration. `fabric mcp header` resolves a project MCP authorization header
for coding tools and prints an empty JSON object when a token is unavailable.

Set `FABRIC_BASE_URL` to select a deployment, such as `https://example.com`.
Where supported, `--base-url` overrides it for the invocation. Without either,
the CLI uses a build-specific origin when present, then the active profile's
URL, then the default Fabric service. For commands using the CLI's default
context, set `FABRIC_ORG=example-org` or run `fabric ctx use org example-org`.
Fabric uses organizations as its only tenant context. The CLI exits with code 2
when a command resolves personal context through the retired `--personal` flag
or `FABRIC_PERSONAL=1` default, and when you run the retired
`fabric ctx use personal` command.

## Commands

Prefix each command with `fabric`. Angle brackets mark required arguments
and square brackets mark optional arguments. Use `--help` on a group or command
for local option details and defaults. **Required** marks options declared
as required by the command registration. The top-level flags are
`-V, --version`, `--format <format>`, `--json`, `--plain`, and `--no-color`.
The default global format is `table` unless `FABRIC_FORMAT` specifies another
format (`json`, `yaml`, `csv`, `plain`, or `quiet`). Color output also honors
`NO_COLOR`. Individual commands can restrict formats or define their own defaults.

### `auth`

| Command | Purpose | Options |
| --- | --- | --- |
| `auth` | Authenticate and manage API keys | — |
| `auth login` | Sign in through your browser, or store an API key with --key | `-k, --key <api-key>`, `--base-url <url>`, `--project <id>`, `--agent-runs`, `--agent-schedules` |
| `auth logout` | Revoke a browser sign-in or remove a stored key. Use the project flag for a project sign-in. | `--project <id>`, `--base-url <url>` |
| `auth whoami` | Show current authentication and identity | `--format <format>`, `--base-url <url>`, `--project <id>` |
| `auth keys` | Manage API keys | — |
| `auth keys list` | List your API keys | `--format <format>` |
| `auth keys create` | Create an API key and display its raw value in the creation response. | `-n, --name <name>` **required**, `-s, --scopes <scopes>`, `-e, --expires <days>`, `--format <format>` |
| `auth keys revoke <id>` | Permanently revoke an API key | — |

### `connect`

| Command | Purpose | Options |
| --- | --- | --- |
| `connect` | Connect a personal AI subscription to Fabric | — |
| `connect chatgpt` | Approve in Fabric, sign in with ChatGPT and run your own Fabric AI work on your plan | `--account <subject-or-email>`, `--new-registration`, `--base-url <url>`, `--org <slug>`, `--shared` |

### `ctx`

| Command | Purpose | Options |
| --- | --- | --- |
| `ctx` | Manage the organization commands run in | — |
| `ctx current` | Show the active default context | — |
| `ctx use` | Set the default organization for commands | — |
| `ctx use org <slug>` | Use an org context by default | — |

### `orgs`

| Command | Purpose | Options |
| --- | --- | --- |
| `orgs` | Manage organizations | — |
| `orgs list` | List organizations you belong to | `--format <format>`, `-q, --quiet` |
| `orgs show <slug>` | Show details for an organization | `--format <format>` |

### `projects`

| Command | Purpose | Options |
| --- | --- | --- |
| `projects` | Manage projects | — |
| `projects list` | List projects | `--org <slug>`, `--status <status>`, `--search <query>`, `--limit <n>`, `--format <format>`, `-q, --quiet` |
| `projects show <id>` | Show project details | `--org <slug>`, `--format <format>` |
| `projects create <name>` | Create a new project | `--org <slug>`, `-d, --description <text>`, `--repo <url>`, `--status <status>`, `--format <format>` |
| `projects update <id>` | Update a project | `--org <slug>`, `--name <name>`, `-d, --description <text>`, `--repo <url>`, `--status <status>`, `--format <format>` |

### `repos`

| Command | Purpose | Options |
| --- | --- | --- |
| `repos` | Manage the project’s code repositories in this agent workspace. | — |
| `repos sync` | Clone project code repositories into `repos/<name>` and leave existing clones in place. | `--project <id>`, `--org <slug>` |

### `features`

| Command | Purpose | Options |
| --- | --- | --- |
| `features` | Manage project features | — |
| `features list` | List features in a project | `-p, --project <id>` **required**, `--org <slug>`, `--priority <priority>`, `--kind <kind>`, `--search <query>`, `--limit <n>`, `--format <format>`, `-q, --quiet` |
| `features show <id>` | Show feature details | `-p, --project <projectId>` **required**, `--org <slug>`, `--format <format>` |
| `features create <title>` | Create a feature in a project | `-p, --project <projectId>` **required**, `--org <slug>`, `-d, --description <text>`, `--priority <priority>`, `--kind <kind>`, `--format <format>` |
| `features tasks` | List tasks (sub-items) for a feature | `-p, --project <projectId>` **required**, `-f, --feature <featureId>` **required**, `--org <slug>`, `--format <format>`, `-q, --quiet` |
| `features update <id>` | Update a feature | `-p, --project <projectId>` **required**, `--org <slug>`, `--title <title>`, `-d, --description <text>`, `--priority <priority>`, `--format <format>` |

### `workflows`

| Command | Purpose | Options |
| --- | --- | --- |
| `workflows` | Manage workflows | — |
| `workflows list` | List workflows | `--org <slug>`, `--status <status>`, `--search <query>`, `--limit <n>`, `--format <format>`, `-q, --quiet` |
| `workflows show <id>` | Show workflow details | `--org <slug>`, `--format <format>` |
| `workflows trigger <id>` | Trigger a workflow execution | `--org <slug>`, `--input <json>`, `--vars <json>` |
| `workflows status <id> <execId>` | Get workflow execution status | `--org <slug>`, `--format <format>` |

### `prompts`

| Command | Purpose | Options |
| --- | --- | --- |
| `prompts` | Manage prompt templates | — |
| `prompts list` | List prompt templates | `--org <slug>`, `--search <query>`, `--category <cat>`, `--limit <n>`, `--format <format>`, `-q, --quiet` |
| `prompts get <id>` | Get a prompt (prints latest version content by default) | `--org <slug>`, `--format <format>` |
| `prompts create` | Create a new prompt | `--org <slug>`, `--key <key>` **required**, `--name <name>` **required**, `-d, --description <text>`, `--content <text>`, `--category <cat>`, `--format <format>` |
| `prompts update <id>` | Update a prompt | `--org <slug>`, `--name <name>`, `-d, --description <text>`, `--category <cat>`, `--format <format>` |

### `agents`

| Command | Purpose | Options |
| --- | --- | --- |
| `agents` | Manage agents | — |
| `agents list` | List agents | `--org <slug>`, `--status <status>`, `--limit <n>`, `--format <format>`, `-q, --quiet` |
| `agents show <id>` | Show agent details | `--org <slug>`, `--format <format>` |
| `agents execute <id>` | Legacy registered agent execution; use invoke-instance for saved agents | `--org <slug>`, `--input <json>`, `--format <format>` |
| `agents invoke-instance <id>` | Run a saved agent instance or recover the same invocation using its request ID | `--org <slug>`, `--input <json>`, `--priority <priority>`, `--idempotency-key <key>`, `--request-id <key>`, `--format <format>` |
| `agents instance-execution <executionId>` | Read one saved agent execution's admission, status and result | `--org <slug>`, `--format <format>` |
| `agents delegate` | Delegate a coding task to Fabric Desktop (fabricagents://) or Remote Fabric Agents Server using subscription harnesses | `--org <slug>`, `--project <id>`, `--project-slug <slug>`, `--target <target>`, `--server-url <url>`, `--harness <harness>`, `--model <model>`, `--fallback <policy>`, `--prompt <text>`, `--durable`, `--format <format>`, `-q, --quiet` |
| `agents desktop` | Generate a 1-click Fabric Desktop (fabricagents://) deep link for a project or view | `--project <id>`, `--project-slug <slug>`, `--view <view>`, `--prompt <text>`, `--format <format>`, `-q, --quiet` |
| `agents subscriptions` | List known Remote Fabric Agents Server harness choices without checking availability | `--server-url <url>`, `--format <format>`, `-q, --quiet` |
| `agents runs` | Inspect saved-agent runs, request cancellation, and manage their one recurring schedule | — |
| `agents runs list <instance-id>` | List this agent owner's recent runs | `--org <slug>`, `--format <format>`, `--limit <number>` |
| `agents runs get <execution-id>` | Read verified status, output and execution evidence | `--org <slug>`, `--format <format>` |
| `agents runs cancel <execution-id>` | Request cancellation at the next safe point. | `--org <slug>`, `--format <format>` |
| `agents runs schedule <instance-id>` | Read the agent's current recurring schedule | `--org <slug>`, `--format <format>` |
| `agents runs schedule-set <instance-id>` | Save recurring work. Requires the agents:schedule and agents:execute key scopes. | `--org <slug>`, `--format <format>`, `--cron <expression>` **required**, `--timezone <IANA>` **required**, `--message <text>` **required**, `--no-enabled` |
| `agents runs search` | Search paginated saved-agent run metadata. | `--org <slug>`, `--format <format>`, `--instance <id>`, `--status <status>`, `--trigger <type>`, `--from <ISO>`, `--to <ISO>`, `--query <text>`, `--cursor <opaque>`, `--limit <number>` |

### `skills`

| Command | Purpose | Options |
| --- | --- | --- |
| `skills` | Browse skill definitions | — |
| `skills list` | List skills | `--org <slug>`, `--search <query>`, `--category <cat>`, `--limit <n>`, `--format <format>`, `-q, --quiet` |
| `skills show <id>` | Show skill details (accepts ID or slug) | `--format <format>` |

### `instructions`

| Command | Purpose | Options |
| --- | --- | --- |
| `instructions` | Keep a checkout current with a project's published coding instructions | — |
| `instructions render` | Build the project's instructions into a coding-tool plugin and print the plugin's folder (for a plugin command source) | `--project <id>` **required**, `--base-url <origin>`, `--org <slug>`, `--set <slug>`, `--target <tool>`, `--out <dir>`, `--dest <dir>`, `--hook` |
| `instructions rules` | Write the project's rules into `.claude/rules/fabric-<id>/` for Claude Code (a plugin cannot carry rules) | `--project <id>` **required**, `--base-url <origin>`, `--org <slug>`, `--set <slug>`, `--dest <dir>`, `--hook` |
| `instructions override` | Manage paths excluded from instruction sync and push. | — |
| `instructions override add <path>` | Keep a path or pattern such as `notes/**` as a local override. | `--dest <dir>`, `--format <format>` |
| `instructions override remove <path>` | Stop keeping a file as a local override; the next sync treats it like any other | `--dest <dir>`, `--format <format>` |
| `instructions override list` | List this checkout's local overrides | `--dest <dir>`, `--format <format>` |
| `instructions check` | Report whether the local copy is behind the published one | `--project <id>`, `--base-url <origin>`, `--remote <name>`, `--dest <dir>`, `--org <slug>`, `--verify`, `--hook`, `--format <format>` |
| `instructions doctor` | Check whether this machine is set up the way the project's coding instructions expect | `--project <id>`, `--base-url <origin>`, `--remote <name>`, `--dest <dir>`, `--org <slug>`, `--probe-network`, `--format <format>` |
| `instructions sync` | Write the published coding instructions into the checkout | `--project <id>`, `--base-url <origin>`, `--remote <name>`, `--dest <dir>`, `--org <slug>`, `--dry-run`, `--repair`, `--include-overrides`, `--no-fast-forward`, `--hook`, `--format <format>` |
| `instructions push` | Propose this checkout's edits to the project's coding instructions, or publish them with --publish | `--project <id>`, `--base-url <origin>`, `--remote <name>`, `--dest <dir>`, `--org <slug>`, `--add <path>`, `--publish`, `--message <text>`, `--no-wait`, `--include-proposed`, `--rebase`, `--dry-run`, `--format <format>` |
| `instructions init` | Set up coding-tool plugins and a memory mirror, or clone the instructions repository. | `--project <id>`, `--base-url <origin>`, `--remote <name>`, `--tool <tool>`, `--clone [folder]`, `--dest <dir>`, `--org <slug>`, `--apply`, `--report-only`, `--lessons`, `--plugin`, `--no-plugin`, `--no-mcp`, `--repos`, `--no-repos`, `--mcp-sign-in`, `--rename`, `--set <slug>`, `--format <format>`, `--verbose` |

### `context`

| Command | Purpose | Options |
| --- | --- | --- |
| `context` | Manage project Context and check recorded-output quality | — |
| `context push <dir...>` | Sync eligible text files by relative path. | `--project <id>` **required**, `--org <slug>`, `--force`, `--prune`, `--dry-run`, `--exclude <pattern>`, `--hook`, `--init`, `--timeout <seconds>`, `--format <format>` |
| `context reset [dir]` | Delete synced Living Memory files for a project or folder. | `--project <id>` **required**, `--org <slug>`, `--folder <path>`, `--yes`, `--format <format>` |
| `context manifest` | Inspect one live page of project context metadata, readiness and read references; no source bodies | `--project <id>` **required**, `--org <slug>`, `--limit <n>`, `--offset <n>`, `--include-code-contexts` |
| `context assemble` | Read selected Project or Workspace sources with citations and revision checks. | `--project <id>` **required**, `--selection-file <path>` **required**, `--org <slug>` |
| `context documents` | Link original Workspace documents to project context without copying or sharing them | — |
| `context documents list` | List authorized linked documents and freshness | `--project <id>` **required**, `--org <slug>`, `--limit <n>`, `--offset <n>` |
| `context documents add <document-id>` | Link a ready original Workspace document. | `--project <id>` **required**, `--org <slug>`, `--workspace <id>` **required**, `--revision <sha256>` **required** |
| `context documents remove <link-id>` | Remove the project link and preserve the original document. | `--project <id>` **required**, `--org <slug>` |
| `context documents read <link-id>` | Read current linked text subject to Project and Workspace access. | `--project <id>` **required**, `--org <slug>`, `--offset <n>`, `--limit <n>`, `--revision <sha256>` |
| `context inspect-run <execution-id>` | Inspect the recorded answer and revision of a completed agent run. | `--project <id>` **required**, `--org <slug>` |
| `context check-run <execution-id>` | Check exact phrases in the recorded answer. | `--project <id>` **required**, `--org <slug>`, `--revision <sha256>` **required**, `--require <phrase>`, `--forbid <phrase>` |
| `context runs` | Create and inspect saved context-quality evaluations | — |
| `context runs capabilities` | Check saved evaluation availability | `--project <id>` **required**, `--org <slug>` |
| `context runs create <file>` | Save and dispatch an evaluation, exporting evidence to the approved connection | `--binding <id>` **required**, `--idempotency-key <key>` **required**, `--name <name>`, `--project <id>` **required**, `--org <slug>` |
| `context runs list` | List saved evaluations | `--cursor <id>`, `--limit <count>`, `--project <id>` **required**, `--org <slug>` |
| `context runs get <runId>` | Read one saved evaluation | `--project <id>` **required**, `--org <slug>` |
| `context runs cancel <runId>` | Request cancellation and inspect the resulting status | `--project <id>` **required**, `--org <slug>` |
| `context runs compare <baselineId> <candidateId>` | Compare two saved evaluation reports | `--project <id>` **required**, `--org <slug>` |
| `context inspect <sourceId>` | Read an authorized context source and its current revision as JSON | `--project <id>` **required**, `--org <slug>` |
| `context evaluate <file>` | Score recorded answers from a JSON file; no live AI or retrieval calls | `--project <id>` **required**, `--org <slug>` |

### `memory`

| Command | Purpose | Options |
| --- | --- | --- |
| `memory` | Mirror a project's Living Memory write folders as plain files, and send changes back | — |
| `memory pull` | Bring the project’s memory folders into this tree while preserving local edits. | `--project <id>`, `--base-url <origin>`, `--dest <dir>`, `--accept-remote <path>`, `--flush`, `--hook`, `--format <format>` |
| `memory push` | Send what changed in the memory folders; Fabric commits it or opens a pull request | `--project <id>`, `--base-url <origin>`, `--dest <dir>`, `--message <text>`, `--hook`, `--format <format>` |
| `memory status` | Settle what was sent, and report pull requests, problems and unsent changes | `--project <id>`, `--base-url <origin>`, `--dest <dir>`, `--clear`, `--format <format>` |

### `mcp`

| Command | Purpose | Options |
| --- | --- | --- |
| `mcp` | Manage MCP servers and configurations | — |
| `mcp servers` | List accessible MCP servers (system + custom) | `--org <slug>`, `--format <format>`, `-q, --quiet` |
| `mcp configs` | Manage MCP configurations | — |
| `mcp configs list` | List your MCP configurations | `--org <slug>`, `--format <format>`, `-q, --quiet` |
| `mcp configs show <id>` | Show a specific MCP configuration | `--org <slug>`, `--format <format>` |
| `mcp configs delete <id>` | Delete an MCP configuration | `--org <slug>`, `-y, --yes` |
| `mcp header` | Print the MCP gateway Authorization header for a project (used by coding tools) | `--project <id>` **required**, `--base-url <origin>` **required** |
| `mcp serve` | Start a stdio MCP server exposing the workspace integration catalog. | — |
| `mcp tools` | List MCP tools exposed by the Fabric MCP Gateway (supports stateless MCP mode) | `--org <slug>`, `--project <id>`, `--mode <mode>`, `--stateless`, `--no-stateless`, `--format <format>`, `-q, --quiet` |
| `mcp call <tool>` | Execute a Fabric MCP tool over Streamable HTTP with optional 24-hour idempotent durable calls | `--org <slug>`, `--project <id>`, `--input <json>`, `--stateless`, `--no-stateless`, `--durable`, `--idempotency-key <key>`, `--format <format>` |
| `mcp apps` | List or inspect built-in MCP Apps (ui://fabric/*) for native rendering in Fabric Desktop | `--uri <uri>`, `--format <format>`, `-q, --quiet` |

### `frames`

| Command | Purpose | Options |
| --- | --- | --- |
| `frames` | Manage AI-generated frames and slideshows | — |
| `frames list` | List frames and slideshows | `--org <slug>`, `--limit <n>`, `--format <format>`, `-q, --quiet` |
| `frames show <id>` | Show frame details | `--org <slug>`, `--format <format>` |

### `workspaces`

| Command | Purpose | Options |
| --- | --- | --- |
| `workspaces` | Manage workspaces | — |
| `workspaces list` | List workspaces | `--org <slug>`, `--search <query>`, `--status <status>`, `--limit <n>`, `--format <format>`, `-q, --quiet` |
| `workspaces show <id>` | Show workspace details | `--org <slug>`, `--format <format>` |
| `workspaces documents <workspaceId>` | List document IDs and extraction status (no AI provider required) | `--org <slug>`, `--offset <n>`, `--limit <n>` |
| `workspaces read-document <workspaceId> <documentId>` | Read one bounded extracted-text page with revision and continuation metadata | `--org <slug>`, `--offset <n>`, `--limit <n>`, `--expected-revision <sha256>` |

### `chats`

| Command | Purpose | Options |
| --- | --- | --- |
| `chats` | Manage AI chat sessions | — |
| `chats list` | List AI chat sessions | `--org <slug>`, `--limit <n>`, `--format <format>`, `-q, --quiet` |
| `chats show <id>` | Show chat details | `--org <slug>`, `--format <format>` |

### `reports`

| Command | Purpose | Options |
| --- | --- | --- |
| `reports` | Manage report templates and executions | — |
| `reports templates` | Manage report templates | — |
| `reports templates list` | List report templates | `--org <slug>`, `--search <query>`, `--category <cat>`, `--limit <n>`, `--format <format>`, `-q, --quiet` |
| `reports templates show <id>` | Show report template details | `--org <slug>`, `--format <format>` |
| `reports executions` | View report executions | — |
| `reports executions list` | List report executions | `--org <slug>`, `--limit <n>`, `--format <format>`, `-q, --quiet` |

### `completion`

| Command | Purpose | Options |
| --- | --- | --- |
| `completion` | Output shell completion script | — |
| `completion bash` | Output bash completion script | — |
| `completion zsh` | Output zsh completion script | — |
| `completion fish` | Output fish completion script | — |

### `config`

| Command | Purpose | Options |
| --- | --- | --- |
| `config` | Show CLI configuration | — |
| `config path` | Print the path to the config file | — |

## Guides

- [Coding Instructions CLI](../../docs/guides/coding-instructions-cli.md)
- [Context Sync CLI](../../docs/guides/context-sync-cli.md)
- [MCP and CLI integration](../../docs/MCP_CLI_INTEGRATION.md)

## License

[MIT](LICENSE).
