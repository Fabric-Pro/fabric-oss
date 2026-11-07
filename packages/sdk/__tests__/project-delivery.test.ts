import { describe, expect, it, vi } from "vitest";
import type { FabricHttpClient } from "../src/client";
import { createFabric } from "../src/index";
import { ProjectsResource } from "../src/resources/projects";

function client() {
	const calls = {
		get: vi.fn().mockResolvedValue({}),
		post: vi.fn().mockResolvedValue({}),
	};
	return {
		calls,
		projects: new ProjectsResource(calls as unknown as FabricHttpClient),
	};
}
describe("project delivery SDK wire", () => {
	it("preserves unavailable evidence for SDK consumers", async () => {
		const sections = {
			decisions: { available: false, items: [] },
			documents: { available: false, items: [] },
		};
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(JSON.stringify({ data: sections }), {
					headers: { "content-type": "application/json" },
				}),
		);
		const fabric = createFabric({
			apiKey: "example-key",
			baseUrl: "https://example.com",
			fetch,
		});
		expect(await fabric.projects.delivery("example-project")).toEqual(
			sections,
		);
	});
	it("uses the project path and optional organization for evidence", async () => {
		const { calls, projects } = client();
		await projects.delivery("project/example", { org: "example org" });
		expect(calls.get).toHaveBeenCalledWith(
			"/projects/project%2Fexample/delivery?org=example%20org",
		);
	});
	it("passes a bounded list cursor without changing its project or story", async () => {
		const { calls, projects } = client();
		await projects.listImplementationSessions("example-project", {
			org: "example-org",
			storyId: "example-story",
			cursor: "example-run",
			limit: 20,
		});
		expect(calls.get).toHaveBeenCalledWith(
			"/projects/example-project/implementation-sessions?org=example-org&cursor=example-run&storyId=example-story&limit=20",
		);
	});
	it("retains exact start/follow-up identities without inventing new runs", async () => {
		const { calls, projects } = client();
		const requestId = "00000000-0000-4000-8000-000000000001";
		await projects.startImplementationSession("example-project", {
			storyId: "example-story",
			requestId,
			org: "example-org",
		});
		expect(calls.post).toHaveBeenCalledWith(
			"/projects/example-project/implementation-sessions?org=example-org",
			{ storyId: "example-story", requestId },
			{ retry: { maxRetries: 0 } },
		);
		await projects.followUpImplementationSession(
			"example-project",
			"example-run",
			{ message: "Review the result", promptId: requestId },
		);
		expect(calls.post).toHaveBeenCalledWith(
			"/projects/example-project/implementation-sessions/example-run/follow-up",
			{ message: "Review the result", promptId: requestId },
			{ retry: { maxRetries: 0 } },
		);
	});
	it("exposes status, bounded messages and cancellation on the same session", async () => {
		const { calls, projects } = client();
		await projects.getImplementationSession(
			"example-project",
			"example-run",
		);
		await projects.getImplementationMessages(
			"example-project",
			"example-run",
		);
		await projects.cancelImplementationSession(
			"example-project",
			"example-run",
		);
		expect(calls.get).toHaveBeenCalledWith(
			"/projects/example-project/implementation-sessions/example-run",
		);
		expect(calls.get).toHaveBeenCalledWith(
			"/projects/example-project/implementation-sessions/example-run/messages",
		);
		expect(calls.post).toHaveBeenCalledWith(
			"/projects/example-project/implementation-sessions/example-run/cancel",
			{},
			{ retry: { maxRetries: 0 } },
		);
	});
});

describe("ambiguous implementation mutation delivery", () => {
	it.each(["start", "cancel", "followup"])(
		"never silently retries %s after a lost acknowledgement",
		async (operation) => {
			const fetch = vi
				.fn<typeof globalThis.fetch>()
				.mockRejectedValue(new TypeError("Lost acknowledgement"));
			const fabric = createFabric({
				apiKey: "example-key",
				baseUrl: "https://example.com",
				fetch,
				retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 1 },
			});
			const requestId = "00000000-0000-4000-8000-000000000001";
			await expect(
				operation === "start"
					? fabric.projects.startImplementationSession(
							"example-project",
							{ storyId: "example-story", requestId },
						)
					: operation === "cancel"
						? fabric.projects.cancelImplementationSession(
								"example-project",
								"example-run",
							)
						: fabric.projects.followUpImplementationSession(
								"example-project",
								"example-run",
								{ message: "Continue", promptId: requestId },
							),
			).rejects.toMatchObject({ code: "NETWORK_ERROR" });
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
});
