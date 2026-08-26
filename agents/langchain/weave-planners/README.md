# weave-planners

Multi-node LangGraph agents for complex planning workflows.

## Agent

### Pattern (`/pattern`)

Strategic planner that creates detailed execution plans.

**Workflow:**
1. **Research** - Calls Spindle for best practices
2. **Analyze** - Breaks down requirements
3. **Create Checkboxes** - Generates actionable tasks
4. **Save Plan** - Persists to database

**Integration:**
- Calls Spindle (weave-readers) for external research
- Saves plans to WeavePlan table
- Returns plan ID for approval workflow

## Usage

```json
POST /pattern
{
  "message": {
    "role": "user",
    "parts": [{"text": "Implement OAuth2 authentication"}]
  },
  "metadata": {
    "tenantContext": {
      "userId": "user_123",
      "organizationId": "org_456"
    },
    "projectContext": {
      "projectId": "proj_789",
      "projectName": "My App",
      "description": "Web application with auth",
      "techStack": "React, Node.js, PostgreSQL"
    }
  }
}
```

Response:
```json
{
  "planId": "plan_abc",
  "checkboxes": [
    {
      "id": "cb_1",
      "text": "Research OAuth2 best practices",
      "agent": "spindle"
    },
    {
      "id": "cb_2", 
      "text": "Implement auth middleware",
      "agent": "shuttle",
      "category": "backend",
      "requiresReview": true,
      "reviewType": "warp"
    }
  ]
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
