/**
 * Tests for `upsertUrlPageActivity`.
 *
 * Covers spec §7.1 hash-match skip-on-unchanged path and §7.1 manual-resync
 * override (re-embed when the user explicitly asked).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/prisma/client", () => ({
	db: {
		projectContextUrlPage: {
			findFirst: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
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

import { db } from "@repo/database/prisma/client";
import { upsertUrlPageActivity } from "../../src/activities/url-source/upsert-url-page-activity";

const mockFindFirst = db.projectContextUrlPage.findFirst as ReturnType<
	typeof vi.fn
>;
const mockCreate = db.projectContextUrlPage.create as ReturnType<typeof vi.fn>;
const mockUpdate = db.projectContextUrlPage.update as ReturnType<typeof vi.fn>;

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
