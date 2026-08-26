# MCP CLI Integration

This document describes the integration of `mcp-cli` into Fabric Portal as a runtime tool for AI agents, enabling dynamic MCP server discovery and tool execution.

## Overview

`mcp-cli` is a lightweight CLI for interacting with MCP (Model Context Protocol) servers. It enables dynamic discovery of MCP tools, reducing context window bloat by loading tool schemas on-demand rather than upfront.

**Key Benefits:**
- **~99% token reduction** compared to static MCP tool loading
- **Dynamic discovery** - agents can find tools without pre-configuration
- **On-demand schema loading** - only fetch schemas when needed
- **Shell-friendly** - supports piping and JSON output for scripting

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Fabric Portal                                │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                   Orchestrator                              ││
│  │  ┌─────────────────────────────────────────────────────────┐││
│  │  │  fabric-ai-tools.ts (Virtual Tools)                     │││
│  │  │  - fabric_mcp_list                                      │││
│  │  │  - fabric_mcp_grep                                      │││
│  │  │  - fabric_mcp_schema                                    │││
│  │  │  - fabric_mcp_call                                      │││
│  │  └─────────────────────────────────────────────────────────┘││
│  │                          │                                  ││
│  │                          ▼                                  ││
│  │  ┌─────────────────────────────────────────────────────────┐││
│  │  │  fabric-ai-handler.ts                                   │││
│  │  │  (Handles fabric_mcp_* tool execution)                  │││
│  │  └─────────────────────────────────────────────────────────┘││
│  └─────────────────────────────────────────────────────────────┘│
│                            │                                    │
│                            ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              @repo/fabric-ai Client                         ││
│  │  mcpCliList(), mcpCliGrep(), mcpCliSchema(), mcpCliCall()   ││
│  └─────────────────────────────────────────────────────────────┘│
│                            │                                    │
└────────────────────────────│────────────────────────────────────┘
                             │ HTTP
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Fabric AI Server (Go)                          │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  /mcp-cli/* endpoints                                       ││
│  │  - POST /mcp-cli/list                                       ││
│  │  - POST /mcp-cli/grep                                       ││
│  │  - POST /mcp-cli/schema                                     ││
│  │  - POST /mcp-cli/call                                       ││
│  └─────────────────────────────────────────────────────────────┘│
│                            │                                    │
│                            ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  internal/tools/mcpcli/mcpcli.go                            ││
│  │  (Go wrapper for mcp-cli binary)                                      ││
│  └─────────────────────────────────────────────────────────────┘│
│                            │                                    │
└────────────────────────────│────────────────────────────────────┘
                             │ subprocess
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                  mcp-cli Binary                                 │
│  (Installed via: curl -fsSL .../install.sh | bash)              │
│                            │                                    │
│                            ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              mcp_servers.json                               ││
│  │  (Config file with MCP server definitions)                  ││
│  └─────────────────────────────────────────────────────────────┘│
│                            │                                    │
│                            ▼                                    │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │
│  │ MCP Server 1  │  │ MCP Server 2  │  │ MCP Server N  │       │
│  │  (stdio/HTTP) │  │  (stdio/HTTP) │  │  (stdio/HTTP) │       │
│  └───────────────┘  └───────────────┘  └───────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

### 1. Install mcp-cli Binary

On the Fabric AI server machine:

```bash
# Using the install script
curl -fsSL https://raw.githubusercontent.com/philschmid/mcp-cli/main/install.sh | bash

# Or using bun
bun install -g https://github.com/philschmid/mcp-cli
```

### 2. Configure MCP Servers

Create `mcp_servers.json` in one of these locations:
- Current directory (`./mcp_servers.json`)
- Home directory (`~/.mcp_servers.json`)
- Config directory (`~/.config/mcp/mcp_servers.json`)

Example configuration:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "deepwiki": {
      "url": "https://mcp.deepwiki.com/mcp"
    }
  }
}
```

## Virtual Tools

The following virtual tools are available to AI agents via the orchestrator:

### fabric_mcp_list

List all available MCP servers and their tools.

**Input:**
```json
{
  "withDescriptions": false  // Optional: include tool descriptions
}
```

**Output:**
```
**filesystem**
  - read_file
  - write_file
  - list_directory

**github**
  - search_repositories
  - get_file_contents
```

### fabric_mcp_grep

Search for tools by glob pattern across all servers.

**Input:**
```json
{
  "pattern": "*file*",       // Required: glob pattern
  "withDescriptions": false  // Optional: include descriptions
}
```

**Output:**
```
- filesystem/read_file - Read the contents of a file
- filesystem/write_file - Write content to a file
- github/get_file_contents - Get contents of a file
```

### fabric_mcp_schema

Get the full JSON schema for a specific tool.

**Input:**
```json
{
  "serverTool": "filesystem/read_file"  // Required: server/tool format
}
```

**Output:**
```json
{
  "name": "read_file",
  "server": "filesystem",
  "description": "Read the complete contents of a file as text",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Path to the file to read"
      }
    },
    "required": ["path"]
  }
}
```

### fabric_mcp_call

Execute an MCP tool with arguments.

**Input:**
```json
{
  "serverTool": "filesystem/read_file",  // Required: server/tool format
  "arguments": {
    "path": "./README.md"
  }
}
```

**Output:**
```
# Project README
...file contents...
```

## Agent Workflow

The recommended workflow for agents using MCP CLI tools:

1. **Discover** - Use `fabric_mcp_grep` to find relevant tools
   ```
   fabric_mcp_grep pattern="*search*"
   ```

2. **Inspect** - Use `fabric_mcp_schema` to get parameter details
   ```
   fabric_mcp_schema serverTool="github/search_repositories"
   ```

3. **Execute** - Use `fabric_mcp_call` to run the tool
   ```
   fabric_mcp_call serverTool="github/search_repositories" arguments={"query": "mcp server"}
   ```

## Comparison with Fabric's Existing MCP

| Aspect | Existing Fabric MCP | mcp-cli Integration |
|--------|---------------------|---------------------|
| Discovery | Semantic search via Qdrant | Pattern matching via glob |
| Schema Loading | During routing (upfront) | On-demand via `fabric_mcp_schema` |
| Execution | Native SDK clients | Subprocess via mcp-cli |
| Use Case | Orchestrator's planning phase | Agent runtime tool discovery |
| Token Usage | ~8.7K tokens (optimized) | ~400 tokens (minimal) |

**When to use which:**
- **Orchestrator planning**: Use Fabric's existing semantic search (more intelligent matching)
- **Agent runtime**: Use mcp-cli tools (more flexible, on-demand discovery)

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_CONFIG_PATH` | Path to mcp_servers.json | Auto-detected |
| `MCP_TIMEOUT` | Request timeout in seconds | 30 |
| `MCP_CONCURRENCY` | Max parallel server connections | 5 |
| `MCP_MAX_RETRIES` | Retry attempts for transient errors | 3 |

## Troubleshooting

### mcp-cli not found

Ensure mcp-cli is installed and in PATH:

```bash
which mcp-cli
mcp-cli --version
```

### No servers found

Check that mcp_servers.json exists and is valid:

```bash
mcp-cli  # Should list servers
```

### Connection errors

Check server configuration and ensure required environment variables are set.

## Related Files

- `services/fabric-ai-server/internal/tools/mcpcli/mcpcli.go` - Go wrapper
- `services/fabric-ai-server/internal/server/delegated.go` - HTTP endpoints
- `packages/fabric-ai/client.ts` - TypeScript client methods
- `packages/temporal/src/activities/orchestrator/tools/fabric-ai-tools.ts` - Virtual tool definitions
- `packages/temporal/src/activities/orchestrator/execution/handlers/fabric-ai-handler.ts` - Tool handlers

## References

- [mcp-cli GitHub Repository](https://github.com/philschmid/mcp-cli)
- [MCP CLI Introduction Article](https://www.philschmid.de/mcp-cli)
- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
