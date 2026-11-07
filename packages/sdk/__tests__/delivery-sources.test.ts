import { describe, expect, it, vi } from "vitest";
import { createFabric } from "../src/index";

const requestId = "11111111-1111-4111-8111-111111111111";
describe("private delivery sources SDK", () => {
	it("routes all operations and retains safe-retry identity separately from org selectors", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(JSON.stringify({ data: { version: 1 } }), {
					headers: { "content-type": "application/json" },
				}),
		);
		const client = createFabric({
			apiKey: "example-key",
			baseUrl: "https://example.com",
			fetch,
		});
		const selection = {
			org: "example team",
			integrationId: "example-integration",
			channelId: "example-channel",
		};
		const mutation = { org: "example team", requestId, expectedVersion: 3 };
		await client.projects.listDeliverySources("example/project");
		await client.projects.testDeliverySource("example/project", selection);
		await client.projects.configureDeliverySource("example/project", {
			...selection,
			requestId,
			retentionDays: 7,
		});
		await client.projects.pauseDeliverySource(
			"example/project",
			"example/watch",
			mutation,
		);
		await client.projects.resumeDeliverySource(
			"example/project",
			"example/watch",
			mutation,
		);
		await client.projects.disconnectDeliverySource(
			"example/project",
			"example/watch",
			mutation,
		);
		await client.projects.startDeliverySourceCapture(
			"example/project",
			"example/watch",
			{ ...mutation, mode: "CONTINUE" },
		);
		await client.projects.getDeliverySourceCapture(
			"example/project",
			"example/watch",
		);
		await client.projects.cancelDeliverySourceCapture(
			"example/project",
			"example/watch",
			{ requestId },
		);
		await client.projects.listDeliverySourceObservations(
			"example/project",
			"example/watch",
			{ cursor: "opaque+cursor", limit: 5 },
		);
		await client.projects.getDeliverySourceEvidence(
			"example/project",
			"example/watch",
			"example/observation",
		);
		expect(fetch).toHaveBeenCalledTimes(11);
		expect(String(fetch.mock.calls[0][0])).toContain(
			"/projects/example%2Fproject/delivery/private-sources",
		);
		for (const index of [2, 3, 4, 5, 6, 8]) {
			const init = fetch.mock.calls[index][1];
			expect(JSON.parse(String(init?.body))).toMatchObject({ requestId });
			expect(JSON.parse(String(init?.body))).not.toHaveProperty("org");
			expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(
				requestId,
			);
		}
		expect(JSON.parse(String(fetch.mock.calls[3][1]?.body)).action).toBe(
			"PAUSE",
		);
		expect(JSON.parse(String(fetch.mock.calls[4][1]?.body)).action).toBe(
			"RESUME",
		);
		expect(JSON.parse(String(fetch.mock.calls[5][1]?.body)).action).toBe(
			"DISCONNECT",
		);
		expect(String(fetch.mock.calls[10][0])).toContain(
			"/example%2Fwatch/observations/example%2Fobservation",
		);
	});
	it("keeps semantic status codes available for machine-readable clients", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							code: "SOURCE_CHANGED",
							message: "Retry the reviewed source.",
						},
					}),
					{ status: 409 },
				),
		);
		const client = createFabric({
			apiKey: "example-key",
			baseUrl: "https://example.com",
			fetch,
		});
		await expect(
			client.projects.listDeliverySources("example-project"),
		).rejects.toMatchObject({ code: "SOURCE_CHANGED", status: 409 });
	});
});

it("returns operator/storage availability without inventing provider readiness", async () => {
	const data = {
		version: 1,
		availability: { state: "UNAVAILABLE", reason: "NOT_ENABLED" },
		watches: [],
		connections: [],
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
		await client.projects.listDeliverySources("example-project"),
	).toEqual(data);
});

it("preserves selected history window and request identity on the wire", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(
		async () =>
			new Response(JSON.stringify({ data: { version: 1 } }), {
				headers: { "content-type": "application/json" },
			}),
	);
	const client = createFabric({
		apiKey: "example-key",
		baseUrl: "https://example.com",
		fetch,
	});
	const window = {
		start: "2026-10-05T00:00:00.000Z",
		end: "2026-10-07T00:00:00.000Z",
	};
	await client.projects.startDeliverySourceCapture(
		"example-project",
		"example-watch",
		{ requestId, expectedVersion: 1, mode: "BACKFILL", window },
	);
	expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
		requestId,
		expectedVersion: 1,
		mode: "BACKFILL",
		window,
	});
});
