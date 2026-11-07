import { defineFabricTools } from "./fabric-tool-definition";

export const FABRIC_DASHBOARD_TOOL_DEFINITIONS = defineFabricTools([
	{
		name: "fabric_list_curated_feedback",
		description:
			"Read your own Curated for you pins, dismissals and click signals in the active organization. Read-only; no other user's preferences are exposed.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		scope: "dashboard:read",
		annotations: { readOnlyHint: true, idempotentHint: true },
	},
	{
		name: "fabric_record_curated_feedback",
		description:
			"Record your own Curated for you feedback using a stable card key: click, pin, unpin, dismiss or restore. Click is not idempotent.",
		inputSchema: {
			type: "object",
			properties: {
				cardKey: { type: "string", minLength: 1, maxLength: 200 },
				action: {
					type: "string",
					enum: ["click", "pin", "unpin", "dismiss", "restore"],
				},
			},
			required: ["cardKey", "action"],
			additionalProperties: false,
		},
		scope: "dashboard:write",
		annotations: { readOnlyHint: false, idempotentHint: false },
	},
]);
