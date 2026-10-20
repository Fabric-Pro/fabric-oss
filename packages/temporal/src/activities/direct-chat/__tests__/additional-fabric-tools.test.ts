/**
 * A caller that keeps the chat's default tool set can ask for a Fabric tool on
 * top of it (`additionalFabricToolIds`). Parlume's Fabric Agent does, for
 * creating a work item, without giving up the default set's reads.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/get-search-provider", () => ({
	resolveSearchProviderForTenant: async () => null,
}));

const { createBuiltInTools } = await import("../built-in-tools");

const base = { userId: "user", organizationId: "org" };

describe("additionalFabricToolIds", () => {
	it("adds the tool to the default set", async () => {
		const tools = await createBuiltInTools({
			...base,
			additionalFabricToolIds: ["fabric_create_story"],
		});

		expect(tools).toHaveProperty("fabric_create_story");
	});

	it("adds nothing to the default set when none is asked for", async () => {
		const tools = await createBuiltInTools(base);

		expect(tools).not.toHaveProperty("fabric_create_story");
	});

	it("adds the tool to an explicit list", async () => {
		const tools = await createBuiltInTools({
			...base,
			enabledFabricToolIds: ["fabric_scrape_url"],
			additionalFabricToolIds: ["fabric_create_story"],
		});

		expect(Object.keys(tools).sort()).toEqual([
			"fabric_create_story",
			"fabric_scrape_url",
		]);
	});

	it("leaves an explicitly empty list empty", async () => {
		const tools = await createBuiltInTools({
			...base,
			enabledFabricToolIds: [],
			additionalFabricToolIds: ["fabric_create_story"],
		});

		expect(tools).toEqual({});
	});
});
