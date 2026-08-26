# CUGA Agent Integration Architecture

## Table of Contents
1. [Overview](#overview)
2. [CUGA Architecture](#cuga-architecture)
3. [Agent Replacement Strategy](#agent-replacement-strategy)
4. [UI Integration Strategy](#ui-integration-strategy)
5. [Implementation Plan](#implementation-plan)

---

## Overview

This document provides the integration architecture for CUGA (Configurable Universal Generalist Agent) into the Fabric platform. CUGA is a state-of-the-art agent framework achieving #1 on AppWorld benchmark and top-tier on WebArena.

---

## CUGA Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          CUGA Agent Architecture                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────┐                                                        │
│  │ Chat Agent  │ ◄── Entry point, handles conversations                 │
│  └──────┬──────┘                                                        │
│         │                                                               │
│         ▼                                                               │
│  ┌──────────────────┐                                                   │
│  │  Task Analyzer   │ ◄── Complexity assessment, app identification     │
│  └────────┬─────────┘                                                   │
│           │                                                             │
│     ┌─────┴─────┐                                                       │
│     │           │                                                       │
│     ▼           ▼                                                       │
│ ┌─────────┐ ┌──────────────────┐                                        │
│ │CugaLite │ │Task Decomposition│ ◄── Subtask planning with deps         │
│ │(fast)   │ └────────┬─────────┘                                        │
│ └────┬────┘          │                                                  │
│      │               ▼                                                  │
│      │    ┌──────────────────┐                                          │
│      │    │ Plan Controller  │ ◄── Central orchestrator                 │
│      │    └────────┬─────────┘                                          │
│      │             │                                                    │
│      │        ┌────┴────┐                                               │
│      │        │         │                                               │
│      │        ▼         ▼                                               │
│      │   ┌─────────┐ ┌──────────────┐                                   │
│      │   │API Sub- │ │Browser Sub-  │                                   │
│      │   │Agent    │ │Agent System  │                                   │
│      │   │System   │ │              │                                   │
│      │   └────┬────┘ └──────┬───────┘                                   │
│      │        │             │                                           │
│      └────────┴─────┬───────┘                                           │
│                     ▼                                                   │
│              ┌──────────────┐                                           │
│              │ Final Answer │                                           │
│              └──────────────┘                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

### CUGA Sub-Agent Details

**API Sub-Agent Pipeline:**
```
API Planner → Shortlister → Code Planner → Code Agent (CodeAct)
     ▲                                          │
     └──────────────── Feedback ────────────────┘
```

**Browser Sub-Agent Pipeline:**
```
Browser Planner → Action Agent → QA Agent
       ▲               │
       └─── Feedback ──┘
```

---

## Agent Replacement Strategy

### Decision Summary

| Fabric Agent | Decision | Rationale |
|--------------|----------|-----------|
| `code_executor` | **KEEP + DEPRECATE** | Keep for simple JS tasks, deprecate in favor of CUGA Code Agent for complex work |
| `browser_agent` | **REPLACE** | Current implementation is skeleton-only; CUGA has full Playwright integration |
| `api_agent` | **KEEP + ENHANCE** | Works for simple single-API calls; route complex multi-API to CUGA |
| `task_planner` | **KEEP** | Basic routing still useful; add CUGA routing option |
| `prompt_enhancer` | **KEEP** | Orthogonal feature, not replaced by CUGA |
| `document_generator` | **KEEP** | Different purpose than CUGA |
| `mcp_tool_executor` | **KEEP** | CUGA can use MCP tools but doesn't replace the executor |

### Detailed Comparison

#### 1. Code Executor (KEEP + DEPRECATE)

**Current Fabric Implementation (`agents/langchain/code-executor/agent.ts`):**
- JavaScript-only sandbox
- Basic reflection with retry (max 3)
- Limited error handling
- ~384 lines of code
- No variables persistence across executions

**CUGA Code Agent (`src/cuga/backend/cuga_graph/nodes/api/code_agent/`):**
- Python sandbox with multiple backends:
  - Local execution
  - Docker/Podman isolation
  - E2B cloud sandbox
- Full CodeAct pattern with sophisticated reflection
- Variables Manager for cross-task state persistence
- Activity tracking and trajectory logging
- Integration with Memory System for learning

**Recommendation:**
- Keep `code_executor` for simple, fast JavaScript tasks
- Mark as deprecated for complex code generation
- Route complex code tasks to CUGA Code Agent

#### 2. Browser Agent (REPLACE)

**Current Fabric Implementation (`agents/langchain/browser-agent/agent.ts`):**
- **Status: Skeleton only** (~247 lines)
- Planning-only (generates action plan, no execution)
- No Playwright integration (planned for Temporal)
- No screenshot/DOM analysis
- No QA verification

**CUGA Browser Agent (`src/cuga/backend/cuga_graph/nodes/browser/`):**
- Full Playwright integration via `BrowserEnvGymAsync`
- Complete action toolkit:
  - `click(bid, button, modifiers)` - Click with element targeting
  - `type(bid, value, press_enter)` - Form input
  - `select_option(bid, options)` - Dropdown selection
  - `go_back()` - Navigation
  - `memorize(information)` - State persistence
  - `human_in_the_loop(message)` - User approval
- Screenshot + DOM dual analysis
- QA Agent for action verification
- Vision support for visual element targeting

**Recommendation:**
- **REPLACE** Fabric's `browser_agent` with CUGA Browser Agent
- Remove existing `browser_agent` route completely
- Route all browser automation to CUGA

#### 3. API Agent (KEEP + ENHANCE)

**Current Fabric Implementation (`agents/langchain/api-agent/agent.ts`):**
- Single tool selection per request
- OpenAPI tool loading from Fabric registry
- Basic LLM-based parameter extraction
- Response formatting
- ~595 lines

**CUGA API Sub-Agent System:**
- **Shortlister**: Ranks and filters from 400+ APIs
- **API Planner**: Multi-step execution planning
- **Code Planner**: Generates execution code
- **Code Agent**: Executes with Variables Manager
- Feedback loops for self-correction

**Recommendation:**
- Keep `api_agent` for simple single-API calls (faster, lower cost)
- Route complex multi-API workflows to CUGA
- Add routing logic to orchestrator

---

## UI Integration Strategy

### Decision: **Option C - API-Only with Enhanced React Components**

After analyzing CUGA's UI structure, the recommended approach is:

1. **Keep CUGA headless** (no Gradio iframe embedding)
2. **Use existing Fabric chat UI** (CopilotKit-based)
3. **Build new React components** inspired by CUGA's patterns for:
   - Execution visualization
   - Variables state display
   - Trajectory/debug view
refer to /agets/langchain/cuga-agent/src/frontend_workspaces/* for frontend components
### Rationale

| Option | Pros | Cons | Recommendation |
|--------|------|------|----------------|
| **A: Port Gradio to React** | Native integration, consistent UX | High effort, maintenance burden | ❌ Too costly |
| **B: Embed Gradio iframe** | Quick integration | Poor UX, auth issues, style mismatch | ❌ Poor experience |
| **C: API-Only + React** | Best UX, maintainable, flexible | Medium effort | ✅ Recommended |
| **D: Separate UI** | Easy CUGA updates | Fragmented experience | ❌ Poor UX |

### CUGA UI Features to Implement in React

#### Priority 1: Core Interaction (Week 4-5)
1. **CUGA Agent Card** in agents list
2. **Execution Mode Selector**: API / Web / Hybrid
3. **Reasoning Mode Selector**: Fast / Balanced / Accurate
4. **Human-in-the-Loop Dialogs**: Approval prompts

#### Priority 2: Execution Visualization (Week 5-6)
1. **Subtask Tree View**: Task decomposition display
2. **Code Execution Panel**: Live code output
3. **Variables Inspector**: Cross-task state view
4. **Streaming Status**: Agent activity indicators

#### Priority 3: Advanced Features (Week 6+)
1. **Browser View** (optional): Screenshot + DOM overlay
2. **Trajectory Viewer**: Execution history/debug
3. **Save & Reuse Panel**: Flow management

### UI Component Structure

```
apps/web/modules/saas/agents/components/
├── cuga/
│   ├── CugaAgentCard.tsx           # Agent selection card
│   ├── CugaConfigPanel.tsx         # Mode/settings panel
│   ├── CugaExecutionView.tsx       # Main execution UI
│   ├── CugaSubtaskTree.tsx         # Task decomposition view
│   ├── CugaCodePanel.tsx           # Code execution display
│   ├── CugaVariablesInspector.tsx  # Variables state view
│   ├── CugaHitlDialog.tsx          # Human-in-the-loop prompts
│   └── CugaTrajectoryViewer.tsx    # Debug/history view (optional)
```

### User Interaction Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Fabric Agents Page                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ Orchestrator │  │ CUGA Agent   │  │ Custom Agent │   ...        │
│  │    Card      │  │    Card      │  │    Card      │              │
│  └──────────────┘  └──────┬───────┘  └──────────────┘              │
│                           │                                         │
│                           ▼                                         │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                  CUGA Config Panel                           │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │   │
│  │  │ Mode:       │  │ Reasoning:  │  │ Features:           │  │   │
│  │  │ ○ API       │  │ ○ Fast      │  │ ☑ HITL             │  │   │
│  │  │ ● Hybrid    │  │ ● Balanced  │  │ ☐ Memory (Milvus)  │  │   │
│  │  │ ○ Web       │  │ ○ Accurate  │  │ ☐ Save & Reuse     │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                   Chat Interface (CopilotKit)                │   │
│  │                                                              │   │
│  │  User: "Find contacts from CRM that match my emails list"   │   │
│  │                                                              │   │
│  │  CUGA: Planning task decomposition...                        │   │
│  │  ┌─────────────────────────────────────────────────────┐    │   │
│  │  │ Subtask Tree:                                        │    │   │
│  │  │ ├─ 1. Read contacts.txt file        [✓ Complete]     │    │   │
│  │  │ ├─ 2. Get CRM contacts via API      [▶ Running]      │    │   │
│  │  │ └─ 3. Compare and filter matches    [○ Pending]      │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  │                                                              │   │
│  │  ┌─────────────────────────────────────────────────────┐    │   │
│  │  │ Variables:                                           │    │   │
│  │  │ • contact_list: ["john@...", "jane@..."] (5 items)   │    │   │
│  │  │ • crm_contacts: [Loading...]                         │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  │                                                              │   │
│  │  ┌─────────────────────────────────────────────────────┐    │   │
│  │  │ Code Execution:                                      │    │   │
│  │  │ ```python                                            │    │   │
│  │  │ contacts = await crm_api.get_contacts()              │    │   │
│  │  │ print(f"Retrieved {len(contacts)} contacts")         │    │   │
│  │  │ ```                                                  │    │   │
│  │  │ Output: Retrieved 127 contacts                       │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  │                                                              │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Backend Deployment (Week 1-2)

**Deliverables:**
- Docker Compose service definition for CUGA
- Aspire AppHost container configuration
- Health check endpoints
- Environment variable configuration

**Port Allocation:**
- `8140`: CUGA main service
- `8141`: CUGA Tool Registry

### Phase 2: AG-UI Wrapper (Week 2-3)

**Deliverables:**
- `agents/langchain/cuga-agent/cuga_fabric_server.py` - AG-UI compatible wrapper
- Streaming event mapping to AG-UI protocol
- Human-in-the-loop support via AG-UI events

### Phase 3: Orchestrator Integration (Week 3-4)

**Deliverables:**
- Add `cuga_generalist` to SpecializedAgent type
- Update routing logic for CUGA-suitable tasks
- A2A communication implementation

### Phase 4: UI Integration (Week 4-5)

**Deliverables:**
- CUGA agent card in UnifiedAgentView
- Configuration panel (modes, features)
- Basic execution visualization

### Phase 5: Enhanced UI (Week 5-6)

**Deliverables:**
- Subtask tree view
- Code execution panel
- Variables inspector
- HITL dialog components

### Phase 6: Browser Agent Replacement (Week 6+)

**Deliverables:**
- Deprecation of skeleton `browser_agent`
- CUGA Browser Agent as primary browser automation
- Optional browser view component

---

## Protocol Translation Architecture

CUGA is integrated into Fabric using a **protocol translation layer** that allows the Orchestrator to communicate with CUGA using the standard A2A protocol, without any CUGA-specific code in the Orchestrator.

### Key Principle: No CUGA-Specific Code in Orchestrator

The Orchestrator treats CUGA **exactly like any other agent**:
- Discovers CUGA via `/.well-known/agent.json` (standard A2A discovery)
- Delegates tasks using `/a2a/send` or `/a2a/send/stream` (standard A2A protocol)
- No special message formatting, no custom endpoints, no CUGA-specific code paths

### Two-Service Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        External Consumers                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────┐           ┌──────────────────────────┐            │
│  │    Orchestrator      │           │   CopilotKit Frontend    │            │
│  │   (Temporal Worker)  │           │   (LangGraphAgent)       │            │
│  └──────────┬───────────┘           └──────────────┬───────────┘            │
│             │                                      │                         │
│             │ A2A Protocol                         │ LangGraph Platform API  │
│             │ /.well-known/agent.json              │ /runs/stream            │
│             │ /a2a/send                            │ /threads/:id/runs/stream│
│             │ /a2a/send/stream                     │                         │
│             └──────────────────┬───────────────────┘                         │
│                                │                                             │
└────────────────────────────────┼─────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CUGA AG-UI Wrapper (Port 8140)                           │
│                    Node.js - Protocol Translation Layer                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    Protocol Endpoints                                │    │
│  │                                                                      │    │
│  │  A2A Protocol:          LangGraph Platform:     CUGA-specific:       │    │
│  │  /.well-known/agent.json  /runs/stream          /cuga/health         │    │
│  │  /a2a/send               /threads/:id/runs/*    /cuga/stop           │    │
│  │  /a2a/send/stream        /assistants/search     /cuga/resume         │    │
│  │  /a2a/tasks/:id          /invoke, /stream                            │    │
│  │  /health                                                             │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                         │
│                                    │ Translation                             │
│                                    ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    Message Translation                               │    │
│  │                                                                      │    │
│  │  Inbound:                           Outbound:                        │    │
│  │  A2A message.parts[].text    →      {"query": "..."}                │    │
│  │  A2A contextId               →      X-Thread-ID header              │    │
│  │                                                                      │    │
│  │  CUGA SSE events             →      A2A TaskEvent format            │    │
│  │  CUGA Answer event           →      A2A completed task              │    │
│  │  CUGA __interrupt__          →      A2A HITL request                │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                         │
└────────────────────────────────────┼─────────────────────────────────────────┘
                                     │
                                     │ HTTP POST /stream
                                     │ {"query": "..."}
                                     │ X-Thread-ID header
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CUGA Python Backend (Port 7860)                          │
│                    FastAPI - Unchanged Native API                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Endpoints:                        Internal Components:                      │
│  POST /stream      →  event_stream()  →  DynamicAgentGraph                  │
│  POST /stop        →  stop_execution()                                      │
│  POST /resume      →  resume_execution()                                    │
│  GET /             →  health_check()                                        │
│                                                                              │
│  SSE Events:                       Agent Nodes:                              │
│  • ChatAgent                       • TaskAnalyzerAgent                       │
│  • TaskDecompositionAgent          • PlanControllerAgent                    │
│  • BrowserPlannerAgent             • ActionAgent                            │
│  • ApiAgent                        • CodeAgent                              │
│  • Answer                          • Stopped                                │
│  • __interrupt__ (HITL)                                                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Message Flow Example

**Orchestrator → CUGA (via A2A)**:
```
1. Orchestrator calls: POST http://cuga-agent:8140/a2a/send
   Body: {
     "message": {
       "role": "user",
       "parts": [{"type": "text", "text": "Check if 17 is prime"}]
     },
     "contextId": "thread-123"
   }

2. AG-UI Wrapper translates to CUGA native format:
   POST http://cuga-backend:7860/stream
   Headers: { "X-Thread-ID": "thread-123" }
   Body: { "query": "Check if 17 is prime" }

3. CUGA Python backend processes and streams SSE events:
   event: TaskAnalyzerAgent
   data: {"analysis": "simple calculation"}

   event: Answer
   data: {"data": "Yes, 17 is prime", "variables": {}}

4. AG-UI Wrapper translates SSE events back to A2A format:
   A2ATask: {
     "id": "task-456",
     "status": "completed",
     "messages": [
       {"role": "user", "parts": [{"type": "text", "text": "Check if 17 is prime"}]},
       {"role": "agent", "parts": [{"type": "text", "text": "Yes, 17 is prime"}]}
     ]
   }
```

### Benefits of This Architecture

1. **Clean Separation of Concerns**: The Orchestrator knows nothing about CUGA's internal API
2. **Standard Protocol Compliance**: All agents (TypeScript, Python, Go) expose the same A2A interface
3. **Independent Evolution**: CUGA's native API can change without affecting Orchestrator
4. **Easy Testing**: Each layer can be tested independently
5. **Reusable Pattern**: Same wrapper pattern can be used for other non-A2A agents

---

## Full System Communication Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Fabric Frontend (CopilotKit)                     │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ LangGraph Platform API
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Orchestrator Agent                              │
│                                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │code_executor│  │ api_agent   │  │task_planner │  │cuga_generalist│
│  │   :8133     │  │   :8131     │  │   :8134     │  │   :8140      │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘ │
└─────────┼────────────────┼────────────────┼────────────────┼────────┘
          │                │                │                │
          │ A2A            │ A2A            │ A2A            │ A2A
          │ (native)       │ (native)       │ (native)       │ (wrapper)
          ▼                ▼                ▼                ▼
┌─────────────────┐ ┌─────────────┐ ┌─────────────┐ ┌──────────────────┐
│ Code Executor   │ │ API Agent   │ │ Task Planner│ │ AG-UI Wrapper    │
│ (TypeScript)    │ │ (TypeScript)│ │ (TypeScript)│ │ (Node.js) :8140  │
│ createUnified-  │ │ createUnified│ │ createUnified│ └────────┬─────────┘
│ Server()        │ │ Server()    │ │ Server()    │          │
└─────────────────┘ └─────────────┘ └─────────────┘          │
                                                              │ Native API
                                                              ▼
                                                    ┌─────────────────┐
                                                    │ CUGA Python     │
                                                    │ Backend :7860   │
                                                    │ (FastAPI)       │
                                                    └─────────────────┘
```

**Note**: TypeScript agents use `createUnifiedServer()` which natively implements both AG-UI and A2A protocols. CUGA (Python) requires an AG-UI wrapper to provide the same interface.

---

## Risk Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Python 3.12 compatibility | Low | High | Docker isolation |
| Large dependency footprint | Medium | Medium | Volume-cached venv, pre-built image |
| Memory system needs Milvus | Medium | Low | Disable by default |
| Browser mode needs Playwright | Medium | Medium | API-only default |
| Performance overhead | Medium | Medium | CugaLite fast path |

---

## Next Steps

1. **Review and approve** this architecture document
2. **Begin Phase 1** - Backend deployment
3. **Parallel UI design** - Create detailed wireframes for CUGA components
4. **Test strategy** - Define E2E tests for CUGA integration