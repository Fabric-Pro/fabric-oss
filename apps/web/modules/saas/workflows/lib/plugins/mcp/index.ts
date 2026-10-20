/**
 * MCP Integration Plugin
 * Uses existing MCP server configurations for tool execution
 *
 * Aligned with Vercel workflow-builder-template patterns
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { AdoStoryReviewConfigFields } from "./AdoStoryReviewConfigFields";
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
			slug: "review-ado-stories",
			label: "Review ADO Stories",
			description:
				"Review assigned stories and summarize changes since the previous completed run",
			category: "AI",
			stepFunction: "executeAdoStoryReviewStep",
			stepImportPath: "mcp-review-ado-stories",
			configComponent: AdoStoryReviewConfigFields,
			configFields: [
				{
					key: "assignee",
					label: "Assigned to: connected account or selected unique name",
					type: "group",
					required: true,
				},
				{
					key: "sprintContext",
					label: "Sprint tasks, parent stories and immediate context (optional)",
					type: "group",
				},
				{
					key: "workItemTypes",
					label: "Work item types",
					type: "textarea",
				},
				{
					key: "requirementFields",
					label: "Requirement field reference names",
					type: "textarea",
				},
				{
					key: "model",
					label: "Review model (optional override)",
					type: "ai-model-selector",
				},
				{
					key: "agentInstructionsInstanceId",
					label: "Agent instructions and model only (optional)",
					type: "text",
				},
				{
					key: "skills",
					label: "Published skills: SKILL.md and selected text files",
					type: "group",
				},
				{
					key: "rubric",
					label: "Review criteria",
					type: "textarea",
					required: true,
				},
				{
					key: "maxStories",
					label: "Maximum stories per run",
					type: "number",
					min: 1,
				},
				{
					key: "workspaceFrameId",
					label: "Parent Workspace ID (optional)",
					type: "text",
				},
			],
			outputFields: [
				{
					field: "html",
					description: "Static, escaped story review report",
				},
				{
					field: "summary",
					description: "Requirement review and daily change summary",
				},
				{
					field: "counts",
					description:
						"Total, reviewed, reused and removed story counts",
				},
				{
					field: "capture",
					description: "Requirement and comment capture metadata",
				},
				{
					field: "forced",
					description:
						"Whether the manual run requested fresh reviews",
				},
			],
			outputConfig: { type: "json", field: "counts" },
		},
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
