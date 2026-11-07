import { describe, expect, it, vi } from "vitest";
import { createFabric } from "../src/index";

describe("source-backed project history SDK", () => {
	it("encodes routing and filters and retains minimized server data", async () => {
		const data = {
			version: 1,
			coverage: "PROJECT_WORK_ITEMS_ONLY",
			items: [],
			nextCursor: "example-cursor",
		};
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(JSON.stringify({ data }), {
					headers: { "content-type": "application/json" },
				}),
		);
		const client = createFabric({
			apiKey: "example-key",
			baseUrl: "https://example.com",
			fetch,
		});
		expect(
			await client.projects.listDeliverySignals("example/project", {
				org: "example team",
				source: "TEAMS",
				search: "release & plans",
				limit: 5,
				cursor: "example-cursor",
			}),
		).toEqual(data);
		const url = String(fetch.mock.calls[0][0]);
		expect(url).toContain("/projects/example%2Fproject/delivery/signals?");
		const query = new URL(url).searchParams;
		expect(Object.fromEntries(query)).toEqual({
			org: "example team",
			source: "TEAMS",
			search: "release & plans",
			limit: "5",
			cursor: "example-cursor",
		});
		await client.projects.getDeliverySignal(
			"example-project",
			"example/item",
		);
		expect(String(fetch.mock.calls[1][0])).toContain(
			"/delivery/signals/example%2Fitem",
		);
		await client.projects.getDeliverySignalSourceConfiguration(
			"example-project",
		);
		expect(String(fetch.mock.calls[2][0])).toContain("/delivery/sources");
	});
});
