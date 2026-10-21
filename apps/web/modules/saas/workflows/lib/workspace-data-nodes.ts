import {
	WORKSPACE_DATA_READ_NODE_TYPE,
	WORKSPACE_DATA_WRITE_NODE_TYPE,
} from "@repo/temporal/workflow-node-types";
import type { ConfigField, NodeTypeDefinition } from "./types";

const recordFields: ConfigField[] = [
	{
		name: "frameId",
		label: "Workspace frame ID",
		type: "text",
		required: true,
		description:
			"Literal ID of your Workspace in this workflow's project. Bind the published workflow version to it before running.",
	},
	{ name: "collection", label: "Collection", type: "text", required: true },
	{
		name: "key",
		label: "Key",
		type: "text",
		required: true,
		description:
			"A record key, @me, or a reference such as {{Selection.key}}.",
	},
	{
		name: "scope",
		label: "Scope",
		type: "select",
		required: true,
		options: [
			{ value: "shared", label: "Shared" },
			{ value: "mine", label: "Workflow owner's private data" },
		],
	},
];

export const WORKSPACE_DATA_NODES: NodeTypeDefinition[] = [
	{
		type: WORKSPACE_DATA_READ_NODE_TYPE,
		label: "Read Workspace Data",
		description: "Read a saved JSON record from an authorized Workspace",
		icon: "Database",
		category: "Developer",
		defaultData: {
			label: "Read Workspace Data",
			config: {
				frameId: "",
				collection: "state",
				key: "baseline",
				scope: "shared",
			},
		},
		execution: {
			stepImportPath: "workspace-data-read",
			stepFunction: "executeWorkspaceDataReadStep",
		},
		configFields: recordFields,
		outputFields: [
			{ field: "value", description: "Saved JSON value, or null" },
			{ field: "version", description: "Current version; 0 when absent" },
			{ field: "found", description: "Whether the record exists" },
		],
	},
	{
		type: WORKSPACE_DATA_WRITE_NODE_TYPE,
		label: "Write Workspace Data",
		description:
			"Save JSON if the Workspace record still has the version you read",
		icon: "Database",
		category: "Developer",
		defaultData: {
			label: "Write Workspace Data",
			config: {
				frameId: "",
				collection: "state",
				key: "baseline",
				scope: "shared",
				value: "{}",
				expectedVersion: 0,
			},
		},
		execution: {
			stepImportPath: "workspace-data-write",
			stepFunction: "executeWorkspaceDataWriteStep",
		},
		configFields: [
			...recordFields,
			{
				name: "value",
				label: "JSON value",
				type: "textarea",
				required: true,
				description:
					"JSON text or a complete object/array reference such as {{Transform.result}}. Invalid JSON and unresolved references fail the step.",
			},
			{
				name: "expectedVersion",
				label: "Expected version",
				type: "text",
				required: true,
				description:
					"Use {{Read Workspace Data.version}}; 0 creates only an absent record. A lost response has an unknown result: read the record before reconciling. Writes do not retry automatically.",
			},
		],
		outputFields: [{ field: "version", description: "New record version" }],
	},
];
