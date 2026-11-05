import { describe, expect, it } from "vitest";
import { FABRIC_GATEWAY_CATALOG_TOOLS } from "../../activities/orchestrator/tools/fabric-gateway-catalog-tools";
import {
	FABRIC_CHAT_TOOL_DEFINITIONS,
	fabricGatewayTool,
	gatewayToolAccess,
	isFabricChatTool,
} from "../fabric-gateway-tools";
import { isFabricPortalTool } from "../fabric-portal-tools";
import { FABRIC_WORKSPACE_TOOL_DEFINITIONS } from "../fabric-workspace-tool-definitions";

describe("document Workspace reads across chat surfaces", () => {
	it.each(FABRIC_WORKSPACE_TOOL_DEFINITIONS.map((tool) => tool.name))(
		"offers %s to the shared chat runtime and Loom discovery",
		(name) => {
			expect(isFabricChatTool(name)).toBe(true);
			expect(
				FABRIC_CHAT_TOOL_DEFINITIONS.map((tool) => tool.name),
			).toContain(name);
			expect(
				FABRIC_GATEWAY_CATALOG_TOOLS.map((tool) => tool.name),
			).toContain(name);
			expect(isFabricPortalTool(name)).toBe(true);
			expect(gatewayToolAccess(name)).toBe("READ");
			expect(fabricGatewayTool(name)?.scope).toBe("workspaces:read");
		},
	);
	it("distinguishes uploaded document Workspaces from generated Pages", () => {
		expect(
			fabricGatewayTool("fabric_list_workspaces")?.description,
		).toContain("Generated Pages");
		expect(
			fabricGatewayTool("fabric_get_workspace_document")?.inputSchema,
		).toMatchObject({ required: ["workspaceId", "documentId"] });
	});
	it("advertises bounded Unicode pages and revision-pinned continuation on every shared surface", () => {
		const tool = fabricGatewayTool("fabric_get_workspace_document");
		expect(tool?.inputSchema).toMatchObject({
			properties: {
				offset: { maximum: 2147483646 },
				limit: { maximum: 20000 },
				expectedRevision: { pattern: "^[a-f0-9]{64}$" },
			},
		});
		expect(tool?.description).toContain("Unicode code points");
		expect(tool?.description).toContain("expectedRevision");
		expect(tool?.description).toContain("No historical versions");
	});
});
