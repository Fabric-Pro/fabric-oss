# weave-shuttle

Category-specific implementation agent with **write access**.

## ⚠️ Security Notice

This service has **WRITE ACCESS** to the sandbox filesystem. It is isolated in a separate Docker container from read-only agents (weave-readers) for security.

## Agent

### Shuttle (`/shuttle`)

Category-specific implementation specialist.

**Categories:**
- `frontend` - React, Vue, Angular, CSS
- `backend` - APIs, business logic
- `database` - Schemas, migrations, queries
- `devops` - Infrastructure, deployment

**Tools:**
- `readFile` - Read files
- `writeFile` - **Write files (dedicated API, not shell)**
- `listFiles` - List directories
- `searchCode` - Search code
- `execCommand` - Execute commands

## Security Features

- **Dedicated writeFile API** - Uses sandbox's write endpoint, never shell redirection
- **Shell injection prevention** - Blocks `&&`, `||`, `;`, `|`, `>`, `<`, `$` in arguments
- **Process isolation** - Separate container from read-only agents
- **Command allowlisting** - Only specific commands allowed

## Usage

```json
POST /shuttle
{
  "message": {
    "role": "user", 
    "parts": [{"text": "Create a React component for user login"}]
  },
  "metadata": {
    "tenantContext": {
      "userId": "user_123",
      "organizationId": "org_456"
    },
    "sandboxSessionId": "session_abc",
    "workDir": "/workspace",
    "category": "frontend"
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
