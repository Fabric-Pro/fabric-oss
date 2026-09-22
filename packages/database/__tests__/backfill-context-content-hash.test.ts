/**
 * `backfill-context-content-hash` — fills `ProjectContext.contentHash` for rows
 * written before every content write stamped one (Fizzy #2619).
 *
 * The client is an in-memory table, so each test sees what the job actually
 * leaves behind rather than the calls it made. What this pins:
 *  - every non-empty row with no hash gets exactly `hashContextContent`, in
 *    batches, with the cursor moving forward;
 *  - empty rows and rows that already carry a hash are not touched;
 *  - a row whose content changes between the read and the write is skipped,
 *    not stamped with a hash for content it no longer holds;
 *  - a second run finds nothing to do (resumable, idempotent);
 *  - a dry run counts and writes nothing.
 *
 * Run with: pnpm --filter @repo/database test -- __tests__/backfill-context-content-hash.test.ts
 */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma/client", () => ({ db: {} }));

import {
	backfillContextContentHash,
	type ContentHashBackfillClient,
} from "../scripts/backfill-context-content-hash";

type Row = { id: string; content: string; contentHash: string | null };

function sha256(text: string) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function isCandidate(row: Row) {
	return row.contentHash === null && row.content !== "";
}

/**
 * A table that honours exactly the filters the job sends, and asserts on
 * them, so a query that drifts from the one reviewed here fails the test.
 */
function fakeClient(
	rows: Row[],
	options: { beforeUpdate?: (id: string) => void } = {},
) {
	const findMany = vi.fn(
		async (args: {
			where: {
				contentHash: null;
				content: { not: string };
				id?: { gt: string };
			};
			select: { id: true; content: true };
			orderBy: { id: "asc" };
			take: number;
		}) => {
			expect(args.where.contentHash).toBeNull();
			expect(args.where.content).toEqual({ not: "" });
			expect(args.select).toEqual({ id: true, content: true });
			expect(args.orderBy).toEqual({ id: "asc" });
			const after = args.where.id?.gt;
			return rows
				.filter(isCandidate)
				.filter((row) => after === undefined || row.id > after)
				.sort((a, b) => (a.id < b.id ? -1 : 1))
				.slice(0, args.take)
				.map((row) => ({ id: row.id, content: row.content }));
		},
	);
	const updateMany = vi.fn(
		async (args: {
			where: { id: string; contentHash: null; content: string };
			data: { contentHash: string };
		}) => {
			options.beforeUpdate?.(args.where.id);
			const target = rows.find(
				(row) =>
					row.id === args.where.id &&
					row.contentHash === args.where.contentHash &&
					row.content === args.where.content,
			);
			if (!target) {
				return { count: 0 };
			}
			target.contentHash = args.data.contentHash;
			return { count: 1 };
		},
	);
	const count = vi.fn(async () => rows.filter(isCandidate).length);
	const client = {
		projectContext: { findMany, updateMany, count },
	} as unknown as ContentHashBackfillClient;
	return { client, findMany, updateMany };
}

const quiet = () => undefined;

describe("backfillContextContentHash", () => {
	it("hashes every unhashed non-empty row in id-cursor batches", async () => {
		const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({
			id: `ctx-${i}`,
			content: `body ${i}`,
			contentHash: null,
		}));
		const { client, findMany } = fakeClient(rows);

		const result = await backfillContextContentHash({
			apply: true,
			client,
			batchSize: 2,
			log: quiet,
		});

		expect(result).toEqual({ filled: 5, skipped: 0, remaining: 0 });
		for (const row of rows) {
			expect(row.contentHash).toBe(sha256(row.content));
		}
		// 2 + 2 + 1: the short last page ends the run without another read.
		expect(findMany).toHaveBeenCalledTimes(3);
		expect(findMany.mock.calls[0]?.[0].where.id).toBeUndefined();
		expect(findMany.mock.calls[1]?.[0].where.id).toEqual({ gt: "ctx-1" });
		expect(findMany.mock.calls[2]?.[0].where.id).toEqual({ gt: "ctx-3" });
		expect(findMany.mock.calls[0]?.[0].take).toBe(2);
	});

	it("leaves empty rows and already-hashed rows alone", async () => {
		const rows: Row[] = [
			{ id: "a", content: "", contentHash: null },
			{ id: "b", content: "kept", contentHash: "existing-hash" },
			{ id: "c", content: "fill me", contentHash: null },
		];
		const { client, updateMany } = fakeClient(rows);

		const result = await backfillContextContentHash({
			apply: true,
			client,
			log: quiet,
		});

		expect(result.filled).toBe(1);
		expect(rows[0]?.contentHash).toBeNull();
		expect(rows[1]?.contentHash).toBe("existing-hash");
		expect(rows[2]?.contentHash).toBe(sha256("fill me"));
		expect(updateMany).toHaveBeenCalledTimes(1);
	});

	it("skips a row whose content changed after it was read", async () => {
		const rows: Row[] = [
			{ id: "a", content: "original", contentHash: null },
			{ id: "b", content: "steady", contentHash: null },
		];
		const { client } = fakeClient(rows, {
			beforeUpdate: (id) => {
				if (id === "a" && rows[0]) {
					// An older writer replaced the content without a hash.
					rows[0].content = "replaced";
				}
			},
		});

		const result = await backfillContextContentHash({
			apply: true,
			client,
			log: quiet,
		});

		expect(result).toEqual({ filled: 1, skipped: 1, remaining: 1 });
		expect(rows[0]?.contentHash).toBeNull();
		expect(rows[1]?.contentHash).toBe(sha256("steady"));
	});

	it("does nothing on a second run", async () => {
		const rows: Row[] = [
			{ id: "a", content: "one", contentHash: null },
			{ id: "b", content: "two", contentHash: null },
		];
		const first = fakeClient(rows);
		await backfillContextContentHash({
			apply: true,
			client: first.client,
			log: quiet,
		});

		const second = fakeClient(rows);
		const result = await backfillContextContentHash({
			apply: true,
			client: second.client,
			log: quiet,
		});

		expect(result).toEqual({ filled: 0, skipped: 0, remaining: 0 });
		expect(second.updateMany).not.toHaveBeenCalled();
	});

	it("counts without writing on a dry run", async () => {
		const rows: Row[] = [
			{ id: "a", content: "one", contentHash: null },
			{ id: "b", content: "", contentHash: null },
		];
		const { client, findMany, updateMany } = fakeClient(rows);

		const result = await backfillContextContentHash({
			apply: false,
			client,
			log: quiet,
		});

		expect(result).toEqual({ filled: 1, skipped: 0, remaining: 1 });
		expect(findMany).not.toHaveBeenCalled();
		expect(updateMany).not.toHaveBeenCalled();
		expect(rows[0]?.contentHash).toBeNull();
	});
});
