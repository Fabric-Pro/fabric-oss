import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ open: vi.fn(), list: vi.fn(), close: vi.fn() }));
vi.mock("../src/activities/shared/fabric-gateway-client", () => ({
	openFabricGateway: m.open,
}));

import { preloadFrameToolsActivity } from "../src/activities/orchestrator/tools/preload-frame-tools";

const actor = {
	userId: "example-user",
	organizationId: "example-org",
	actingGrant: "example-grant",
};
beforeEach(() => {
	vi.clearAllMocks();
	m.open.mockReturnValue({ listTools: m.list, close: m.close });
});
it("returns only read and edit schemas listed by this turn's gateway", async () => {
	const tools = [
		"fabric_get_frame",
		"fabric_edit_frame_block",
		"fabric_update_frame",
	].map((name) => ({ name, description: name, inputSchema: {} }));
	m.list.mockResolvedValue(tools);
	expect(await preloadFrameToolsActivity(actor)).toEqual(tools.slice(0, 2));
	expect(m.open).toHaveBeenCalledWith(actor);
	expect(m.close).toHaveBeenCalledOnce();
});
it("offers no schemas without a gateway connection", async () => {
	m.open.mockReturnValue(null);
	expect(await preloadFrameToolsActivity(actor)).toEqual([]);
	expect(m.list).not.toHaveBeenCalled();
});
it("offers no schemas after a failed listing and closes the connection", async () => {
	m.list.mockResolvedValue(null);
	expect(await preloadFrameToolsActivity(actor)).toEqual([]);
	expect(m.close).toHaveBeenCalledOnce();
});
