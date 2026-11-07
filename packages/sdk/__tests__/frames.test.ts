import { describe, expect, it, vi } from "vitest";
import { createFabric } from "../src/index.js";

describe("Frames SDK discovery", () => {
	it("forwards bounded pagination and conversation filters with the organization", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(JSON.stringify({ data: [] }), {
					headers: { "Content-Type": "application/json" },
				}),
		);
		const client = createFabric({
			apiKey: "example-key",
			baseUrl: "https://example.com",
			org: "example-org",
			fetch,
		});
		await client.frames.list({
			conversationId: "example/thread",
			offset: 20,
			limit: 21,
		});
		const url = new URL(String(fetch.mock.calls[0][0]));
		expect(url.pathname).toBe("/api/v1/frames");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			conversationId: "example/thread",
			offset: "20",
			limit: "21",
			org: "example-org",
		});
	});
});

it("does not retry an ambiguous content write", async () => {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockRejectedValue(new TypeError("Lost acknowledgement"));
	const client = createFabric({
		apiKey: "example-key",
		baseUrl: "https://example.com",
		org: "example-org",
		fetch,
	});
	await expect(
		client.frames.update("example/frame", {
			expectedUpdatedAt: "2026-11-01T00:00:00Z",
			title: "Changed",
			presentation: "INTERFACE",
		}),
	).rejects.toThrow();
	expect(fetch).toHaveBeenCalledOnce();
	expect(String(fetch.mock.calls[0][0])).toContain("example%2Fframe/update");
});

it("forwards stable history IDs and reviewed revision without automatic retries", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(
		async () =>
			new Response(
				JSON.stringify({
					data: { success: true, updatedAt: "2026-11-02T00:00:00Z" },
				}),
				{ headers: { "Content-Type": "application/json" } },
			),
	);
	const client = createFabric({
		apiKey: "example-key",
		baseUrl: "https://example.com",
		org: "example-org",
		fetch,
	});
	const body = {
		historyEntryId: "example-entry",
		expectedUpdatedAt: "2026-11-01T00:00:00Z",
	};
	await client.frames.restore("example/frame", body);
	expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(body);
	expect(String(fetch.mock.calls[0][0])).toContain("example%2Fframe/restore");
	await client.frames.history("example/frame");
	expect(String(fetch.mock.calls[1][0])).toContain("example%2Fframe/history");
});

it("uses stable export IDs and explicit download issuance without retrying mutations", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(
		async () =>
			new Response(
				JSON.stringify({
					data: { exportId: "example/export", status: "pending" },
				}),
				{ headers: { "Content-Type": "application/json" } },
			),
	);
	const client = createFabric({
		apiKey: "example-key",
		baseUrl: "https://example.com",
		org: "example-org",
		fetch,
	});
	const input = {
		expectedUpdatedAt: "2026-11-01T00:00:00Z",
		requestId: "12345678-1234-4123-8123-123456789abc",
	};
	await client.frames.startExport("example/frame", input);
	expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(input);
	await client.frames.getExport("example/frame", "example/export");
	await client.frames.downloadExport("example/frame", "example/export");
	await client.frames.cancelExport("example/frame", "example/export");
	expect(fetch.mock.calls.map((c) => new URL(String(c[0])).pathname)).toEqual(
		[
			"/api/v1/frames/example%2Fframe/exports",
			"/api/v1/frames/example%2Fframe/exports/example%2Fexport",
			"/api/v1/frames/example%2Fframe/exports/example%2Fexport/download",
			"/api/v1/frames/example%2Fframe/exports/example%2Fexport/cancel",
		],
	);
	expect(fetch.mock.calls.map((c) => c[1]?.method)).toEqual([
		"POST",
		"GET",
		"POST",
		"POST",
	]);
});
it("keeps sharing inspection apart from explicit grant and revoke commands", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(
		async () =>
			new Response(JSON.stringify({ data: {} }), {
				headers: { "Content-Type": "application/json" },
			}),
	);
	const client = createFabric({
		apiKey: "example-key",
		baseUrl: "https://example.com",
		org: "example-org",
		fetch,
	});
	await client.frames.sharing("example-frame");
	await client.frames.share("example-frame", {
		scope: "PUBLIC",
		expectedUpdatedAt: "2026-11-01T00:00:00Z",
	});
	await client.frames.revokeSharing("example-frame", {
		mode: "all",
		expectedUpdatedAt: "2026-11-01T00:00:00Z",
	});
	expect(fetch.mock.calls.map((c) => new URL(String(c[0])).pathname)).toEqual(
		[
			"/api/v1/frames/example-frame/sharing",
			"/api/v1/frames/example-frame/share",
			"/api/v1/frames/example-frame/revoke-sharing",
		],
	);
});

it("forwards appearance-only edits with the reviewed revision", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(
		async () =>
			new Response(
				JSON.stringify({
					data: { id: "example-frame", presentation: "INTERFACE" },
				}),
				{ headers: { "Content-Type": "application/json" } },
			),
	);
	const client = createFabric({
		apiKey: "example-key",
		baseUrl: "https://example.com",
		org: "example-org",
		fetch,
	});
	const edit = {
		expectedUpdatedAt: "2026-11-01T00:00:00Z",
		presentation: "INTERFACE" as const,
	};
	expect(await client.frames.update("example-frame", edit)).toMatchObject({
		presentation: "INTERFACE",
	});
	expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(edit);
});

it("encodes review identifiers, preserves typed inputs and never retries an ambiguous apply", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(
		async () =>
			new Response(
				JSON.stringify({ data: { id: "example", proposals: [] } }),
				{ headers: { "Content-Type": "application/json" } },
			),
	);
	const client = createFabric({
		apiKey: "example-key",
		baseUrl: "https://example.com",
		org: "example-org",
		fetch,
	});
	const requestId = "11111111-1111-4111-8111-111111111111";
	await client.frames.createFromTemplate({
		requestId,
		templateId: "example-template",
		variables: {
			enabled: false,
			count: 0,
			client: 'Example "Client"\nLine',
		},
	});
	expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
		requestId,
		variables: {
			enabled: false,
			count: 0,
			client: 'Example "Client"\nLine',
		},
	});
	await client.frames.getChange("example/frame", "example/change");
	expect(String(fetch.mock.calls[1][0])).toContain(
		"/frames/example%2Fframe/changes/example%2Fchange",
	);
	await client.frames.listChanges("example/frame", { limit: 20, offset: 40 });
	expect(
		new URL(String(fetch.mock.calls[2][0])).searchParams.get("offset"),
	).toBe("40");
	fetch.mockRejectedValue(new TypeError("Lost acknowledgement"));
	const before = fetch.mock.calls.length;
	await expect(
		client.frames.applyChange("example/frame", {
			proposalId: "example/change",
			expectedProposalHash: "a".repeat(64),
		}),
	).rejects.toThrow();
	expect(fetch.mock.calls.length - before).toBe(1);
});
