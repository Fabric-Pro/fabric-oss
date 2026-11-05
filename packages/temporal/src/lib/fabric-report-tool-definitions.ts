/**
 * A project's reports, as Fabric Agent and the MCP gateway offer them: list
 * them, make one from a template or a prompt, generate one, read what one says,
 * and change its instructions, so a person can iterate on a report from a chat.
 *
 * The descriptions say only what a model needs to choose the tool, because
 * many clients resend them every turn. The rest is said where it is needed:
 * who may generate a report in the list's `generateBlockedReason` and the
 * refusal, the AI credits in the approval card (`confirm: "always"` asks on
 * every call), how to follow the run and what to do next in the result, and
 * what parameters take in the error for invalid ones.
 *
 * Creating a report and changing instructions are report-configuration writes
 * under the same `workflows:*` family as generating, which Fabric's agent
 * runtime holds in every chat; `projects:write` reaches them only through a
 * meeting's grant.
 */
import { defineFabricTools, TOOL_ANNOTATIONS } from "./fabric-tool-definition";

/** The longest report instructions an agent may write in one call. */
export const REPORT_PROMPT_MAX_CHARS = 20_000;

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
		name: "fabric_list_report_templates",
		description:
			"Lists the report templates a project's new report can start from.",
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
		name: "fabric_create_project_report",
		description:
			"Creates a project report without running it, from a template or from a prompt.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string", minLength: 1, maxLength: 128 },
				templateId: {
					type: "string",
					description:
						"From fabric_list_report_templates; omitted with a prompt, it is Custom report",
					minLength: 1,
					maxLength: 128,
				},
				prompt: {
					type: "string",
					description: "The report's own instructions",
					minLength: 1,
					maxLength: REPORT_PROMPT_MAX_CHARS,
				},
				name: { type: "string", minLength: 1, maxLength: 255 },
				parameters: { type: "object" },
			},
			required: ["projectId"],
		},
		annotations: TOOL_ANNOTATIONS.write,
		scope: "workflows:write",
		confirm: "always",
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
	{
		name: "fabric_get_report_content",
		description:
			"Reads a report's instructions, effective AI tasks and latest generated text.",
		inputSchema: {
			type: "object",
			properties: {
				instanceId: {
					type: "string",
					description: "A report id from fabric_list_project_reports",
					minLength: 1,
					maxLength: 128,
				},
			},
			required: ["instanceId"],
		},
		annotations: TOOL_ANNOTATIONS.read,
		scope: "projects:read",
	},
	{
		name: "fabric_update_report_prompt",
		description:
			"Replaces the instructions added to each of a report's AI tasks on its next runs.",
		inputSchema: {
			type: "object",
			properties: {
				instanceId: {
					type: "string",
					description: "A report id from fabric_list_project_reports",
					minLength: 1,
					maxLength: 128,
				},
				userPrompt: {
					type: "string",
					minLength: 1,
					maxLength: REPORT_PROMPT_MAX_CHARS,
				},
			},
			required: ["instanceId", "userPrompt"],
		},
		annotations: TOOL_ANNOTATIONS.write,
		scope: "workflows:write",
		confirm: "always",
	},
]);

export type FabricReportToolName =
	(typeof FABRIC_REPORT_TOOL_DEFINITIONS)[number]["name"];
