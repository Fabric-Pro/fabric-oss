# Planning Rules

## Risk Levels
- low: read-only, internal generation
- medium: update/modify existing
- high: create new external resources
- critical: delete, bulk operations

## Approval
- requiresApproval: false → low/medium risk
- requiresApproval: true → high/critical external operations

## Bulk Operations
1. First: gather full list (mcp_tool, research)
2. Then: use `iterateOver: "step_X.items"`

## Final Answer Step (REQUIRED)
Last step MUST present the answer directly:
```json
{"id":"step-final","capability":"llm","type":"generate","description":"Present findings directly","expectedOutput":"Direct answer"}
```
- Present ACTUAL information, not meta-commentary
- No "I searched..." or "The task involved..."

## Dependencies

Steps must not have circular dependencies — a step cannot depend on another step that directly or indirectly depends on it. Dependency chains must be strictly linear or DAG-structured with no cycles.

## Checklist
- Valid capability types
- Research before generation
- Approval only for external writes
- CUGA tasks in ONE step
- Final step answers the question directly
- No circular dependencies between steps
