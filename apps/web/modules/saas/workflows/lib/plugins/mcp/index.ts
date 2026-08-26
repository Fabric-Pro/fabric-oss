/**
 * MCP Integration Plugin
 * Uses existing MCP server configurations for tool execution
 *
 * Aligned with Vercel workflow-builder-template patterns
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { McpIcon } from "./icon";

export const mcpPlugin: IntegrationPlugin = {
	type: "MCP",
	category: "tool",
	label: "MCP Tools",
	description: "Execute tools from MCP servers",
	icon: McpIcon,
	color: "text-gray-600",
	brandColor: "#4B5563",

	// MCP uses existing MCP server configs, no separate credentials needed
	formFields: [],

	// MCP connection testing is handled server-side via the API; servers are
	// configured in Settings → MCP Servers, and each carries its own
	// credentials, so there is nothing on this plugin to test.
	testConfig: { skipClientTest: true },

	actions: [
		{
			slug: "execute-tool",
			// Pinned: predates the <type>-<slug> convention. Renaming it
			// would orphan every saved workflow using this node.
			nodeType: "mcp-tool",
			label: "MCP Tool",
			description: "Execute a tool from an MCP server",
			category: "Developer",
			stepFunction: "executeMcpToolStep",
			stepImportPath: "mcp-tool",
			outputFields: [
				{ field: "result", description: "Tool execution result" },
			],
			outputConfig: { type: "json", field: "result" },
			configFields: [
				{
					key: "mcpServers",
					label: "MCP Servers",
					type: "mcp-selector",
					required: true,
					placeholder: "Select MCP servers",
				},
				{
					key: "toolName",
					label: "Tool Name",
					type: "mcp-tool-selector",
					required: true,
					placeholder: "Select a tool...",
				},
				{
					key: "toolArgs",
					label: "Tool Arguments",
					type: "template-textarea",
					placeholder:
						'{{Generate Text.text}} or {"query": "...", "limit": 10}',
					description:
						"Simple text will auto-wrap as {query: ...}. Or provide full JSON.",
					rows: 4,
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(mcpPlugin);
