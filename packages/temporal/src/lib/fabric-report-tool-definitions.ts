/** One report operation catalogue shared by Genie and MCP. Native Temporal owns executions. */
import { defineFabricTools, TOOL_ANNOTATIONS } from "./fabric-tool-definition";

const identity = (key: string) => ({
	type: "object",
	properties: { [key]: { type: "string", minLength: 1 } },
	required: [key],
	additionalProperties: false,
});
const settings = {
	type: "object",
	description:
		"Report settings. Creation: templateId, name, connections; optional reporting (version:1, period, projectId, branding, generatePdf), schedule. Configuration also requires expectedVersion and expectedUpdatedAt from fabric_get_report.",
};
export const FABRIC_REPORT_TOOL_DEFINITIONS = defineFabricTools([
	{
		name: "fabric_list_reports",
		description:
			"Find configured reports you can currently access. Search by project or name; page with limit and offset.",
		scope: "reports:read",
		annotations: TOOL_ANNOTATIONS.read,
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				search: { type: "string" },
				limit: { type: "integer", minimum: 1, maximum: 100 },
				offset: { type: "integer", minimum: 0 },
			},
		},
	},
	{
		name: "fabric_create_report",
		description:
			"Create a configured report from an accessible template. Choose its project audience, evidence period, reviewed brand, optional PDF and schedule. Does not execute or distribute it.",
		scope: "reports:write",
		annotations: TOOL_ANNOTATIONS.write,
		confirm: "always",
		inputSchema: {
			type: "object",
			properties: { settings },
			required: ["settings"],
			additionalProperties: false,
		},
	},
	{
		name: "fabric_get_report",
		description:
			"Read report configuration, current revision, schedule and recent executions before changing or running it.",
		scope: "reports:read",
		annotations: TOOL_ANNOTATIONS.read,
		inputSchema: identity("reportId"),
	},
	{
		name: "fabric_configure_report",
		description:
			"Save reviewed report settings and schedule controls. Requires the current expectedVersion and expectedUpdatedAt; project audience cannot change. Does not execute or distribute.",
		scope: "reports:write",
		annotations: TOOL_ANNOTATIONS.idempotentWrite,
		confirm: "always",
		inputSchema: {
			type: "object",
			properties: { reportId: { type: "string" }, settings },
			required: ["reportId", "settings"],
			additionalProperties: false,
		},
	},
	{
		name: "fabric_execute_report",
		description:
			"Run a saved report durably with its admitted sources, branding and period. Reuse the same UUID idempotencyKey after an uncertain response. Poll fabric_get_report_execution. Does not distribute output.",
		scope: "reports:write",
		annotations: TOOL_ANNOTATIONS.idempotentWrite,
		confirm: "always",
		inputSchema: {
			type: "object",
			properties: {
				reportId: { type: "string" },
				idempotencyKey: { type: "string", format: "uuid" },
				parameters: { type: "object" },
			},
			required: ["reportId", "idempotencyKey"],
			additionalProperties: false,
		},
	},
	{
		name: "fabric_get_report_execution",
		description:
			"Read the current status and authorized artifact references of one report run. Cancelled runs expose no partial artifacts.",
		scope: "reports:read",
		annotations: TOOL_ANNOTATIONS.read,
		inputSchema: identity("executionId"),
	},
	{
		name: "fabric_cancel_report_execution",
		description:
			"Cancel your active report run, or one you currently administer. Durable cancellation hides partial outputs before terminating work.",
		scope: "reports:write",
		annotations: TOOL_ANNOTATIONS.idempotentWrite,
		confirm: "always",
		inputSchema: identity("executionId"),
	},
	{
		name: "fabric_download_report_artifact",
		description:
			"Get an authorized download descriptor for an exact saved report artifact, including generated PDF. A URL is short-lived; inline output is text. Never invent a file link.",
		scope: "reports:read",
		annotations: TOOL_ANNOTATIONS.read,
		inputSchema: identity("artifactId"),
	},
	{
		name: "fabric_distribute_report_artifact",
		description:
			"Explicitly share an exact completed report artifact to reviewed members' Fabric inboxes. Every recipient must currently access its project evidence. Reuse requestId after an uncertain result. Sends no external email.",
		scope: "reports:write",
		annotations: TOOL_ANNOTATIONS.idempotentWrite,
		confirm: "always",
		inputSchema: {
			type: "object",
			properties: {
				artifactId: { type: "string" },
				recipientUserIds: {
					type: "array",
					minItems: 1,
					maxItems: 50,
					items: { type: "string" },
				},
				requestId: { type: "string", format: "uuid" },
				expectedArtifactHash: {
					type: "string",
					pattern: "^[a-f0-9]{64}$",
				},
				message: { type: "string", maxLength: 1000 },
			},
			required: [
				"artifactId",
				"recipientUserIds",
				"requestId",
				"expectedArtifactHash",
			],
			additionalProperties: false,
		},
	},
	{
		name: "fabric_get_report_deliveries",
		description:
			"Read authorized delivery history for one exact report artifact.",
		scope: "reports:read",
		annotations: TOOL_ANNOTATIONS.read,
		inputSchema: identity("artifactId"),
	},
	{
		name: "fabric_list_report_executions",
		description:
			"Page through native runs of one report, including older runs beyond its recent history. Current and admitted project access is rechecked. Reuse nextCursor only with unchanged report and status filters.",
		scope: "reports:read",
		annotations: TOOL_ANNOTATIONS.read,
		inputSchema: {
			type: "object",
			properties: {
				reportId: { type: "string" },
				cursor: { type: "string", maxLength: 2048 },
				limit: { type: "integer", minimum: 1, maximum: 50 },
				status: {
					type: "string",
					enum: [
						"PENDING",
						"RUNNING",
						"COMPLETED",
						"FAILED",
						"CANCELLED",
					],
				},
			},
			required: ["reportId"],
			additionalProperties: false,
		},
	},
	{
		name: "fabric_list_report_artifacts",
		description:
			"Page through exact saved artifact references for one native report run. Cancelled runs return no artifacts; bytes require a separate authorized download.",
		scope: "reports:read",
		annotations: TOOL_ANNOTATIONS.read,
		inputSchema: {
			type: "object",
			properties: {
				executionId: { type: "string" },
				cursor: { type: "string", maxLength: 2048 },
				limit: { type: "integer", minimum: 1, maximum: 50 },
				artifactType: {
					type: "string",
					enum: [
						"MARKDOWN",
						"PDF",
						"HTML",
						"EVIDENCE_EMBED",
						"CHART_DATA",
						"CSV",
						"JSON",
					],
				},
			},
			required: ["executionId"],
			additionalProperties: false,
		},
	},
]);
