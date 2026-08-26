# Agent Memory System

> **Status**: Implemented  
> **Branch**: `feature/agent-memory`  
> **Inspired by**: LangSmith Agent Builder (COALA Framework)

## Overview

The Agent Memory System provides persistent, file-based memory for AI agents in Fabric. Following the COALA (Cognitive Architectures for Language Agents) framework, agents can store and retrieve three types of memory:

| Memory Type | Purpose | Examples |
|-------------|---------|----------|
| **Procedural** | Core instructions and tool configuration | `AGENTS.md`, `mcp.json` |
| **Semantic** | Domain knowledge and specialized skills | `skills/*.md`, `knowledge/*` |
| **Episodic** | Past conversation summaries | `conversations/*.json` (future) |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Memory System                       │
├─────────────────────────────────────────────────────────────┤
│  PostgreSQL VFS (NEW)                                        │
│  ├── AgentMemoryFile table                                   │
│  │   ├── AGENTS.md (procedural instructions)                 │
│  │   ├── mcp.json (tool configuration)                       │
│  │   ├── skills/data-analysis/SKILL.md                       │
│  │   ├── knowledge/company-policies.md                       │
│  │   └── conversations/2024-01-15.json                       │
│  └── AgentMemoryEdit table (HITL approval queue)             │
├─────────────────────────────────────────────────────────────┤
│  Existing Infrastructure                                     │
│  ├── Letta: Short-term memory (tool cache, session state)    │
│  └── Qdrant: Long-term semantic search (execution embeddings)│
└─────────────────────────────────────────────────────────────┘
```

## Database Schema

### AgentMemoryFile

Stores virtual filesystem entries for each agent instance.

```prisma
model AgentMemoryFile {
  id              String   @id @default(cuid())
  path            String   // e.g., "AGENTS.md", "skills/search/SKILL.md"
  fileType        AgentMemoryFileType
  content         String   @db.Text
  version         Int      @default(1)
  metadata        Json?    // Optional structured data
  
  // Tenant isolation (XOR pattern)
  userId          String
  organizationId  String?
  agentInstanceId String?
  
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

enum AgentMemoryFileType {
  AGENTS_MD      // Core agent instructions
  MCP_JSON       // MCP tool configuration
  SKILL          // Specialized skill instructions
  KNOWLEDGE      // Domain knowledge documents
  CONVERSATION   // Conversation summaries
  CUSTOM         // User-defined files
}
```

### AgentMemoryEdit

Tracks pending edits for Human-in-the-Loop (HITL) approval.

```prisma
model AgentMemoryEdit {
  id              String   @id @default(cuid())
  path            String   // Target file path
  operation       AgentMemoryEditOperation
  proposedContent String?  @db.Text
  previousContent String?  @db.Text
  reason          String?  // Why the agent wants this change
  status          AgentMemoryEditStatus @default(PENDING)
  
  // Tenant isolation
  userId          String
  organizationId  String?
  agentInstanceId String?
  
  createdAt       DateTime @default(now())
  reviewedAt      DateTime?
  reviewedBy      String?
}

enum AgentMemoryEditOperation {
  CREATE
  UPDATE
  DELETE
}

enum AgentMemoryEditStatus {
  PENDING
  APPROVED
  REJECTED
}
```

---

## Testing Guide

### Prerequisites

1. **Start the development environment:**
   ```bash
   ./aspire.sh restart
   # OR
   pnpm dev
   ```

2. **Ensure database is synced:**
   ```bash
   cd packages/database
   npx dotenv -c -e ../../.env.local -- npx prisma migrate dev --schema=./prisma/schema.prisma
   pnpm generate
   pnpm apply:rls
   ```

3. **Login to the application** at `http://localhost:3001`

---

### Test Scenario 1: Memory UI in Agent Templates

This tests the frontend Memory Panel for managing agent memory files.

#### Steps:

1. **Navigate to Agent Templates:**
   - Go to `http://localhost:3001/app/agent-templates`
   - Or for organization: `http://localhost:3001/app/{org-slug}/agent-templates`

2. **Open an existing agent instance:**
   - Click on any agent card (e.g., "My Sales Assistant")
   - You'll see the Agent Details page

3. **Access the Memory Panel:**
   - Click the **"Memory"** button in the header (next to "Edit" and "Start Chat")
   - This opens `/app/agent-templates/agents/{instanceId}/memory`

4. **Initialize Memory (if empty):**
   - If this is a new agent, the panel shows "No Memory Files"
   - Click **"Initialize"** button
   - This creates:
     - `AGENTS.md` - Generated from the template's system prompt
     - `mcp.json` - Generated from the template's tool configuration

5. **Browse Memory Files:**
   - The left panel shows a file tree:
     ```
     📁 skills/
     📁 knowledge/
     📁 conversations/
     📄 AGENTS.md
     📄 mcp.json
     ```
   - Click folders to expand/collapse
   - Click files to view content

6. **Edit a Memory File:**
   - Click on `AGENTS.md`
   - The editor shows the file content
   - Make a change (e.g., add a new instruction)
   - Click **"Save"**
   - The "Unsaved" badge disappears

7. **Create a New File:**
   - (Currently requires API - UI for new file creation is a future enhancement)
   - Use the API to create: `skills/my-skill/SKILL.md`

8. **Export Memory:**
   - Click **"Export"** button in the header
   - Downloads `agent-memory-{instanceId}.json` containing all files

9. **View Pending Edits:**
   - Click the **"Pending"** tab
   - Shows edits proposed by the agent (see Scenario 3)
   - Each edit shows:
     - File path
     - Operation (CREATE/UPDATE/DELETE)
     - Reason (why the agent wants this)
     - Proposed content (expandable)
   - Click **"Approve"** to apply the edit
   - Click **"Reject"** to discard it

---

### Test Scenario 2: Memory Loading in Agent Execution

This tests that memory is automatically loaded into the agent's system prompt during execution.

#### What Happens Automatically:

When you start a chat with an agent (via **Fabric Loom**), the `buildExecutionContext` function:

1. Fetches the agent's memory files from the database
2. Builds a system prompt addition containing:
   - `## Agent Memory (Learned Instructions)` - Content of AGENTS.md
   - `## Loaded Skills` - Content of each skill's SKILL.md
   - `## Knowledge Context` - Content of knowledge files
3. Appends this to the agent's base system prompt

#### Steps to Test:

1. **Initialize memory for an agent** (per Scenario 1)

2. **Add custom content to AGENTS.md:**
   ```markdown
   # Agent Instructions
   
   You are a helpful assistant.
   
   ## User Preferences
   - Always respond in bullet points
   - Keep responses under 100 words
   - Use formal language
   ```

3. **Start a chat with the agent:**
   - From Agent Details page, click **"Start Chat"**
   - This opens the Fabric Loom chat interface
   - URL: `/app/agent-templates/agents/{instanceId}/chat`

4. **Send a test message:**
   ```
   "Tell me about machine learning"
   ```

5. **Verify memory is being used:**
   - The response should follow your AGENTS.md preferences (bullet points, concise, formal)
   - Check Temporal worker logs for:
     ```
     [DeploymentExecution] Agent memory loaded {
       instanceId: "...",
       hasAgentsMd: true,
       skillsCount: 0,
       knowledgeCount: 0
     }
     ```

6. **Add a skill and test:**
   - Via API, create `skills/summarization/SKILL.md`:
     ```markdown
     # Summarization Skill
     
     When asked to summarize:
     1. Identify the 3 most important points
     2. Present them as numbered list
     3. Add a one-sentence conclusion
     ```
   - Start a new chat
   - Ask: "Summarize the benefits of cloud computing"
   - The response should follow the skill's format

---

### Test Scenario 3: Agent Memory Tools (Runtime Memory Access)

This tests the agent's ability to read/write its own memory during a conversation.

#### Available Tools:

| Tool | Description |
|------|-------------|
| `memory_list` | List files in agent memory |
| `memory_read` | Read a specific memory file |
| `memory_write` | Propose a memory update (creates pending edit) |
| `memory_search` | Search memory by content |

#### Important: Human-in-the-Loop (HITL)

When an agent uses `memory_write`, it does **NOT** immediately update the file. Instead:
1. Creates a pending edit in `AgentMemoryEdit` table
2. Returns message: "Memory update proposed. Awaiting user approval."
3. User must approve/reject in the Memory UI

#### Steps to Test:

1. **Ensure memory tools are available:**
   - The agent template must have memory tools enabled
   - (Currently, memory tools are added to all agent executions)

2. **Start a chat with an agent** (Fabric Loom)

3. **Ask the agent to remember something:**
   ```
   "Please remember that my preferred programming language is Python"
   ```

4. **Expected agent behavior:**
   - Agent calls `memory_write` tool
   - Tool creates a pending edit to update AGENTS.md
   - Agent responds: "I've noted your preference for Python. This update is pending approval."

5. **Go to Memory > Pending tab:**
   - You should see a new pending edit:
     - Path: `AGENTS.md` (or `knowledge/user-preferences.md`)
     - Operation: `UPDATE`
     - Reason: "User requested to remember their preferred programming language"
     - Proposed content shows the addition

6. **Approve the edit:**
   - Click **"Approve"**
   - The file is updated
   - Future conversations will include this preference

7. **Test memory recall:**
   - Start a new chat
   - Ask: "What's my preferred programming language?"
   - Agent should know it's Python (from AGENTS.md or knowledge file)

---

### Test Scenario 4: Goal-Oriented Agent with Memory

Goal-oriented agents iterate until they achieve a goal. Memory persists across iterations.

#### Steps:

1. **Create a goal-oriented agent instance:**
   - Go to Agent Templates
   - Create a new agent with:
     - Execution Mode: "Goal Oriented"
     - Goal: "Research and summarize the top 3 AI trends"
     - Max Iterations: 10

2. **Initialize and configure memory:**
   - Go to Memory page
   - Initialize memory
   - Add knowledge file `knowledge/research-guidelines.md`:
     ```markdown
     # Research Guidelines
     
     When conducting research:
     - Use only reputable sources (academic, industry leaders)
     - Include publication dates
     - Cite at least 3 sources per trend
     - Focus on practical business applications
     ```

3. **Run the agent:**
   - Click "Start Chat"
   - The agent will:
     1. Read its memory (AGENTS.md, knowledge files)
     2. Execute research steps
     3. Check against goal criteria
     4. Iterate until goal is achieved or max iterations reached

4. **Verify memory usage:**
   - The agent's research should follow the guidelines in memory
   - Check logs for memory loading confirmation

---

### Test Scenario 5: Reporting Agent with Memory

Report templates can use agent instances with configured memory.

#### Steps:

1. **Create a report template** that uses an agent:
   - Go to Reports > Templates
   - Create template with an AI task that uses an agent instance

2. **Configure the agent's memory:**
   - Initialize memory
   - Add `knowledge/report-format.md`:
     ```markdown
     # Report Format
     
     All reports must include:
     1. Executive Summary (max 200 words)
     2. Key Findings (bullet points)
     3. Data Visualizations (describe what charts to include)
     4. Recommendations (numbered list)
     5. Next Steps (action items with owners)
     ```
   - Add `skills/data-analysis/SKILL.md`:
     ```markdown
     # Data Analysis Skill
     
     When analyzing data:
     - Calculate year-over-year growth
     - Identify top 3 trends
     - Flag anomalies (>2 standard deviations)
     - Compare against industry benchmarks
     ```

3. **Generate a report:**
   - Run the report template
   - The agent will use memory context to:
     - Follow the report format
     - Apply data analysis skills
     - Produce consistent output

4. **Verify:**
   - Generated report should match the format in memory
   - Data analysis should follow the skill instructions

---

### Test Scenario 6: API Testing (Postman/cURL)

For direct API testing without the UI.

#### Authentication:

All endpoints require authentication. Get a session cookie by logging in via browser, or use API keys if configured.

#### Endpoints:

**List Files:**
```bash
curl -X POST "http://localhost:3001/api/rpc/agentMemory.files.list" \
  -H "Content-Type: application/json" \
  -H "Cookie: your-session-cookie" \
  -d '{
    "agentInstanceId": "clx123...",
    "organizationId": null
  }'
```

**Read File:**
```bash
curl -X POST "http://localhost:3001/api/rpc/agentMemory.files.read" \
  -H "Content-Type: application/json" \
  -H "Cookie: your-session-cookie" \
  -d '{
    "agentInstanceId": "clx123...",
    "path": "AGENTS.md",
    "organizationId": null
  }'
```

**Write File:**
```bash
curl -X POST "http://localhost:3001/api/rpc/agentMemory.files.write" \
  -H "Content-Type: application/json" \
  -H "Cookie: your-session-cookie" \
  -d '{
    "agentInstanceId": "clx123...",
    "path": "knowledge/test.md",
    "content": "# Test Knowledge\n\nThis is test content.",
    "organizationId": null
  }'
```

**Initialize from Template:**
```bash
curl -X POST "http://localhost:3001/api/rpc/agentMemory.initialize" \
  -H "Content-Type: application/json" \
  -H "Cookie: your-session-cookie" \
  -d '{
    "agentInstanceId": "clx123...",
    "templateId": "clx456...",
    "organizationId": null
  }'
```

**List Pending Edits:**
```bash
curl -X POST "http://localhost:3001/api/rpc/agentMemory.edits.list" \
  -H "Content-Type: application/json" \
  -H "Cookie: your-session-cookie" \
  -d '{
    "agentInstanceId": "clx123...",
    "organizationId": null
  }'
```

**Approve Edit:**
```bash
curl -X POST "http://localhost:3001/api/rpc/agentMemory.edits.approve" \
  -H "Content-Type: application/json" \
  -H "Cookie: your-session-cookie" \
  -d '{
    "editId": "clx789...",
    "organizationId": null
  }'
```

**Export All Memory:**
```bash
curl -X POST "http://localhost:3001/api/rpc/agentMemory.export" \
  -H "Content-Type: application/json" \
  -H "Cookie: your-session-cookie" \
  -d '{
    "agentInstanceId": "clx123...",
    "organizationId": null
  }'
```

---

## Troubleshooting

### "No Memory Files" even after Initialize

**Cause:** Template doesn't have system prompt or tools configured.

**Solution:** 
1. Edit the agent template
2. Add a system prompt
3. Try initializing again

### Memory not loading in agent execution

**Cause:** Instance ID mismatch or tenant isolation issue.

**Check:**
1. Verify `agentInstanceId` matches in memory files
2. Check `userId` and `organizationId` match the session
3. Look for errors in Temporal worker logs

### Pending edits not appearing

**Cause:** Agent might not be using memory tools.

**Check:**
1. Verify memory tools are included in agent execution
2. Check if agent model supports tool calling
3. Look for tool call errors in execution logs

### Migration issues

**If you see "schema drift" errors:**
```bash
# Use migrate dev to sync schema with migration history
cd packages/database
npx dotenv -c -e ../../.env.local -- npx prisma migrate dev --schema=./prisma/schema.prisma

# Generate client
pnpm generate

# Apply RLS policies
pnpm apply:rls
```

---

## Episodic Memory (Conversation Summaries)

Episodic memory automatically summarizes conversations and stores them for future reference. This allows agents to remember past interactions and provide more personalized responses.

### How It Works

1. **Conversation Ends** → `summarizeConversationActivity` extracts:
   - Title (from first user message)
   - Summary (what was discussed)
   - Key topics (coding, data, writing, etc.)
   - User intents (requests, questions, etc.)
   - Agent actions (tools used)
   - Outcome (completed, abandoned, ongoing)

2. **Summary Stored** as `conversations/{date}-{hash}.json`

3. **New Conversation Starts** → `loadRelevantEpisodesActivity`:
   - Loads past conversation summaries
   - Scores relevance to current query
   - Injects top N relevant summaries into context

### Episode Summary Format

```json
{
  "id": "episode-abc123",
  "conversationId": "conv-xyz789",
  "agentInstanceId": "instance-123",
  "title": "Help me debug my Python script",
  "summary": "User requested: \"Help me debug...\". Agent actions: Used code_search. Exchange: 5 user messages, 4 assistant responses. Task completed successfully.",
  "keyTopics": ["coding", "research"],
  "userIntents": ["fix problem", "understand"],
  "agentActions": ["Used code_search", "Used file_read"],
  "toolsUsed": ["code_search", "file_read"],
  "outcome": "completed",
  "messageCount": 9,
  "turnCount": 5,
  "startedAt": "2024-01-15T10:00:00Z",
  "endedAt": "2024-01-15T10:15:00Z",
  "createdAt": "2024-01-15T10:15:00Z"
}
```

### Context Injection

When a new conversation starts, relevant episodes are injected:

```markdown
## Relevant Past Conversations

The user has had the following relevant conversations with you before:

### Jan 14: Help me debug my Python script
- Summary: User requested debugging help. Agent used code_search tool.
- Topics: coding, research
- Tools used: code_search, file_read
- Outcome: completed

Use this context to provide more personalized and consistent responses.
```

### Testing Episodic Memory

1. **Have a conversation with an agent** (via Fabric Loom chat)
2. **End or archive the conversation**
3. **Start a new conversation** with a similar topic
4. **Check logs** for: `[DeploymentExecution] Episodic memory loaded`
5. **Verify** the agent references past interactions appropriately

---

## Future Enhancements

1. **LLM-Powered Summarization** - Use AI to generate better summaries
2. **Semantic Search** - Vector search over episodic memories
3. **Memory Compaction** - Explicit `/remember` command
4. **Memory Templates** - Pre-built memory configurations
5. **Memory Sharing** - Share memory between agent instances
6. **Version History** - Track and rollback memory changes
7. **Memory Analytics** - Usage patterns and effectiveness metrics

---

## Related Files

| File | Purpose |
|------|---------|
| `packages/database/prisma/queries/agent-memory.ts` | Core CRUD operations |
| `packages/api/modules/agent-memory/` | oRPC API procedures |
| `packages/temporal/src/activities/agent-memory/` | Temporal activities and tools |
| `apps/web/modules/saas/agent-templates/components/AgentMemoryPanel.tsx` | Frontend UI |
