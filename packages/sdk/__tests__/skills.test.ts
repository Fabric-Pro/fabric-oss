import { describe, expect, it, vi } from "vitest";
import { FabricHttpClient } from "../src/client.js";
import { SkillsResource } from "../src/resources/skills.js";

function fixture() {
	const http = {
		get: vi.fn().mockResolvedValue({}),
		request: vi.fn().mockResolvedValue({}),
	};
	return {
		http,
		resource: new SkillsResource(http as unknown as FabricHttpClient),
	};
}
const draft = {
	name: "Example review",
	slug: "example-review",
	description: "Check the change",
	content: "Review permissions and tests.",
};
const source = {
	kind: "file" as const,
	fileName: "example.md",
	base64: "RXhhbXBsZQ==",
};
describe("governed Skills SDK", () => {
	it("preserves legacy array lists and exposes explicit complete pages", async () => {
		const { http, resource } = fixture();
		await resource.list({
			org: "example team",
			isPublished: true,
			tags: ["tests", "review"],
		});
		expect(http.get).toHaveBeenLastCalledWith(
			"/skills?org=example+team&isPublished=true&tags=tests&tags=review",
		);
		await resource.listPage({
			tab: "drafts",
			limit: 20,
			cursor: "example/next",
		});
		expect(http.get).toHaveBeenLastCalledWith(
			"/skills?tab=drafts&limit=20&cursor=example%2Fnext&page=1",
		);
		await resource.get("example/skill", { org: "example-org" });
		expect(http.get).toHaveBeenLastCalledWith(
			"/skills/example%2Fskill?org=example-org",
		);
	});
	it("makes create/update explicit and never automatically retries a mutation", async () => {
		const { http, resource } = fixture();
		await resource.create(draft);
		expect(http.request).toHaveBeenLastCalledWith("POST", "/skills", {
			body: draft,
			retry: { maxRetries: 0 },
		});
		await resource.update("example/skill", {
			expectedVersion: 2,
			description: "Updated",
		});
		expect(http.request).toHaveBeenLastCalledWith(
			"PATCH",
			"/skills/example%2Fskill",
			{
				body: { expectedVersion: 2, description: "Updated" },
				retry: { maxRetries: 0 },
			},
		);
	});
	it("preserves exact version/publication choices separately from edits", async () => {
		const { http, resource } = fixture();
		for (const action of ["archive", "restore"] as const) {
			await resource[action](
				"example/skill",
				{ expectedVersion: 2 },
				{ org: "example-org" },
			);
			expect(http.request).toHaveBeenLastCalledWith(
				"POST",
				`/skills/example%2Fskill/${action}?org=example-org`,
				{ body: { expectedVersion: 2 }, retry: { maxRetries: 0 } },
			);
		}
		await resource.publish("example-skill", {
			expectedVersion: 2,
			availability: "agents",
		});
		expect(http.request).toHaveBeenLastCalledWith(
			"POST",
			"/skills/example-skill/publish",
			{
				body: { expectedVersion: 2, availability: "agents" },
				retry: { maxRetries: 0 },
			},
		);
		await resource.delete("example-skill", { expectedVersion: 2 });
		expect(http.request).toHaveBeenLastCalledWith(
			"DELETE",
			"/skills/example-skill?expectedVersion=2",
			{ retry: { maxRetries: 0 } },
		);
	});
	it("preserves inspected import identity and does not invent publication", async () => {
		const { http, resource } = fixture();
		await resource.previewImport({ source });
		expect(http.request).toHaveBeenLastCalledWith(
			"POST",
			"/skill-imports/preview",
			{ body: { source }, retry: { maxRetries: 0 } },
		);
		const request = {
			source,
			candidateKey: "example.md",
			expectedHash: "a".repeat(64),
		};
		await resource.createImport(request);
		expect(http.request).toHaveBeenLastCalledWith(
			"POST",
			"/skill-imports",
			{ body: request, retry: { maxRetries: 0 } },
		);
	});
	it("returns reviewed AI suggestions without silently creating/updating", async () => {
		const { http, resource } = fixture();
		await resource.assist({ draft, message: "Improve clarity" });
		expect(http.request).toHaveBeenCalledExactlyOnceWith(
			"POST",
			"/skill-assistance",
			{
				body: { draft, message: "Improve clarity" },
				retry: { maxRetries: 0 },
			},
		);
	});
	it("exposes governance with an expected revision and no scope forwarding", async () => {
		const { http, resource } = fixture();
		await resource.getGovernance({ org: "example-org" });
		expect(http.get).toHaveBeenLastCalledWith(
			"/skill-governance?org=example-org",
		);
		const input = {
			expectedRevision: 2,
			policy: {
				create: "permitted_members" as const,
				publish: "administrators" as const,
				discover: "administrators" as const,
			},
		};
		await resource.updateGovernance(input);
		expect(http.request).toHaveBeenLastCalledWith(
			"PATCH",
			"/skill-governance",
			{ body: input, retry: { maxRetries: 0 } },
		);
	});
	it("bounds both uploaded and persisted file reads", async () => {
		const { http, resource } = fixture();
		await resource.readFile("example/skill", {
			path: "references/example.md",
			expectedVersion: 2,
		});
		expect(http.request).toHaveBeenLastCalledWith(
			"GET",
			"/skills/example%2Fskill/files?path=references%2Fexample.md&expectedVersion=2",
			{ boundedRead: { maxResponseBytes: 13 * 1024 * 1024 } },
		);
		const input = {
			source,
			candidateKey: "example.md",
			expectedHash: "a".repeat(64),
			path: "SKILL.md",
		};
		await resource.readImportFile(input);
		expect(http.request).toHaveBeenLastCalledWith(
			"POST",
			"/skill-imports/file",
			{
				body: input,
				retry: { maxRetries: 0 },
				boundedRead: { maxResponseBytes: 13 * 1024 * 1024 },
			},
		);
	});
	it("refuses oversized UTF-8 bodies before networking", async () => {
		const { http, resource } = fixture();
		await expect(
			resource.create({ ...draft, content: "x".repeat(1024 * 1024) }),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		await expect(
			resource.assist({ draft, message: "x".repeat(128 * 1024) }),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		expect(http.request).not.toHaveBeenCalled();
	});
	it("does not silently repeat a failed create when a client normally retries", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockRejectedValue(new Error("Disconnected"));
		const resource = new SkillsResource(
			new FabricHttpClient({
				apiKey: "example-key",
				baseUrl: "https://example.com",
				fetch,
				retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 1 },
			}),
		);
		await expect(resource.create(draft)).rejects.toMatchObject({
			code: "NETWORK_ERROR",
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it.each(["readFile", "readImportFile"] as const)(
		"%s accepts the worst-case JSON escaping of an authorized2MiB text file",
		async (method) => {
			const payload = {
				path: "references/example.txt",
				contentType: "text/plain",
				sizeBytes: 2 * 1024 * 1024,
				sha256: "a".repeat(64),
				encoding: "utf-8",
				data: "\u0001".repeat(2 * 1024 * 1024),
			};
			const body = JSON.stringify({ data: payload });
			expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(
				3 * 1024 * 1024,
			);
			const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
				async () =>
					new Response(body, {
						headers: { "content-type": "application/json" },
					}),
			);
			const resource = new SkillsResource(
				new FabricHttpClient({
					apiKey: "example-key",
					baseUrl: "https://example.com",
					fetch,
				}),
			);
			const result =
				method === "readFile"
					? await resource.readFile("example-skill", {
							path: payload.path,
						})
					: await resource.readImportFile({
							source,
							candidateKey: "example",
							expectedHash: "a".repeat(64),
							path: payload.path,
						});
			expect(result).toEqual(payload);
		},
	);
	it("retains an absolute bounded wire response limit", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new Uint8Array(13 * 1024 * 1024 + 1));
			},
			cancel() {
				cancelled = true;
			},
		});
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(new Response(body));
		const resource = new SkillsResource(
			new FabricHttpClient({
				apiKey: "example-key",
				baseUrl: "https://example.com",
				fetch,
			}),
		);
		await expect(
			resource.readFile("example-skill", {
				path: "references/example.txt",
			}),
		).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
		expect(cancelled).toBe(true);
	});
});
