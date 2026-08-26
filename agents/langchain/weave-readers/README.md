# weave-readers

Tier 1 weave agents with **read-only** sandbox access.

## Agents

### Thread (`/thread`)
Codebase exploration specialist with full sandbox integration.

**Tools:**
- `readFile` - Read files from the sandbox
- `listFiles` - List directory contents
- `searchCode` - Search code using grep
- `execCommand` - Execute read-only commands (grep, find, cat, ls, head, tail)

### Spindle (`/spindle`)
External research specialist.

**Tools:**
- `webSearch` - Search the web
- `fetchDocumentation` - Fetch docs from URLs
- `searchNpm` - Search npm packages
- `searchGitHub` - Search GitHub repos/issues

### Weft (`/weft`)
Quality reviewer (approval-biased).

**Characteristics:**
- Approval-oriented: Looks for reasons to approve
- Only rejects on clear, significant issues
- Provides constructive feedback

### Warp (`/warp`)
Security auditor (security-biased, skeptical).

**Characteristics:**
- Security-focused and skeptical
- Assumes vulnerabilities exist
- Prioritizes by severity

## Usage

All agents accept A2A protocol requests:

```json
POST /thread
{
  "message": {
    "role": "user",
    "parts": [{"text": "Find the auth middleware"}]
  },
  "metadata": {
    "tenantContext": {
      "userId": "user_123",
      "organizationId": "org_456"
    },
    "sandboxSessionId": "session_abc",
    "workDir": "/workspace"
  }
}
```

## Development

```bash
# Install dependencies
pnpm install

# Development mode
pnpm dev

# Production build
pnpm build
pnpm start
```

## Security

- All agents have **read-only** sandbox access
- Shell injection prevention via argument validation
- Commands are allowlisted
- No shell operators (`&&`, `||`, `;`) allowed in arguments
