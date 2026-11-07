import type { FabricToolDefinition } from "./fabric-tool-definition";

const id = { type: "string", minLength: 1, maxLength: 200 } as const;
const requestId = { type: "string", format: "uuid" } as const;
/** Private-source tools are served only to explicitly scoped human/external clients. */
export const FABRIC_DELIVERY_SOURCE_TOOL_DEFINITIONS = [
	{
		name: "fabric_delivery_source_list",
		description:
			"List only your private source watches and eligible connections. Actor/current project/source-owner access is checked on every call. Not available to Pages or native/service runtimes.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { projectId: id },
			required: ["projectId"],
		},
		scope: "projects:read",
		annotations: { readOnlyHint: true, idempotentHint: true },
	},
	{
		name: "fabric_delivery_source_inspect",
		description:
			"Test your own Slack channel access without writing configuration or messages. Actor/current project/source-owner access is checked on every call. Not available to Pages or native/service runtimes.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { projectId: id, integrationId: id, channelId: id },
			required: ["projectId", "integrationId", "channelId"],
		},
		scope: "projects:read",
		annotations: { readOnlyHint: true, idempotentHint: true },
	},
	{
		name: "fabric_delivery_source_configure",
		description:
			"Connect a private Slack root-message capture watch after inspection. Actor/current project/source-owner access is checked on every call. Not available to Pages or native/service runtimes.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				projectId: id,
				integrationId: id,
				channelId: id,
				requestId: requestId,
				retentionDays: { type: "integer", enum: [7, 30], default: 7 },
			},
			required: ["projectId", "integrationId", "channelId", "requestId"],
		},
		scope: "projects:write",
		annotations: { readOnlyHint: false, idempotentHint: true },
		confirm: "always",
	},
	{
		name: "fabric_delivery_source_pause",
		description:
			"Pause your private source watch. Actor/current project/source-owner access is checked on every call. Not available to Pages or native/service runtimes.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				projectId: id,
				watchId: id,
				requestId: requestId,
				expectedVersion: { type: "integer", minimum: 1 },
			},
			required: ["projectId", "watchId", "requestId", "expectedVersion"],
		},
		scope: "projects:write",
		annotations: { readOnlyHint: false, idempotentHint: true },
		confirm: "always",
	},
	{
		name: "fabric_delivery_source_resume",
		description:
			"Resume your private source watch after a fresh source-access check. Actor/current project/source-owner access is checked on every call. Not available to Pages or native/service runtimes.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				projectId: id,
				watchId: id,
				requestId: requestId,
				expectedVersion: { type: "integer", minimum: 1 },
			},
			required: ["projectId", "watchId", "requestId", "expectedVersion"],
		},
		scope: "projects:write",
		annotations: { readOnlyHint: false, idempotentHint: true },
		confirm: "always",
	},
	{
		name: "fabric_delivery_source_disconnect",
		description:
			"Disconnect your private source watch. Actor/current project/source-owner access is checked on every call. Not available to Pages or native/service runtimes.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				projectId: id,
				watchId: id,
				requestId: requestId,
				expectedVersion: { type: "integer", minimum: 1 },
			},
			required: ["projectId", "watchId", "requestId", "expectedVersion"],
		},
		scope: "projects:write",
		annotations: { readOnlyHint: false, idempotentHint: true },
		confirm: "always",
	},
	{
		name: "fabric_delivery_source_capture",
		description:
			"Start a bounded durable capture; reuse requestId for safe retry. Actor/current project/source-owner access is checked on every call. Not available to Pages or native/service runtimes.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				projectId: id,
				watchId: id,
				requestId: requestId,
				expectedVersion: { type: "integer", minimum: 1 },
				mode: {
					type: "string",
					enum: ["RECENT", "CONTINUE", "BACKFILL"],
					default: "RECENT",
				},
				window: {
					type: "object",
					additionalProperties: false,
					properties: {
						start: { type: "string", format: "date-time" },
						end: { type: "string", format: "date-time" },
					},
					required: ["start", "end"],
					description:
						"Required only for BACKFILL: explicit past UTC window, at most seven days within the last 90 days. CONTINUE resumes the pinned window.",
				},
			},
			required: ["projectId", "watchId", "requestId", "expectedVersion"],
		},
		scope: "projects:write",
		annotations: { readOnlyHint: false, idempotentHint: true },
		confirm: "always",
	},
	{
		name: "fabric_delivery_source_status",
		description:
			"Read the current capture status without exposing workflow identifiers. Actor/current project/source-owner access is checked on every call. Not available to Pages or native/service runtimes.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { projectId: id, watchId: id },
			required: ["projectId", "watchId"],
		},
		scope: "projects:read",
		annotations: { readOnlyHint: true, idempotentHint: true },
	},
	{
		name: "fabric_delivery_source_cancel",
		description:
			"Cancel the current capture; this does not delete provider messages. Actor/current project/source-owner access is checked on every call. Not available to Pages or native/service runtimes.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { projectId: id, watchId: id, requestId: requestId },
			required: ["projectId", "watchId", "requestId"],
		},
		scope: "projects:write",
		annotations: { readOnlyHint: false, idempotentHint: true },
		confirm: "always",
	},
	{
		name: "fabric_delivery_source_observations",
		description:
			"List minimized private observation receipts without source text. Actor/current project/source-owner access is checked on every call. Not available to Pages or native/service runtimes.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				projectId: id,
				watchId: id,
				cursor: { type: "string", maxLength: 2048 },
				limit: {
					type: "integer",
					minimum: 1,
					maximum: 50,
					default: 20,
				},
			},
			required: ["projectId", "watchId"],
		},
		scope: "projects:read",
		annotations: { readOnlyHint: true, idempotentHint: true },
	},
	{
		name: "fabric_delivery_source_evidence",
		description:
			"Read one private observation only after fresh provider and exact-version access checks. Actor/current project/source-owner access is checked on every call. Not available to Pages or native/service runtimes.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { projectId: id, watchId: id, observationId: id },
			required: ["projectId", "watchId", "observationId"],
		},
		scope: "projects:read",
		annotations: { readOnlyHint: true, idempotentHint: true },
	},
] as const satisfies readonly FabricToolDefinition[];
export const DELIVERY_SOURCE_TOOL_NAMES =
	FABRIC_DELIVERY_SOURCE_TOOL_DEFINITIONS.map((tool) => tool.name);
