import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySession } from "../types";

const m = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock(
	"@repo/api/modules/projects/lib/delivery-snapshot",
	async (original) => ({
		...(await original<Record<string, unknown>>()),
		getProjectDeliverySnapshot: m.read,
	}),
);

import { createProjectDeliveryTools } from "../tools/project-delivery-tools";

const session = {
	userId: "example-user",
	organizationId: "example-org",
	credential: "api_key",
	scopes: ["projects:read"],
} as GatewaySession;
const tools = createProjectDeliveryTools();
const call = tools.handlers.get("fabric_get_project_delivery");
if (!call) {
	throw new Error("Delivery tool must have a handler");
}
beforeEach(() => {
	m.read.mockReset().mockResolvedValue({ version: 1 });
});
describe("delivery MCP security", () => {
	it("retains unavailable document/decision evidence in the shared response", async () => {
		const sections = {
			decisions: { available: false, items: [] },
			documents: { available: false, items: [] },
		};
		m.read.mockResolvedValue(sections);
		const response = await call({ projectId: "example-project" }, session);
		const content = response.content?.[0];
		expect(content).toMatchObject({ type: "text" });
		expect(JSON.parse((content as { text: string }).text)).toEqual(
			sections,
		);
	});
	it("offers a truthful read-only operation and calls the shared authorized command", async () => {
		expect(tools.definitions[0]).toMatchObject({
			name: "fabric_get_project_delivery",
			annotations: { readOnlyHint: true },
		});
		await call({ projectId: "example-project" }, session);
		expect(m.read).toHaveBeenCalledWith(
			{ userId: "example-user", organizationId: "example-org" },
			{ projectId: "example-project" },
		);
	});
	it("requires declared scope and current permission even for wildcard", async () => {
		expect(
			await call(
				{ projectId: "example-project" },
				{ ...session, scopes: [] },
			),
		).toMatchObject({ isError: true });
		expect(m.read).not.toHaveBeenCalled();
		m.read.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "Current permission revoked",
			}),
		);
		expect(
			await call(
				{ projectId: "example-project" },
				{ ...session, scopes: ["*"] },
			),
		).toMatchObject({ isError: true });
	});
	it("does not trust caller actor or tenant fields", async () => {
		expect(
			await call(
				{ projectId: "example-project", userId: "other-user" },
				session,
			),
		).toMatchObject({ isError: true });
		expect(m.read).not.toHaveBeenCalled();
	});
});
