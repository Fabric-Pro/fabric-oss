/**
 * MemoryResource shape tests (ADR-022, phase 4): `fetch` is stubbed and the
 * assertions are about the request that leaves the client and what the caller
 * gets back, above all that a refused write carries its problems in `data`.
 */
import { describe, expect, it } from "vitest";
import {
	createFabric,
	FabricError,
	FabricForbiddenError,
	FabricNotFoundError,
} from "../src/index.js";

interface Captured {
	url: string;
	method: string;
	body: unknown;
}

function client(status: number, body: unknown) {
	const captured: Captured[] = [];
	const stub: typeof fetch = async (input, init) => {
		captured.push({
			url:
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url,
			method: init?.method ?? "GET",
			body: init?.body ? JSON.parse(init.body as string) : null,
		});
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	};
	return {
		fabric: createFabric({
			apiKey: "fab_test",
			baseUrl: "https://example.com",
			fetch: stub,
			retry: { maxRetries: 0 },
		}),
		captured,
	};
}

describe("memory", () => {
	it("reads the write folders", async () => {
		const { fabric, captured } = client(200, {
			data: { sync: null, targets: [] },
		});

		const targets = await fabric.memory.getTargets("proj 1");

		expect(targets).toEqual({ sync: null, targets: [] });
		expect(captured[0]?.url).toBe(
			"https://example.com/api/v1/projects/proj%201/memory/targets",
		);
	});

	it("pages a folder's files with the cursor and limit", async () => {
		const { fabric, captured } = client(200, {
			data: {
				targetId: "t",
				folder: "docs/ai",
				ref: "main",
				lastAppliedCommitSha: null,
				files: [],
				nextCursor: null,
			},
		});

		await fabric.memory.listFiles("p", {
			targetId: "t 1",
			after: "docs/ai/a.md",
			limit: 25,
		});

		const url = new URL(captured[0]?.url ?? "");
		expect(url.pathname).toBe("/api/v1/projects/p/memory/files");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			targetId: "t 1",
			after: "docs/ai/a.md",
			limit: "25",
		});
	});

	it("reads one file by folder and path", async () => {
		const { fabric, captured } = client(200, {
			data: { path: "docs/ai/a.md", content: "x" },
		});

		await fabric.memory.getFile("p", {
			targetId: "t",
			path: "docs/ai/a b.md",
		});

		const url = new URL(captured[0]?.url ?? "");
		expect(url.pathname).toBe("/api/v1/projects/p/memory/file");
		expect(url.searchParams.get("path")).toBe("docs/ai/a b.md");
	});

	it("asks for upload URLs by size and submits a write as a POST", async () => {
		const { fabric, captured } = client(202, {
			data: {
				writeId: "w1",
				status: "PENDING",
				digest: "d",
				deduplicated: false,
			},
		});

		await fabric.memory.createUploadUrls("p", [{ bytes: 10 }]);
		const submitted = await fabric.memory.submitWrite("p", {
			targetId: "t",
			message: "m",
			entries: [{ path: "docs/ai/a.md", op: "PUT", content: "x" }],
		});

		expect(
			captured.map((c) => [c.method, new URL(c.url).pathname]),
		).toEqual([
			["POST", "/api/v1/projects/p/memory/upload-urls"],
			["POST", "/api/v1/projects/p/memory/writes"],
		]);
		expect(captured[0]?.body).toEqual({ files: [{ bytes: 10 }] });
		expect(captured[1]?.body).toEqual({
			targetId: "t",
			message: "m",
			entries: [{ path: "docs/ai/a.md", op: "PUT", content: "x" }],
		});
		expect(submitted.writeId).toBe("w1");
	});

	it("keeps the problems of a refused write in the error's data", async () => {
		const { fabric } = client(400, {
			error: {
				message: "This write cannot be admitted.",
				code: "MEMORY_WRITE_REFUSED",
				data: {
					problems: [
						{ path: "docs/ai/a.md", code: "SECRET_DETECTED" },
					],
				},
			},
		});

		const error = await fabric.memory
			.submitWrite("p", {
				targetId: "t",
				message: "m",
				entries: [{ path: "a", op: "DELETE", ifMatchOid: "x" }],
			})
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(FabricError);
		expect((error as FabricError).status).toBe(400);
		expect((error as FabricError).code).toBe("MEMORY_WRITE_REFUSED");
		expect((error as FabricError).data).toEqual({
			problems: [{ path: "docs/ai/a.md", code: "SECRET_DETECTED" }],
		});
	});

	it("keeps the pending cap in data on a 429", async () => {
		const { fabric } = client(429, {
			error: {
				message: "Wait.",
				code: "TOO_MANY_PENDING_WRITES",
				data: { limit: 5 },
			},
		});

		const error = await fabric.memory
			.submitWrite("p", { targetId: "t", message: "m", entries: [] })
			.catch((e: unknown) => e);

		expect((error as FabricError).status).toBe(429);
		expect((error as FabricError).data).toEqual({ limit: 5 });
	});

	it("reads a receipt, and tells a missing one from a refused scope", async () => {
		const found = client(200, {
			data: { writeId: "w1", status: "PENDING", outcome: null },
		});
		expect((await found.fabric.memory.getWrite("p", "w 1")).writeId).toBe(
			"w1",
		);
		expect(new URL(found.captured[0]?.url ?? "").pathname).toBe(
			"/api/v1/projects/p/memory/writes/w%201",
		);

		const missing = client(404, { error: { message: "Write not found" } });
		await expect(
			missing.fabric.memory.getWrite("p", "nope"),
		).rejects.toBeInstanceOf(FabricNotFoundError);

		const scope = client(403, {
			error: "Missing required scope: memory:write",
		});
		const refused = await scope.fabric.memory
			.getTargets("p")
			.catch((e: unknown) => e);
		expect(refused).toBeInstanceOf(FabricForbiddenError);
		expect((refused as FabricForbiddenError).code).toBe("MISSING_SCOPE");
	});
});
