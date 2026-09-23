/**
 * ContextsResource shape tests (Fizzy #2618).
 *
 * Same contract as the other SDK suites: `fetch` is stubbed and the
 * assertions are about the request that leaves the client and what the
 * caller gets back. The one behaviour that matters beyond the URL is the
 * 409: a conflict carries the stored version's hash and who changed it, and
 * a client that dropped that payload could neither tell the user who they
 * lost to nor replace that exact version with `--force`.
 */
import { describe, expect, it } from "vitest";
import {
	createFabric,
	type DeletedSyncedContextFileResult,
	type FabricClient,
	FabricContextConflictError,
	FabricError,
	FabricForbiddenError,
} from "../src/index.js";

interface CapturedRequest {
	url: string;
	method: string;
	body: unknown;
	headers: Record<string, string>;
}

function buildClient({
	status = 200,
	rawBody,
	org,
}: {
	status?: number;
	rawBody?: unknown;
	org?: string;
} = {}): { client: FabricClient; captured: CapturedRequest[] } {
	const captured: CapturedRequest[] = [];
	const stub: typeof fetch = async (input, init) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((v, k) => {
			headers[k] = v;
		});
		captured.push({
			url,
			method: init?.method ?? "GET",
			body: init?.body ? JSON.parse(init.body as string) : null,
			headers,
		});
		return new Response(
			JSON.stringify(
				rawBody ?? {
					data: {
						status: "created",
						contextId: "ctx-1",
						sourcePath: "docs/a.md",
						contentHash: "a".repeat(64),
					},
				},
			),
			{ status, headers: { "Content-Type": "application/json" } },
		);
	};
	const client = createFabric({
		apiKey: "org_test_key",
		baseUrl: "https://test.fabric",
		fetch: stub,
		retry: { maxRetries: 0 },
		org,
	});
	return { client, captured };
}

const CONFLICT_BODY = {
	error: {
		message:
			"This file was changed on the server since the version you are replacing, so nothing was written.",
		code: "CONFLICT",
		data: {
			status: "conflict",
			contextId: "ctx-1",
			sourcePath: "docs/a.md",
			contentHash: "a".repeat(64),
			current: {
				contextId: "ctx-1",
				contentHash: "b".repeat(64),
				contentUpdatedAt: "2026-09-22T10:00:00.000Z",
				contentUpdatedBy: { id: "user-2", name: "Example Editor" },
			},
		},
	},
};

describe("ContextsResource.upsertSyncedFile", () => {
	it("PUTs the file to the project's synced-files route", async () => {
		const { client, captured } = buildClient();

		const result = await client.contexts.upsertSyncedFile("proj 1", {
			sourcePath: "docs/a.md",
			content: "# A\n",
		});

		expect(result).toEqual({
			status: "created",
			contextId: "ctx-1",
			sourcePath: "docs/a.md",
			contentHash: "a".repeat(64),
		});
		const request = captured[0];
		expect(request?.method).toBe("PUT");
		expect(request?.url).toBe(
			"https://test.fabric/api/v1/projects/proj%201/contexts/synced-files",
		);
		expect(request?.headers.authorization).toBe("Bearer org_test_key");
		// Sent as given: no title and no hash unless the caller has one.
		expect(request?.body).toEqual({
			sourcePath: "docs/a.md",
			content: "# A\n",
		});
	});

	it("sends title and expectedContentHash when given, and binds ?org=", async () => {
		const { client, captured } = buildClient();

		await client.contexts.upsertSyncedFile(
			"proj-1",
			{
				sourcePath: "docs/a.md",
				content: "# A\n",
				title: "A",
				expectedContentHash: "c".repeat(64),
			},
			{ org: "example-org" },
		);

		expect(captured[0]?.url).toBe(
			"https://test.fabric/api/v1/projects/proj-1/contexts/synced-files?org=example-org",
		);
		expect(captured[0]?.body).toEqual({
			sourcePath: "docs/a.md",
			content: "# A\n",
			title: "A",
			expectedContentHash: "c".repeat(64),
		});
	});

	it("throws a typed conflict carrying the stored version's stamp on 409", async () => {
		const { client } = buildClient({ status: 409, rawBody: CONFLICT_BODY });

		const error = await client.contexts
			.upsertSyncedFile("proj-1", {
				sourcePath: "docs/a.md",
				content: "x",
			})
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(FabricContextConflictError);
		// Still a FabricError, so a caller's generic handling keeps working.
		expect(error).toBeInstanceOf(FabricError);
		const conflict = error as FabricContextConflictError;
		expect(conflict.status).toBe(409);
		expect(conflict.code).toBe("CONFLICT");
		expect(conflict.conflict).toEqual(CONFLICT_BODY.error.data);
		expect(conflict.conflict.current?.contentHash).toBe("b".repeat(64));
		expect(conflict.conflict.current?.contentUpdatedBy?.name).toBe(
			"Example Editor",
		);
	});

	it("throws a typed conflict with no current version when the named file was deleted", async () => {
		const deleted = {
			error: {
				message:
					"This file was deleted on the server since the version you are replacing, so nothing was written. Push again without expectedContentHash to recreate it, which answers duplicate instead if that content already exists elsewhere in the project.",
				code: "CONFLICT",
				data: {
					status: "conflict",
					contextId: null,
					sourcePath: "docs/a.md",
					contentHash: "a".repeat(64),
					current: null,
				},
			},
		};
		const { client } = buildClient({ status: 409, rawBody: deleted });

		const error = await client.contexts
			.upsertSyncedFile("proj-1", {
				sourcePath: "docs/a.md",
				content: "x",
				expectedContentHash: "b".repeat(64),
			})
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(FabricContextConflictError);
		const conflict = error as FabricContextConflictError;
		expect(conflict.conflict).toEqual(deleted.error.data);
		expect(conflict.conflict.current).toBeNull();
		expect(conflict.conflict.contextId).toBeNull();
		expect(conflict.message).toMatch(/deleted on the server/);
	});

	it("keeps a 409 without a conflict payload an ordinary FabricError", async () => {
		const { client } = buildClient({
			status: 409,
			rawBody: { error: { message: "Something else", code: "OTHER" } },
		});

		const error = await client.contexts
			.upsertSyncedFile("proj-1", { sourcePath: "a.md", content: "x" })
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(FabricError);
		expect(error).not.toBeInstanceOf(FabricContextConflictError);
		expect((error as FabricError).code).toBe("OTHER");
	});

	it("keeps a scope refusal a FabricForbiddenError with MISSING_SCOPE", async () => {
		const { client } = buildClient({
			status: 403,
			rawBody: { error: "Missing required scope: projects:write" },
		});

		const error = await client.contexts
			.upsertSyncedFile("proj-1", { sourcePath: "a.md", content: "x" })
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(FabricForbiddenError);
		expect((error as FabricForbiddenError).code).toBe("MISSING_SCOPE");
	});
});

describe("ContextsResource.upsertSyncedFile — a move (Fizzy #2636)", () => {
	it("sends movedFromSourcePath with the old path's hash, and returns the moved result", async () => {
		const moved = {
			status: "moved",
			contextId: "ctx-1",
			sourcePath: "docs/a.md",
			contentHash: "a".repeat(64),
			movedFromSourcePath: "a.md",
		};
		const { client, captured } = buildClient({ rawBody: { data: moved } });

		const result = await client.contexts.upsertSyncedFile("proj-1", {
			sourcePath: "docs/a.md",
			content: "# A\n",
			movedFromSourcePath: "a.md",
			expectedContentHash: "a".repeat(64),
		});

		expect(result).toEqual(moved);
		expect(captured[0]?.body).toEqual({
			sourcePath: "docs/a.md",
			content: "# A\n",
			expectedContentHash: "a".repeat(64),
			movedFromSourcePath: "a.md",
		});
	});

	it("keeps why a move was not applied on an ordinary answer", async () => {
		const created = {
			status: "created",
			contextId: "ctx-2",
			sourcePath: "docs/a.md",
			contentHash: "a".repeat(64),
			moveNotApplied: {
				movedFromSourcePath: "a.md",
				reason: "source-missing",
			},
		};
		const { client } = buildClient({ rawBody: { data: created } });

		const result = await client.contexts.upsertSyncedFile("proj-1", {
			sourcePath: "docs/a.md",
			content: "# A\n",
			movedFromSourcePath: "a.md",
			expectedContentHash: "a".repeat(64),
		});

		expect(result.status).toBe("created");
		if (result.status === "created") {
			expect(result.moveNotApplied?.reason).toBe("source-missing");
		}
	});
});

describe("ContextsResource.deleteSyncedFile (Fizzy #2636)", () => {
	const DELETED = {
		status: "deleted",
		contextId: "ctx-1",
		sourcePath: "docs/a.md",
		contentHash: "a".repeat(64),
	};

	it("sends a DELETE to the synced-files route with the path and the named hash in the body", async () => {
		const { client, captured } = buildClient({
			rawBody: { data: DELETED },
		});

		const result = await client.contexts.deleteSyncedFile("proj 1", {
			sourcePath: "docs/a.md",
			expectedContentHash: "a".repeat(64),
		});

		expect(result).toEqual(DELETED);
		const request = captured[0];
		expect(request?.method).toBe("DELETE");
		expect(request?.url).toBe(
			"https://test.fabric/api/v1/projects/proj%201/contexts/synced-files",
		);
		expect(request?.headers["content-type"]).toBe("application/json");
		expect(request?.body).toEqual({
			sourcePath: "docs/a.md",
			expectedContentHash: "a".repeat(64),
		});
	});

	it("binds ?org= when given", async () => {
		const { client, captured } = buildClient({
			rawBody: { data: DELETED },
		});

		await client.contexts.deleteSyncedFile(
			"proj-1",
			{ sourcePath: "docs/a.md", expectedContentHash: "a".repeat(64) },
			{ org: "example-org" },
		);

		expect(captured[0]?.url).toBe(
			"https://test.fabric/api/v1/projects/proj-1/contexts/synced-files?org=example-org",
		);
	});

	it("returns absent for a path with no source", async () => {
		const absent = { status: "absent", sourcePath: "docs/a.md" };
		const { client } = buildClient({ rawBody: { data: absent } });

		const result = await client.contexts.deleteSyncedFile("proj-1", {
			sourcePath: "docs/a.md",
			expectedContentHash: "a".repeat(64),
		});

		expect(result).toEqual(absent);
	});

	it("resolves a 202 in-progress as its answer, once, without retrying: the deletion is still running on the server", async () => {
		const inProgress = {
			status: "in-progress",
			sourcePath: "docs/a.md",
		} satisfies DeletedSyncedContextFileResult;
		const { client, captured } = buildClient({
			status: 202,
			rawBody: { data: inProgress },
		});

		const result = await client.contexts.deleteSyncedFile("proj-1", {
			sourcePath: "docs/a.md",
			expectedContentHash: "a".repeat(64),
		});

		expect(result).toEqual(inProgress);
		expect(captured).toHaveLength(1);
	});

	it("throws a typed conflict carrying the stored version's stamp on 409", async () => {
		const body = {
			error: {
				message:
					"This file was changed on the server since the version you are deleting, so nothing was deleted.",
				code: "CONFLICT",
				data: {
					...CONFLICT_BODY.error.data,
				},
			},
		};
		const { client } = buildClient({ status: 409, rawBody: body });

		const error = await client.contexts
			.deleteSyncedFile("proj-1", {
				sourcePath: "docs/a.md",
				expectedContentHash: "a".repeat(64),
			})
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(FabricContextConflictError);
		const conflict = error as FabricContextConflictError;
		expect(conflict.conflict.current?.contentHash).toBe("b".repeat(64));
		expect(conflict.message).toMatch(/nothing was deleted/);
	});

	it("keeps a missing permission a FabricForbiddenError", async () => {
		const { client } = buildClient({
			status: 403,
			rawBody: {
				error: {
					message:
						"No permission to delete context sources from this project",
				},
			},
		});

		const error = await client.contexts
			.deleteSyncedFile("proj-1", {
				sourcePath: "docs/a.md",
				expectedContentHash: "a".repeat(64),
			})
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(FabricForbiddenError);
		expect(error).not.toBeInstanceOf(FabricContextConflictError);
	});
});

describe("FabricHttpClient.delete", () => {
	it("still sends no body for a DELETE that has none", async () => {
		const { client, captured } = buildClient({
			rawBody: { data: { id: "chat_1", deleted: true } },
		});

		await client.chats.delete("chat_1");

		expect(captured[0]?.method).toBe("DELETE");
		expect(captured[0]?.body).toBeNull();
	});
});

describe("FabricError.data", () => {
	it("carries the error body's data for any non-2xx the client does not specialise", async () => {
		const { client } = buildClient({
			status: 422,
			rawBody: {
				error: { message: "Bad", code: "BAD", data: { field: "x" } },
			},
		});

		const error = await client.contexts
			.upsertSyncedFile("proj-1", { sourcePath: "a.md", content: "x" })
			.catch((e: unknown) => e);

		expect((error as FabricError).data).toEqual({ field: "x" });
	});
});
