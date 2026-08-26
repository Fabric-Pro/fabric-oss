# CUGA Agent Testing Guide

This guide provides test cases and verification steps for each CUGA capability.

## Prerequisites

1. **Start the services:**
   ```bash
   ./aspire.sh restart
   ```

2. **Verify CUGA is running:**
   ```bash
   curl http://localhost:8140/health
   # Expected: {"status": "healthy"}
   ```

3. **Update system agents (if needed):**
   ```bash
   pnpm --filter @repo/database seed:system-agents
   ```

## Test Cases

### 1. Code Execution (E2B/Docker Sandbox)

**Test Task:**
```
Write a Python function to check if a number is prime and execute it with the number 17.
```

**Expected Behavior:**
- CUGA should be selected as the primary agent (not code_executor)
- The code should be written AND executed in a sandbox
- You should see actual output: `17 is prime: True`

**Verification:**
1. Check the step shows `executor: cuga_generalist`
2. Look for "Code Execution" panel in the UI showing:
   - Code that was executed
   - Actual output from the sandbox
   - Execution status (success/error)

**Log Check:**
```bash
docker logs cuga-agent 2>&1 | grep -i "sandbox\|execute\|code"
```

### 2. Browser Automation (Playwright)

**Test Task:**
```
Go to https://example.com and take a screenshot of the page.
```

**Expected Behavior:**
- CUGA should be selected (not Firecrawl)
- Browser view should show the screenshot
- URL bar should show the navigated URL

**Verification:**
1. Check the step shows `executor: cuga_generalist`
2. Look for "Browser View" panel showing:
   - Screenshot of the page
   - URL bar with current URL
   - Browser action indicators

**Log Check:**
```bash
docker logs cuga-agent 2>&1 | grep -i "browser\|playwright\|screenshot"
```

### 3. Task Decomposition

**Test Task:**
```
Research the top 3 programming languages in 2024, then create a comparison table with their pros and cons.
```

**Expected Behavior:**
- Task should be broken into multiple subtasks
- Subtask tree should show hierarchy
- Each subtask should have status indicators

**Verification:**
1. Look for "Subtask Tree" panel showing:
   - Multiple subtasks with dependencies
   - Status for each (pending/running/complete)
   - Current subtask highlighted

### 4. API Orchestration with Variables

**Test Task:**
```
Fetch the current weather for New York, store it in a variable, then use that to recommend appropriate clothing.
```

**Expected Behavior:**
- Variables should be created and updated
- Variables inspector should show the stored data
- Subsequent steps should reference the variables

**Verification:**
1. Look for "Variables Inspector" panel showing:
   - Variable names and values
   - Variable types
   - Update timestamps

### 5. Human-in-the-Loop (HITL) Approval

**Test Task:**
```
Create a new file called test.txt with the content "Hello World" (this requires approval).
```

**Expected Behavior:**
- HITL dialog should appear before file creation
- User can approve or reject
- Action proceeds only after approval

**Verification:**
1. Look for HITL dialog with:
   - Action description
   - Approve/Reject buttons
   - Risk level indicator

## Troubleshooting

### Code Not Executing

1. **Check E2B API Key:**
   ```bash
   echo $E2B_API_KEY
   ```
   If not set, CUGA falls back to Docker sandbox.

2. **Check Docker sandbox:**
   ```bash
   docker ps | grep sandbox
   ```

3. **Check CUGA logs:**
   ```bash
   docker logs cuga-agent 2>&1 | tail -50
   ```

### Browser Automation Not Working

1. **Check Playwright installation:**
   ```bash
   docker exec cuga-agent playwright --version
   ```

2. **Check browser process:**
   ```bash
   docker exec cuga-agent ps aux | grep chromium
   ```

### Wrong Agent Selected

1. **Check routing decision in logs:**
   ```bash
   docker logs temporal-worker 2>&1 | grep "Routing\|primaryAgent"
   ```

2. **Verify agent descriptions:**
   ```bash
   pnpm --filter @repo/database seed:system-agents
   ```

## Verifying CUGA Native UI

1. Navigate to `/app/agents/cuga-generalist`
2. Click "Try Agent"
3. You should see the CUGA-specific UI with:
   - Chat input at bottom
   - Execution view with subtasks, code, browser panels
   - Variables inspector on the right

If you see the generic CopilotKit chat instead, check:
- The agentId in the URL matches `cuga-generalist` or `cuga_generalist`
- The CugaAuthenticatedChat component is properly imported

## API Endpoints

- **CUGA Health:** `GET http://localhost:8140/health`
- **CUGA AG-UI:** `POST http://localhost:8140/ag-ui`
- **CUGA A2A:** `POST http://localhost:8140/a2a`
- **CUGA Native UI:** `http://localhost:7860` (Gradio interface)

