/**
 * System nodes — the builder actions that are not backed by an integration
 * plugin, so they have nowhere else to be declared.
 *
 * Everything else in the palette is derived from the plugin registry (see
 * `node-definitions.ts`). Keep this list for Fabric-owned actions; native
 * reads use registered platform tools and their existing connection checks.
 *
 * Deliberately NOT here: `browser-*`, `hybrid-step` and `fabric-enrichment`.
 * They have executors but are driven by the hybrid/browser execution paths
 * rather than authored on a canvas, so they are not builder actions. The
 * contract test's NON_ACTION_STEPS records that choice.
 */

import {
	AGENT_TASK_MAX_ITERATIONS,
	AGENT_TASK_NODE_LABEL,
	AGENT_TASK_NODE_TYPE,
	PUBLISH_FRAME_NODE_LABEL,
	PUBLISH_FRAME_NODE_TYPE,
} from "@repo/temporal/agentic-workflow-preset";
import { SCRIPT_TRANSFORM_NODE_TYPE } from "@repo/temporal/workflow-node-types";
import { NATIVE_PLATFORM_READ_NODE } from "./native-platform-read-node";
import { listTimeZoneOptions } from "./time-zones";
import type { NodeTypeDefinition } from "./types";
import { WORKSPACE_DATA_NODES } from "./workspace-data-nodes";

const SCRIPT_TRANSFORM_NODE: NodeTypeDefinition = {
	type: SCRIPT_TRANSFORM_NODE_TYPE,
	label: "Script Transform",
	description:
		"Transform JSON with your own JavaScript or TypeScript in an isolated runtime",
	icon: "Wrench",
	category: "Developer",
	defaultData: {
		label: "Script Transform",
		config: {
			code: "return { ...inputs };",
			language: "javascript",
			timeout: 5000,
		},
	},
	execution: {
		stepImportPath: "script-transform",
		stepFunction: "executeScriptTransformStep",
	},
	configFields: [
		{
			name: "code",
			label: "Code (async function body)",
			type: "textarea",
			required: true,
			description:
				"Read previous outputs through inputs['$nodeId'] or inputs['Node label'] and return JSON. Data is passed separately: do not interpolate it into code. No network, credentials, packages or persistence. Publish the complete graph before running scripts.",
		},
		{
			name: "language",
			label: "Language",
			type: "select",
			required: true,
			options: [
				{ value: "javascript", label: "JavaScript" },
				{ value: "typescript", label: "TypeScript" },
			],
		},
		{
			name: "inputKeys",
			label: "Input keys (optional JSON array)",
			type: "textarea",
			placeholder: '["$source", "$previous"]',
			description:
				"Select existing top-level input names to avoid passing duplicate aliases. Leave blank to pass all inputs. Selected JSON must fit within 64 KiB.",
		},
		{
			name: "timeout",
			label: "Response deadline (milliseconds, 1000–10000)",
			type: "number",
			required: true,
		},
	],
	outputFields: [
		{ field: "result", description: "Returned JSON value" },
		{
			field: "logs",
			description: "Captured stdout and stderr, up to 16 KiB",
		},
	],
};

export const SYSTEM_NODES: NodeTypeDefinition[] = [
	{
		type: "trigger",
		label: "Trigger",
		description: "Start point for the workflow",
		icon: "Play",
		category: "Core",
		defaultData: {
			label: "Trigger",
			config: {
				triggerType: "manual",
			},
		},
		configFields: [
			{
				name: "triggerType",
				label: "Trigger Type",
				type: "select",
				required: true,
				options: [
					{ value: "manual", label: "Manual" },
					{ value: "schedule", label: "Schedule" },
					{ value: "webhook", label: "Webhook" },
				],
			},
			{
				// Read on publish to create the Temporal Schedule. Before this
				// field existed, choosing "Schedule" above had nowhere to put
				// a cron and so did nothing at all.
				name: "scheduleCron",
				label: "Schedule (cron)",
				type: "text",
				placeholder: "0 9 * * 1-5",
				defaultValue: "0 9 * * *",
			},
			{
				// The zone the cron is read in. Left empty it is UTC, which is
				// how every schedule saved before this field existed runs.
				name: "scheduleTimezone",
				label: "Schedule time zone",
				type: "select",
				placeholder: "UTC",
				options: listTimeZoneOptions(),
			},
		],
	},
	{
		type: "http-request",
		label: "HTTP Request",
		description: "Make HTTP requests to external APIs",
		icon: "Send",
		category: "Core",
		defaultData: {
			label: "HTTP Request",
			config: {
				method: "GET",
			},
		},
		configFields: [
			{
				name: "method",
				label: "Method",
				type: "select",
				required: true,
				options: [
					{ value: "GET", label: "GET" },
					{ value: "POST", label: "POST" },
					{ value: "PUT", label: "PUT" },
					{ value: "PATCH", label: "PATCH" },
					{ value: "DELETE", label: "DELETE" },
				],
			},
			{
				name: "url",
				label: "URL",
				type: "text",
				required: true,
				placeholder: "https://api.example.com/endpoint",
			},
		],
	},
	{
		type: "condition",
		label: "Condition",
		description: "Branch workflow based on conditions",
		icon: "GitBranch",
		category: "Core",
		defaultData: {
			label: "Condition",
			config: {},
		},
		configFields: [
			{
				name: "expression",
				label: "Expression",
				type: "text",
				required: true,
				placeholder: "{{input.value}} === 'expected'",
			},
		],
	},
	{
		type: AGENT_TASK_NODE_TYPE,
		label: AGENT_TASK_NODE_LABEL,
		description:
			"Run an AI agent with your MCP servers and write up the result",
		icon: "Sparkles",
		category: "AI",
		defaultData: {
			label: AGENT_TASK_NODE_LABEL,
			config: {
				mcpConfigIds: [],
				builtInToolNames: [],
				maxIterations: AGENT_TASK_MAX_ITERATIONS,
				outputFormat: "html",
			},
		},
		configFields: [
			{
				name: "prompt",
				label: "Task",
				type: "textarea",
				required: true,
				placeholder:
					"Read this week's work items and write a one-page status report.",
			},
			{
				name: "systemPrompt",
				label: "Instructions (optional)",
				type: "textarea",
				placeholder:
					"How the agent should behave and what to leave out.",
			},
			{
				name: "modelId",
				label: "Model (optional)",
				type: "ai-model-selector",
				placeholder: "Use the configured default",
			},
			{
				name: "mcpConfigIds",
				label: "MCP servers",
				type: "mcp-selector",
				placeholder: "Select MCP servers",
			},
			{
				name: "builtInToolNames",
				label: "Fabric data and tools the agent may use",
				type: "capability-selector",
			},
			{
				name: "maxIterations",
				label: `Most steps the agent may take (up to ${AGENT_TASK_MAX_ITERATIONS})`,
				type: "number",
			},
			{
				name: "outputFormat",
				label: "Result",
				type: "select",
				required: true,
				options: [
					{ value: "html", label: "A web page (HTML)" },
					{ value: "markdown", label: "A document (Markdown)" },
				],
			},
		],
	},
	{
		type: PUBLISH_FRAME_NODE_TYPE,
		label: PUBLISH_FRAME_NODE_LABEL,
		description:
			"Save a result as a frame on the project's Artifacts tab, versioned on every run",
		icon: "FileText",
		category: "AI",
		defaultData: {
			label: PUBLISH_FRAME_NODE_LABEL,
			config: {
				content: `{{${AGENT_TASK_NODE_LABEL}.html}}`,
				format: "html",
				surface: "artifact",
				mode: "new-version",
			},
		},
		configFields: [
			{
				name: "title",
				label: "Title",
				type: "text",
				required: true,
				placeholder: "Weekly status",
			},
			{
				name: "description",
				label: "Description (optional)",
				type: "textarea",
			},
			{
				name: "content",
				label: "Content",
				type: "textarea",
				required: true,
				placeholder: `{{${AGENT_TASK_NODE_LABEL}.html}}`,
			},
			{
				name: "format",
				label: "Content format",
				type: "select",
				required: true,
				options: [
					{ value: "html", label: "HTML" },
					{ value: "markdown", label: "Markdown" },
				],
			},
			{
				name: "surface",
				label: "Where it appears",
				type: "select",
				required: true,
				options: [
					{ value: "artifact", label: "Project artifact" },
					{ value: "workspace", label: "Workspace" },
				],
			},
			{
				name: "mode",
				label: "On every run",
				type: "select",
				required: true,
				options: [
					{
						value: "new-version",
						label: "Add a version to the same frame",
					},
					{ value: "new-frame", label: "Create a new frame" },
				],
			},
		],
	},
	SCRIPT_TRANSFORM_NODE,
	...WORKSPACE_DATA_NODES,
	NATIVE_PLATFORM_READ_NODE,
];

/** Node types that are system nodes rather than plugin actions. */
export const SYSTEM_NODE_TYPES: ReadonlySet<string> = new Set(
	SYSTEM_NODES.map((node) => node.type),
);
