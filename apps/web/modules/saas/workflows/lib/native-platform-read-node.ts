import { NATIVE_PLATFORM_READ_TOOL_NAMES } from "@repo/temporal/native-platform-read-config";
import { NATIVE_PLATFORM_READ_NODE_TYPE } from "@repo/temporal/workflow-node-types";
import type { NodeTypeDefinition } from "./types";

export const NATIVE_PLATFORM_READ_NODE: NodeTypeDefinition = {
	type: NATIVE_PLATFORM_READ_NODE_TYPE,
	label: "Native Platform Read",
	description:
		"Read project data through a registered Fabric tool using your connection",
	icon: "Database",
	category: "Developer",
	defaultData: {
		label: "Native Platform Read",
		config: {
			toolName: "fabric_get_project_pm_connection",
			arguments: "{}",
		},
	},
	execution: {
		stepImportPath: "native-platform-read",
		stepFunction: "executeNativePlatformReadStep",
	},
	configFields: [
		{
			name: "toolName",
			label: "Read-only tool",
			type: "select",
			required: true,
			options: NATIVE_PLATFORM_READ_TOOL_NAMES.map((name) => ({
				value: name,
				label: name,
			})),
			description:
				"Choose a registered native read. The workflow's project and your current access are enforced on every run.",
		},
		{
			name: "arguments",
			label: "Arguments (JSON)",
			type: "textarea",
			required: true,
			description:
				"Use the selected tool's declared schema. Omit projectId; it comes from this workflow. A complete object reference such as {{Prepare.result}} is supported. Credentials and authority fields are refused.",
		},
	],
	outputFields: [
		{
			field: "result",
			description:
				"Tool JSON with its original status, completeness, cursor and truncation indicators. Partial results stay partial. Maximum 128 KiB; use smaller pages before passing to Script Transform's 64 KiB input.",
		},
	],
};
