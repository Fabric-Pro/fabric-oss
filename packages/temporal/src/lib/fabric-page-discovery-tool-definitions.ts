import { defineFabricTools } from "./fabric-tool-definition";

/** Authoring discovery uses the gateway's actual page allowlist and schemas. */
export const FABRIC_PAGE_DISCOVERY_TOOL_DEFINITIONS = defineFabricTools([
	{
		name: "fabric_list_page_tools",
		description:
			"Discovers exact allowed runtimeTools schemas/annotations before writing fabric.call. Connected reads declare connected:<provider>/<tool>.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", maxLength: 200 },
				limit: {
					type: "integer",
					minimum: 1,
					maximum: 50,
					default: 20,
				},
			},
		},
		annotations: { readOnlyHint: true },
		scope: "frames:read",
	},
]);

export type FabricPageDiscoveryToolName =
	(typeof FABRIC_PAGE_DISCOVERY_TOOL_DEFINITIONS)[number]["name"];
