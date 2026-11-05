import type { FabricClient } from "@fabricorg/sdk";
import { describe, expect, it, vi } from "vitest";
import type { ContextLock } from "../src/lib/context-sync/lock.js";
import { findMissingOnServer } from "../src/lib/context-sync/missing-on-server.js";

const SHA = "a".repeat(64);

function lockOf(paths: string[], duplicates: string[] = []): ContextLock {
	return {
		version: 1,
		projectId: "project-1",
		pushedAt: "2026-09-20T10:00:00.000Z",
		files: Object.fromEntries([
			...paths.map((p) => [p, { sha256: SHA, contextId: `ctx-${p}` }]),
			...duplicates.map((p) => [
				p,
				{ sha256: SHA, state: "duplicate" as const },
			]),
		]),
	};
}

type Ask = FabricClient["contexts"]["findMissingSyncedFiles"];

function clientWith(findMissingSyncedFiles: Ask) {
	return { contexts: { findMissingSyncedFiles } };
}

describe("findMissingOnServer", () => {
	it("asks at most 500 paths per request and joins the answers", async () => {
		const paths = Array.from({ length: 501 }, (_, i) => `${i}.md`);
		const ask = vi
			.fn<Ask>()
			.mockResolvedValueOnce({ missing: ["0.md"] })
			.mockResolvedValueOnce({ missing: ["500.md"] });

		const missing = await findMissingOnServer({
			client: clientWith(ask),
			projectId: "project-1",
			org: "example-org",
			lock: lockOf(paths),
			unchanged: paths,
		});

		expect(missing).toEqual({
			paths: ["0.md", "500.md"],
			incomplete: false,
		});
		expect(ask).toHaveBeenCalledTimes(2);
		expect(ask.mock.calls[0]?.[1]).toHaveLength(500);
		expect(ask.mock.calls[1]).toEqual([
			"project-1",
			["500.md"],
			{ org: "example-org" },
		]);
	});

	it("does not ask about a duplicate, which has no row to lose", async () => {
		const ask = vi.fn<Ask>().mockResolvedValue({ missing: [] });

		await findMissingOnServer({
			client: clientWith(ask),
			projectId: "project-1",
			lock: lockOf(["a.md"], ["copy.md"]),
			unchanged: ["a.md", "copy.md"],
		});

		expect(ask.mock.calls[0]?.[1]).toEqual(["a.md"]);
	});

	it("makes no request with nothing to ask about", async () => {
		const ask = vi.fn<Ask>();

		const missing = await findMissingOnServer({
			client: clientWith(ask),
			projectId: "project-1",
			lock: null,
			unchanged: [],
		});

		expect(missing).toEqual({ paths: [], incomplete: false });
		expect(ask).not.toHaveBeenCalled();
	});

	it("keeps what it learned when a later request fails, and marks the answer incomplete", async () => {
		const paths = Array.from({ length: 501 }, (_, i) => `${i}.md`);
		const ask = vi
			.fn<Ask>()
			.mockResolvedValueOnce({ missing: ["0.md"] })
			.mockRejectedValueOnce(new Error("Too many requests"));

		const missing = await findMissingOnServer({
			client: clientWith(ask),
			projectId: "project-1",
			lock: lockOf(paths),
			unchanged: paths,
		});

		expect(missing).toEqual({ paths: ["0.md"], incomplete: true });
	});
});
