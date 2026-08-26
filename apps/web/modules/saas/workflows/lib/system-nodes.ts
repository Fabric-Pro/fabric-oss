/**
 * System nodes — the builder actions that are not backed by an integration
 * plugin, so they have nowhere else to be declared.
 *
 * Everything else in the palette is derived from the plugin registry (see
 * `node-definitions.ts`). Keep this list minimal: a node belongs here only if
 * it needs no credentials and no external service.
 *
 * Deliberately NOT here: `browser-*`, `hybrid-step` and `fabric-enrichment`.
 * They have executors but are driven by the hybrid/browser execution paths
 * rather than authored on a canvas, so they are not builder actions. The
 * contract test's NON_ACTION_STEPS records that choice.
 */

import type { NodeTypeDefinition } from "./types";

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
];

/** Node types that are system nodes rather than plugin actions. */
export const SYSTEM_NODE_TYPES: ReadonlySet<string> = new Set(
	SYSTEM_NODES.map((node) => node.type),
);
