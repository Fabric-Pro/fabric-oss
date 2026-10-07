/**
 * Tests for `upsertUrlPageActivity`.
 *
 * Covers spec §7.1 hash-match skip-on-unchanged path and §7.1 manual-resync
 * override (re-embed when the user explicitly asked), and the page a failed
 * fetch marked FAILED that a later unchanged fetch completes again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/prisma/client", () => ({
	db: {
		projectContextUrlPage: {
			findFirst: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn(),
		},
	},
}));

vi.mock("../../src/activities/lib/activity-logger", () => ({
	activityLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { createHash } from "node:crypto";
import { URL_PAGE_FETCH_FAILURE_PREFIX } from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { upsertUrlPageActivity } from "../../src/activities/url-source/upsert-url-page-activity";

const mockFindFirst = db.projectContextUrlPage.findFirst as ReturnType<
	typeof vi.fn
>;
const mockCreate = db.projectContextUrlPage.create as ReturnType<typeof vi.fn>;
const mockUpdate = db.projectContextUrlPage.update as ReturnType<typeof vi.fn>;
const mockUpdateMany = db.projectContextUrlPage.updateMany as ReturnType<
	typeof vi.fn
>;

const baseInput = {
	parentContextId: "ctx-1",
	projectId: "proj-1",
	pageUrl: "https://example.com/page-a",
	pageTitle: "Page A",
	content: "# Hello world",
	userId: "user-1",
	organizationId: null,
	mode: "initial" as const,
};

describe("upsertUrlPageActivity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// No page a failed fetch marked: the restore matches nothing.
		mockUpdateMany.mockResolvedValue({ count: 0 });
	});

	it("creates a new row when the page is first-seen", async () => {
		mockFindFirst.mockResolvedValue(null);
		mockCreate.mockResolvedValue({ id: "page-1" });

		const result = await upsertUrlPageActivity(baseInput);

		expect(result.skipped).toBe(false);
		expect(result.reason).toBe("first-write");
		expect(result.pageId).toBe("page-1");
		expect(mockCreate).toHaveBeenCalledOnce();
		expect(mockCreate.mock.calls[0][0].data.parentContextId).toBe("ctx-1");
		expect(mockCreate.mock.calls[0][0].data.contentHash).toMatch(
			/^[a-f0-9]{64}$/,
		);
	});

	it("skips embedding when hash matches and mode is initial", async () => {
		// Compute the hash the activity will compute, so the mocked existing
		// row matches.
		const { createHash } = await import("node:crypto");
		const knownHash = createHash("sha256")
			.update(baseInput.content, "utf8")
			.digest("hex");

		mockFindFirst.mockResolvedValue({
			id: "page-1",
			contentHash: knownHash,
		});
		mockUpdate.mockResolvedValue({});

		const result = await upsertUrlPageActivity({
			...baseInput,
			mode: "initial",
		});

		expect(result.skipped).toBe(true);
		expect(result.reason).toBe("hash-unchanged");
		expect(mockCreate).not.toHaveBeenCalled();
		expect(mockUpdate).toHaveBeenCalledOnce();
		// Should only bump fetched-at + headers, NOT overwrite content.
		const updateData = mockUpdate.mock.calls[0][0].data;
		expect(updateData.content).toBeUndefined();
		expect(updateData.contentHash).toBeUndefined();
		expect(updateData.lastFetchedAt).toBeInstanceOf(Date);
	});

	it("re-embeds (skipped=false) when mode is manual-resync, even on hash match", async () => {
		const { createHash } = await import("node:crypto");
		const knownHash = createHash("sha256")
			.update(baseInput.content, "utf8")
			.digest("hex");

		mockFindFirst.mockResolvedValue({
			id: "page-1",
			contentHash: knownHash,
		});
		mockUpdate.mockResolvedValue({});

		const result = await upsertUrlPageActivity({
			...baseInput,
			mode: "manual-resync",
		});

		expect(result.skipped).toBe(false);
		expect(mockUpdate).toHaveBeenCalledOnce();

		// manual-resync now FORCES a content overwrite even when hashes
		// match — the user clicking "Re-sync now" is authoritative intent,
		// and we saw rows that drifted from the live page survive deploys
		// because the hash short-circuit treated them as unchanged. The
		// content + contentHash + extractionStatus fields MUST be in the
		// update payload so a downstream embed activity picks up the row.
		const updateData = mockUpdate.mock.calls[0][0].data;
		expect(updateData.content).toBe(baseInput.content);
		expect(updateData.contentHash).toBe(knownHash);
		expect(updateData.extractionStatus).toBe("PENDING");
	});

	it("re-embeds (skipped=false) and overwrites content when hash changed", async () => {
		mockFindFirst.mockResolvedValue({
			id: "page-1",
			contentHash: "old-hash-12345",
		});
		mockUpdate.mockResolvedValue({});

		const result = await upsertUrlPageActivity({
			...baseInput,
			mode: "initial",
		});

		expect(result.skipped).toBe(false);
		const updateData = mockUpdate.mock.calls[0][0].data;
		expect(updateData.content).toBe(baseInput.content);
		expect(updateData.contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(updateData.extractionStatus).toBe("PENDING");
	});
});

type Row = Record<string, unknown>;

/** Equality, `null`, `not: null` and `startsWith` — what the writes use. */
function matches(row: Row, where: Row): boolean {
	return Object.entries(where).every(([key, condition]) => {
		const value = row[key] ?? null;
		if (condition === null) {
			return value === null;
		}
		if (typeof condition === "object" && !(condition instanceof Date)) {
			const c = condition as Row;
			if ("not" in c) {
				return value !== c.not;
			}
			if ("startsWith" in c) {
				return (
					typeof value === "string" &&
					value.startsWith(c.startsWith as string)
				);
			}
			throw new Error(`Unsupported condition on ${key}`);
		}
		return value === condition;
	});
}

/**
 * A page a crawl could not fetch keeps its content and vectors and is marked
 * FAILED with a message that starts with `URL_PAGE_FETCH_FAILURE_PREFIX`. A
 * later fetch of the same content completes it again without an embed, or
 * queues it for one when it holds no vectors; any other page that is not
 * COMPLETED keeps its status. The row lives in memory
 * and every write is applied through its WHERE, so a write that skipped a
 * condition would change a row it must not.
 */
describe("upsertUrlPageActivity on a page a failed fetch marked", () => {
	const EMBEDDED_AT = new Date("2026-10-01T08:01:00.000Z");
	const FETCH_FAILURE = `${URL_PAGE_FETCH_FAILURE_PREFIX}Firecrawl timed out`;
	const hashOf = (content: string) =>
		createHash("sha256").update(content, "utf8").digest("hex");
	let row: Row;

	beforeEach(() => {
		vi.clearAllMocks();
		row = {
			id: "page-1",
			parentContextId: "ctx-1",
			pageUrl: baseInput.pageUrl,
			content: baseInput.content,
			contentHash: hashOf(baseInput.content),
			extractionStatus: "FAILED",
			extractionError: FETCH_FAILURE,
			embeddedAt: EMBEDDED_AT,
			qdrantId: "point-1",
			chunkCount: 3,
		};
		mockFindFirst.mockImplementation(async ({ where }: { where: Row }) =>
			matches(row, where)
				? {
						id: row.id,
						contentHash: row.contentHash,
						extractionStatus: row.extractionStatus,
						extractionError: row.extractionError ?? null,
						embeddedAt: row.embeddedAt ?? null,
					}
				: null,
		);
		mockUpdate.mockImplementation(
			async ({ where, data }: { where: Row; data: Row }) => {
				if (!matches(row, where)) {
					throw new Error("No record was found for an update");
				}
				Object.assign(row, data);
				return { ...row };
			},
		);
		mockUpdateMany.mockImplementation(
			async ({ where, data }: { where: Row; data: Row }) => {
				if (!matches(row, where)) {
					return { count: 0 };
				}
				Object.assign(row, data);
				return { count: 1 };
			},
		);
	});

	it("completes it again on an unchanged fetch, keeping its vectors, without an embed", async () => {
		const result = await upsertUrlPageActivity({
			...baseInput,
			mode: "scheduled",
		});

		expect(result).toEqual({
			pageId: "page-1",
			contentHash: hashOf(baseInput.content),
			skipped: true,
			reason: "hash-unchanged",
		});
		expect(row).toMatchObject({
			extractionStatus: "COMPLETED",
			extractionError: null,
			content: baseInput.content,
			embeddedAt: EMBEDDED_AT,
			qdrantId: "point-1",
			chunkCount: 3,
		});
		expect(mockUpdateMany.mock.calls[0][0].where).toMatchObject({
			id: "page-1",
			parentContextId: "ctx-1",
		});
	});

	// A content change resets the page to PENDING; the embed of the new
	// content then failed, leaving the earlier version's vectors. The same
	// content fetched again must not read as indexed.
	it("leaves a page whose re-embed failed after a content change FAILED", async () => {
		row.extractionStatus = "COMPLETED";
		row.extractionError = null;
		const changed = await upsertUrlPageActivity({
			...baseInput,
			content: "# Hello again",
		});
		expect(changed.skipped).toBe(false);
		expect(row.extractionStatus).toBe("PENDING");
		Object.assign(row, {
			extractionStatus: "FAILED",
			extractionError: "Embedding provider timed out",
		});

		const result = await upsertUrlPageActivity({
			...baseInput,
			content: "# Hello again",
			mode: "scheduled",
		});

		expect(result.reason).toBe("hash-unchanged");
		expect(row).toMatchObject({
			extractionStatus: "FAILED",
			extractionError: "Embedding provider timed out",
			embeddedAt: EMBEDDED_AT,
		});
	});

	// Nothing indexed to restore, so the page is embedded instead. An empty
	// page is the plainest case: its embed writes no vectors, so a page marked
	// once would otherwise stay FAILED on every later fetch.
	it("queues the unchanged content of a marked page that holds no vectors for embedding", async () => {
		Object.assign(row, {
			content: "",
			contentHash: hashOf(""),
			embeddedAt: null,
			qdrantId: null,
			chunkCount: 0,
		});

		const result = await upsertUrlPageActivity({
			...baseInput,
			content: "",
			mode: "scheduled",
		});

		expect(result).toMatchObject({
			skipped: false,
			reason: "not-embedded",
		});
		expect(row).toMatchObject({
			extractionStatus: "PENDING",
			extractionError: null,
		});
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it("leaves a page that failed for another reason and holds no vectors FAILED", async () => {
		Object.assign(row, {
			embeddedAt: null,
			extractionError: "Embedding provider timed out",
		});

		const result = await upsertUrlPageActivity({
			...baseInput,
			mode: "scheduled",
		});

		expect(result.skipped).toBe(true);
		expect(row).toMatchObject({
			extractionStatus: "FAILED",
			extractionError: "Embedding provider timed out",
		});
	});

	it("leaves a PENDING page that holds vectors PENDING", async () => {
		Object.assign(row, {
			extractionStatus: "PENDING",
			extractionError: null,
		});

		await upsertUrlPageActivity({ ...baseInput, mode: "scheduled" });

		expect(row.extractionStatus).toBe("PENDING");
	});

	it("queues changed content for embedding, as for any page", async () => {
		const result = await upsertUrlPageActivity({
			...baseInput,
			content: "# Hello again",
			mode: "scheduled",
		});

		expect(result.skipped).toBe(false);
		expect(row).toMatchObject({
			content: "# Hello again",
			contentHash: hashOf("# Hello again"),
			extractionStatus: "PENDING",
			extractionError: null,
		});
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it("queues unchanged content for embedding on a manual re-sync", async () => {
		const result = await upsertUrlPageActivity({
			...baseInput,
			mode: "manual-resync",
		});

		expect(result.skipped).toBe(false);
		expect(row.extractionStatus).toBe("PENDING");
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});
});
