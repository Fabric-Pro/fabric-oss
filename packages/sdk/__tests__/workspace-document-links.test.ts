import { describe, expect, it, vi } from "vitest";
import { createFabric, FabricError } from "../src/index.js";

function setup(status = 200) {
	const fetch = vi.fn<typeof globalThis.fetch>(
		async () =>
			new Response(
				JSON.stringify(
					status === 200
						? { data: { links: [], removed: true } }
						: {
								error: {
									code: "CONFLICT",
									message: "Inspect the current source.",
								},
							},
				),
				{ status, headers: { "content-type": "application/json" } },
			),
	);
	return {
		fetch,
		client: createFabric({
			apiKey: "example-key",
			baseUrl: "https://example.com",
			fetch,
			retry: { maxRetries: 2 },
		}),
	};
}

describe("linked Workspace document SDK", () => {
	it("encodes explicit project, link and organization while preserving Unicode continuation pins", async () => {
		const { fetch, client } = setup();
		await client.contexts.readLinkedDocument(
			"example/project",
			"example/link",
			{
				org: "example team",
				offset: 1,
				limit: 20,
				expectedRevision: "a".repeat(64),
			},
		);
		const url = new URL(String(fetch.mock.calls[0][0]));
		expect(url.pathname).toBe(
			"/api/v1/projects/example%2Fproject/contexts/workspace-documents/example%2Flink/content",
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			org: "example team",
			offset: "1",
			limit: "20",
			expectedRevision: "a".repeat(64),
		});
	});
	it("lists references with bounded caller pagination", async () => {
		const { fetch, client } = setup();
		await client.contexts.linkedDocuments("example-project", {
			offset: 20,
			limit: 20,
		});
		expect(new URL(String(fetch.mock.calls[0][0])).search).toBe(
			"?offset=20&limit=20",
		);
	});
	it("posts only source references and removes only the project link", async () => {
		const { fetch, client } = setup();
		const input = {
			workspaceId: "example-workspace",
			documentId: "example-document",
			expectedRevision: "b".repeat(64),
		};
		await client.contexts.linkWorkspaceDocument("example-project", input);
		expect(fetch.mock.calls[0][1]?.method).toBe("POST");
		expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(input);
		await client.contexts.unlinkWorkspaceDocument(
			"example-project",
			"example-link",
		);
		expect(fetch.mock.calls[1][1]?.method).toBe("DELETE");
		expect(new URL(String(fetch.mock.calls[1][0])).pathname).toBe(
			"/api/v1/projects/example-project/contexts/workspace-documents/example-link",
		);
	});
	it.each([403, 409, 503])(
		"does not retry a refused %s mutation against a changed source",
		async (status) => {
			const { fetch, client } = setup(status);
			await expect(
				client.contexts.linkWorkspaceDocument("example-project", {
					workspaceId: "example-workspace",
					documentId: "example-document",
					expectedRevision: "b".repeat(64),
				}),
			).rejects.toBeInstanceOf(FabricError);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
});
