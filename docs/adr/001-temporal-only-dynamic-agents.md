# ADR-001: Temporal-Only Dynamic Agents

- **Status**: Accepted
- **Date**: 2025-12-20
- **Deciders**: Engineering team

## Context

Fabric needed a dynamic agent creation system. The question was whether to adopt the Agno framework or build on the existing Temporal infrastructure.

## Decision

Use Temporal-only for dynamic agents. No Agno framework.

## Alternatives Considered

| Capability | Fabric Already Has | Agno Would Add |
|------------|-------------------|----------------|
| Agentic loop | `goalOrientedAgentWorkflow` | Similar loop |
| Dynamic agents | `RegisteredAgent` + `AgentAdapter` | Similar pattern |
| Multi-agent | `orchestratorWorkflow` | Teams (supervisor/router) |
| Agent registry | `AgentRegistry` with health | Not better |
| A2A protocol | Full implementation | None |
| HITL approval | Risk-based system | Basic |
| Multi-tenancy | XOR pattern throughout | None |

## Consequences

- All agent execution runs through Temporal workflows
- Existing infrastructure (`packages/agent-core`, `packages/temporal`) is the foundation
- New agents need connectors, triggers, and UI — not another runtime
- Agent patterns documented in `docs/agent-system.md`
