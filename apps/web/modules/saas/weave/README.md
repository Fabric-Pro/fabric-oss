# Weave UI Components

Multi-agent orchestration UI components for Fabric.

## Components

- **ExecuteWithWeaveButton** - Entry point for weave orchestration on Story/Task pages
- **CreatePlanForm** - Form for creating new weave plans with example prompts
- **WeaveExecutionMonitor** - Real-time execution monitoring with agent grid
- **WeavePlanList** - List of plans with approval and execution actions
- **WeaveDashboard** - Summary view of all plans and executions
- **ProjectWeaveConfigSettings** - Configuration page for weave settings

## Usage

### Entry Points (Story/Task Pages)

```tsx
import { ExecuteWithWeaveButton } from "@/modules/saas/weave/components";

// On Story page
<ExecuteWithWeaveButton
  projectId={projectId}
  storyId={storyId}
/>

// On Task page
<ExecuteWithWeaveButton
  projectId={projectId}
  storyId={storyId}
  taskId={taskId}
  size="sm"
/>
```

### Dashboard Page

Route: `/app/projects/[id]/weave`

```tsx
import { WeaveDashboard } from "@/modules/saas/weave/components";

<WeaveDashboard projectId={projectId} />
```

### Settings Page

Route: `/app/projects/[id]/settings/weave`

```tsx
import { ProjectWeaveConfigSettings } from "@/modules/saas/weave/components";

<ProjectWeaveConfigSettings projectId={projectId} />
```

## Features

### Phase 6 UI Status

1. **Entry Points** ✅ - "Execute with Weave" buttons on Story and Task pages
2. **Execution Monitoring** ✅ - Visual grid showing agents (polling-based status updates)
3. **Plan Review/Approval** ✅ - Model B approval flow with approve/reject actions
4. **Checkpoint Review** ✅ - Real checkpoint data from AgentApproval records (approvalId, stepId, agent, reviewType, checkboxText, data, result) with approval/reject UI
5. **Dashboard** ✅ - Overview stats, recent executions, plan status distribution
6. **Configuration** ✅ - Project-level settings for agent behavior, complexity thresholds, and enabled skills

### Security
- ✅ XOR tenant filter on all data access (plans, executions, config)
- ✅ Workflow/Run ID verification before signaling checkpoints
- ✅ Status validation before allowing checkpoint signals

### Known Limitations
- **Real-time streaming**: Currently uses polling (2s when running, 5s otherwise). True WebSocket/SSE streaming planned for future.
- **Log output**: Status-based log messages only. Full agent output streaming planned for future.
