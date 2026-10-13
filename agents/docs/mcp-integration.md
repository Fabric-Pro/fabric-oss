# MCP Integration

Enterprise tool integration via vendor-hosted Model Context Protocol servers.

- **Audience**: Integration/Backend developers
- **Owner**: Integration team

---

## Decision

Use official vendor-hosted MCP servers. No custom integrations.

| Vendor | MCP Server | Transport | Auth |
|--------|------------|-----------|------|
| Atlassian (Jira, Confluence & Bitbucket) | `https://mcp.atlassian.com/v2/mcp?tools=all` | HTTP | OAuth 2.1 + DCR |
| Notion | `https://mcp.notion.com/mcp` | HTTP | OAuth 2.1 + DCR |
| Linear | `https://mcp.linear.app/mcp` | SSE/HTTP | OAuth 2.1 + DCR |

## Architecture

```
fabric-portal
  MCP Server Registry (Database)
    -> MCP Client Factory (createMcpClientForConfig)
      -> Remote MCP Servers (vendor-hosted, HTTPS + OAuth Bearer)

Consumer Systems:
  - Workflow Builder (MCP tool nodes)
  - LangGraph Agents (tool calling)
  - PRD Pipeline (extract from Notion)
  - RAG Pipeline (web content)
```

## Infrastructure Status

All core MCP infrastructure is implemented:

| Component | Location |
|-----------|----------|
| MCP Tool Step | `packages/temporal/src/activities/lib/steps/mcp-tool.ts` |
| MCP Activities | `packages/temporal/src/activities/mcp-activities.ts` |
| MCP Client Factory | `packages/mcp/lib/client.ts` |
| OAuth Flow + DCR | `packages/api/modules/mcp/procedures/oauth.ts` |
| Token Refresh | `packages/api/modules/mcp/procedures/oauth.ts` |
| List Tools API | `packages/api/modules/mcp/procedures/list-tools.ts` |
| MCP Plugin (Workflows) | `apps/web/modules/saas/workflows/lib/plugins/mcp/index.ts` |
| PM Settings UI | `apps/web/modules/saas/projects/components/ProjectManagementSettings.tsx` |

## Vendor Reference

### Atlassian

- **OAuth Discovery**: `https://auth.atlassian.com/.well-known/oauth-authorization-server/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3`
- **Auth**: OAuth 2.1 with Dynamic Client Registration (DCR)
- **Tools**: `searchJiraIssuesUsingJql`, `getJiraIssue`, `createJiraIssue`, `editJiraIssue`, `listJiraProjects`, `searchConfluence`, `getConfluenceContent`, `listConfluenceSpaces`, `listConfluenceContent`, Bitbucket tools (`listBitbucketRepositories`, `listBitbucketRepoPullRequests`, `getBitbucketRepoFileContent`, …)

### Notion

- **Auth**: OAuth 2.1 with Dynamic Client Registration (DCR)
- **Tools**: `search`, `get_page`, `get_database`, `create_page`, `update_page`, `query_database`, `get_block_children`, `append_blocks`, `get_user`

### Linear

- **Auth**: OAuth 2.1 with DCR
- **Tools**: `search_issues`, `get_issue`, `create_issue`, `update_issue`, `list_projects`, `get_project`, `list_teams`, `create_comment`, `get_cycles`

## External References

- [Atlassian Rovo MCP Server](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/)
- [Notion MCP Documentation](https://developers.notion.com/docs/mcp)
- [Linear MCP Documentation](https://linear.app/docs/mcp)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
