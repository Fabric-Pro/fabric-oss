# ADR-002: Vendor-Hosted MCP Servers

- **Status**: Accepted
- **Date**: 2024-12-01
- **Deciders**: Engineering team

## Context

Fabric needed to integrate enterprise tools (Atlassian, Notion, Linear) for agent workflows and document pipelines.

## Decision

Use official vendor-hosted MCP servers instead of building custom integrations.

| Vendor | MCP Server |
|--------|------------|
| Atlassian | `https://mcp.atlassian.com/v1/sse` |
| Notion | `https://mcp.notion.com/mcp` |
| Linear | `https://mcp.linear.app/mcp` |

## Alternatives Considered

- **Custom API integrations**: Higher maintenance burden, requires tracking API changes
- **Self-hosted MCP servers**: Additional infrastructure, no advantage over vendor-hosted

## Consequences

- Zero server maintenance for integrations
- Automatic capability updates from vendors
- OAuth flows managed through existing MCP registry infrastructure
- Rate limits managed by vendor infrastructure
- All MCP integration details in `agents/docs/mcp-integration.md`
