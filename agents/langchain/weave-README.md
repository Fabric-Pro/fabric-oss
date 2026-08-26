# Fabric Weave

Multi-agent orchestration system for Fabric, bringing OpenCode Weave's capabilities to the Fabric platform.

## Architecture Overview

Fabric Weave implements a 3-tier architecture with specialized agents working together to execute complex software engineering workflows.

### Tier 1: Read-Only Agents (weave-readers)

**Port: 8125**

Hono-based HTTP services with read-only sandbox access:

- **Thread** (`/thread`): Codebase exploration via sandbox
  - Tools: readFile, listFiles, searchCode, execCommand (read-only)
  - Best for: Understanding existing code, finding patterns

- **Spindle** (`/spindle`): External research
  - Tools: webSearch, fetchDocumentation, searchNpm, searchGitHub
  - Best for: Researching best practices, finding examples

- **Weft** (`/weft`): Quality review (approval-biased)
  - Review Modes: `PLAN` (lenient) and `WORK` (strict)
  - Uses sandbox for code review when available
  - Best for: Code review, quality assessment, plan verification

#### Weft Review Modes

**PLAN Mode** (Lenient):
- Verifies implementation matches approved plan
- Detects stub TODOs and empty implementations
- Checks for scope creep (features not in spec)
- Allows some issues without blocking

**WORK Mode** (Strict):
- Detects fake/incomplete tests (tests without assertions)
- Catches contradictions between tests and implementation
- Requires complete implementations
- Blocks approval for critical/high issues

#### Weft Quality Checks

| Check | PLAN | WORK | Description |
|-------|------|------|-------------|
| Stub Detection | ✓ | ✓ | Finds empty TODO/FIXME/console.log |
| Scope Creep | ✓ | ✓ | Verifies implementation matches spec |
| Fake Tests | ✗ | ✓ | Detects tests without assertions |
| Contradictions | ✗ | ✓ | Catches test/code mismatches |
| Completeness | ✗ | ✓ | Ensures full implementation |

- **Warp** (`/warp`): Security audit (security-biased)
  - 3-step triage system: fast-exit → grep scan → deep review
  - 40+ security patterns across 8 categories (Injection, Auth, Crypto, etc.)
  - RFC citation system with 13 security specs (OAuth, PKCE, JWT, CORS, CSP, etc.)
  - Blocking/non-blocking issue classification (max 3 blocking issues)
  - Project-specific config via `.weave/specs.json`
  - Best for: Security analysis, vulnerability detection, RFC compliance

### Tier 2: Write-Enabled Agent (weave-shuttle)

**Port: 8126**

Isolated service with write access to sandbox:

- **Shuttle** (`/shuttle`): Category-specific implementation
  - Categories: frontend, backend, database, devops
  - Tools: readFile, writeFile, listFiles, searchCode, execCommand
  - SECURITY: Uses dedicated `writeFile()` API (no shell redirection)

### Tier 3: Multi-Node Planner (weave-planners)

**Port: 8127**

LangGraph-based multi-node workflow:

- **Pattern** (`/pattern`): Complex plan creation
  - Workflow: research → analyze → createCheckboxes → savePlan
  - Integrates with Spindle for research phase
  - Saves plans to database with XOR tenant filter

## Orchestration Layer

### Loom (Fabric Loom - Weave Mode)

Temporal workflow that:
1. Assesses request complexity (low/medium/high/complex)
2. Creates plans via Pattern for complex tasks
3. Implements **Model B approval flow** (workflow completes, new workflow on approval)
4. Auto-executes simple tasks if configured

**Task Queue**: `weave`

### Tapestry (Execution Workflow)

Temporal child workflow that:
1. Creates shared sandbox session
2. Iterates over plan checkboxes
3. Delegates to appropriate agents via A2A
4. Handles **Model A checkpoints** with signals
5. Cleans up sandbox on completion

**Signals**:
- `approvalSignal`: Approve/reject checkpoint
- `cancelSignal`: Cancel execution

**Queries**:
- `statusQuery`: Get current execution status

## Database Schema

### New Tables

- `ProjectWeaveConfig`: Project-level weave configuration
- `WeavePlan`: Execution plans created by Pattern
- `WeaveExecution`: Execution tracking

### Extended Tables

- `OrchestratorApproval`: Extended with `weaveExecutionId` and `weavePlanId`
- `Project`, `UserStory`, `StoryTask`: Added weave plan relations

## API Endpoints

All endpoints are available via oRPC under `/api/weave/`:

### Plans
- `POST /weave/plans/create` - Create new plan (triggers Loom)
- `GET /weave/plans/:planId` - Get plan by ID
- `GET /weave/plans?projectId=...` - List plans for project
- `POST /weave/plans/:planId/approve` - Approve/reject plan

### Executions
- `POST /weave/executions/start` - Start plan execution (triggers Tapestry)
- `GET /weave/executions/:executionId` - Get execution status
- `POST /weave/executions/:executionId/signal` - Signal checkpoint approval
- `POST /weave/executions/:executionId/cancel` - Cancel execution

### Configuration
- `GET /weave/config/:projectId` - Get project weave config
- `POST /weave/config/:projectId` - Update project weave config

## Security Model

### Multi-Tenancy (XOR Pattern)

All database queries use XOR tenant filter:
```typescript
where: {
  OR: [
    { userId: context.userId },
    { organizationId: context.organizationId }
  ]
}
```

### Sandbox Isolation

- **Read-only agents**: weave-readers (port 8125)
- **Write-enabled**: weave-shuttle (port 8126) - separate process
- **Shared session**: Single sandbox session per Tapestry execution
- **Shell injection prevention**: Validates commands, no `&&`, `||`, `;`, `|`

## Project-Specific Configuration

Weave agents support project-specific configuration via `.weave/specs.json`:

```json
{
  "customPatterns": ["my-secret-pattern"],
  "disabledPatterns": ["password"],
  "extraSpecs": ["RFC4767"],
  "minSeverity": "medium",
  "categories": {
    "enabled": ["injection", "crypto"],
    "disabled": ["configuration"]
  }
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `customPatterns` | string[] | Additional security patterns to search for |
| `disabledPatterns` | string[] | Patterns to exclude from checks |
| `extraSpecs` | string[] | Additional RFC/spec IDs to cite |
| `minSeverity` | string | Minimum severity level (low, medium, high, critical) |
| `categories.enabled` | string[] | Only run these security categories |
| `categories.disabled` | string[] | Skip these security categories |

### Security Pattern Categories

Warp's 40+ security patterns are organized into 8 categories:

| Category | Patterns | Examples |
|----------|----------|----------|
| Injection | 8 | SQLi, XSS, Command Injection, LDAPi |
| Authentication | 6 | Weak password, Missing MFA, Hardcoded creds |
| Authorization | 5 | IDOR, Privilege escalation, Missing authorization |
| Cryptography | 5 | Weak hash, Hardcoded key, Missing crypto |
| Configuration | 5 | Insecure CORS, Weak CSP, Debug mode |
| Dependencies | 3 | Known CVE, Outdated dep, Malicious package |
| Secrets | 4 | API key in code, Token in URL, Private key exposure |
| Input Validation | 4 | Missing validation, Type confusion, Path traversal |

### RFC Citation System

Warp can cite RFC sections for security findings:

| Spec | ID | Description |
|------|-----|-------------|
| OAuth 2.0 | RFC6749 | Authorization framework |
| PKCE | RFC7636 | OAuth security extension |
| JWT | RFC7519 | JSON Web Token |
| JWK | RFC7517 | JSON Web Key |
| Token Revocation | RFC7009 | Token invalidation |
| OIDC Core | OIDC | Identity layer on OAuth 2.0 |
| WebAuthn | FIDO2 | Passwordless auth |
| TOTP | RFC6238 | Time-based OTP |
| HOTP | RFC4226 | HMAC-based OTP |
| CORS | FETCH | Cross-origin resource sharing |
| CSP Level 3 | CSP3 | Content Security Policy |
| OWASP Top 10 | OWASP2021 | Top web security risks |
| TLS Best Practices | BCP195 | Secure TLS implementation |

## Environment Variables

### Weave Readers (8125)
- `PORT=8125`
- `SANDBOX_API_URL` - Sandbox service URL
- `CORS_ALLOWED_ORIGINS` - Allowed CORS origins

### Weave Shuttle (8126)
- `PORT=8126`
- `SANDBOX_API_URL` - Sandbox service URL
- `CORS_ALLOWED_ORIGINS` - Allowed CORS origins

### Weave Planners (8127)
- `PORT=8127`
- `WEAVE_READERS_URL` - URL to weave-readers service
- `DATABASE_URL` - Database connection string
- `CORS_ALLOWED_ORIGINS` - Allowed CORS origins

### Temporal Workflows
- `TEMPORAL_ADDRESS` - Temporal server address
- `TEMPORAL_NAMESPACE` - Temporal namespace
- `TEMPORAL_API_KEY` - Temporal Cloud API key (optional)

## Running Locally

### Option 1: Docker Compose

```bash
# Start weave services
docker-compose -f agents/langchain/docker-compose.weave.yml up -d

# Start Temporal worker
pnpm --filter @repo/temporal worker
```

### Option 2: Individual Services

```bash
# Terminal 1: weave-readers
pnpm --filter @fabric/weave-readers dev

# Terminal 2: weave-shuttle
pnpm --filter @fabric/weave-shuttle dev

# Terminal 3: weave-planners
pnpm --filter @fabric/weave-planners dev

# Terminal 4: Temporal worker
pnpm --filter @repo/temporal worker
```

## Usage Flow

1. **Create Plan**
   ```typescript
   const { planId } = await api.weave.plans.create({
     projectId: "...",
     message: "Add user authentication feature",
     techStack: "Next.js, Prisma, NextAuth"
   });
   ```

2. **Review Plan**
   ```typescript
   const plan = await api.weave.plans.get({ planId });
   // User reviews checkboxes in UI
   ```

3. **Approve Plan**
   ```typescript
   await api.weave.plans.approve({
     planId,
     approved: true
   });
   ```

4. **Start Execution**
   ```typescript
   const { executionId } = await api.weave.executions.start({
     planId,
     repoUrl: "https://github.com/org/repo",
     targetBranch: "feature/auth"
   });
   ```

5. **Monitor Execution**
   ```typescript
   const execution = await api.weave.executions.get({ executionId });
   // Poll or use WebSocket for real-time updates
   ```

6. **Handle Checkpoints**
   ```typescript
   // When execution hits checkpoint
   await api.weave.executions.signalApproval({
     executionId,
     workflowId,
     runId,
     approved: true,
     feedback: "Looks good!"
   });
   ```

## Development

### Adding New Agents

1. Create agent in appropriate tier
2. Add route to service index.ts
3. Update Tapestry's `delegateToAgent` function
4. Add tests

### Modifying Workflows

1. Edit workflow in `/packages/temporal/src/workflows/weave/`
2. Rebuild worker: `pnpm --filter @repo/temporal build`
3. Restart worker

## Testing

### Unit Tests

```bash
pnpm --filter @fabric/weave-readers test
pnpm --filter @fabric/weave-shuttle test
pnpm --filter @fabric/weave-planners test
```

### Integration Tests

```bash
# Start all services
docker-compose -f agents/langchain/docker-compose.weave.yml up -d

# Run integration tests
pnpm test:weave
```

## Architecture Decisions

1. **XOR Pattern for Tenancy**: Only `userId` + `organizationId`, no `tenantId` field
2. **Separate Shuttle Service**: Security boundary for write access
3. **Shared Sandbox Session**: Created once per Tapestry execution, shared by all agents
4. **Model B for Plan Approval**: Separate workflows (Loom completes, Tapestry starts on approval)
5. **Model A for Checkpoints**: Signals within Tapestry workflow
6. **MCP Config by ID**: Reference config IDs, not tool names (Option B)

## Future Enhancements

- [ ] PartyKit integration for real-time WebSocket updates
- [ ] Eval harness for agent testing
- [ ] UI dashboard for plan/execution management
- [ ] Checkpoint auto-approval for trusted agents
- [ ] Parallel checkbox execution where dependencies allow
