/**
 * A project's reports, as Fabric Agent and the MCP gateway offer them: list
 * them, and generate one.
 *
 * The descriptions say only what a model needs to choose the tool, because
 * many clients resend them every turn. The rest is said where it is needed:
 * who may generate a report in the list's `generateBlockedReason` and the
 * refusal, the AI credits in the approval card (`confirm: "always"` asks on
 * every call), how to follow the run in the result, and what parameters take
 * in the error for invalid ones.
 */
import { defineFabricTools, TOOL_ANNOTATIONS } from "./fabric-tool-definition";

export const FABRIC_REPORT_TOOL_DEFINITIONS = defineFabricTools([
	{
		name: "fabric_list_project_reports",
		description:
			"Lists a project's reports and whether each can be generated.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string", minLength: 1, maxLength: 128 },
				search: { type: "string", maxLength: 200 },
				limit: { type: "number" },
			},
			required: ["projectId"],
		},
		annotations: TOOL_ANNOTATIONS.read,
		scope: "projects:read",
	},
	{
		name: "fabric_generate_report",
		description: "Generates one of the caller's own project reports now.",
		inputSchema: {
			type: "object",
			properties: {
				instanceId: {
					type: "string",
					description: "A report id from fabric_list_project_reports",
					minLength: 1,
					maxLength: 128,
				},
				parameters: { type: "object" },
				idempotencyKey: { type: "string", format: "uuid" },
			},
			required: ["instanceId"],
		},
		annotations: TOOL_ANNOTATIONS.write,
		scope: "workflows:run",
		confirm: "always",
	},
]);

export type FabricReportToolName =
	(typeof FABRIC_REPORT_TOOL_DEFINITIONS)[number]["name"];
