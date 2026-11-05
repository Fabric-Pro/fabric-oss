/**
 * One page of a requested scan: a handed-over file stops waiting, a file whose
 * start failed keeps waiting without holding the scan in a loop, and a full page
 * says where the next one starts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	clear: vi.fn(),
	start: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listLivingMemoryFilesSkippedAtFirstSync: mocks.list,
	clearLivingMemoryDecisionScanSkip: mocks.clear,
}));

vi.mock("../../lib/living-memory-decision-start", () => ({
	startLivingMemoryDecisionExtraction: mocks.start,
}));

import { scanLivingMemoryFirstSyncFilesActivity } from "../scan-first-sync-files";

const scope = { projectId: "p-1", organizationId: "org-1" };
const fileRow = (id: string) => ({ id, ...scope });

beforeEach(() => {
	vi.clearAllMocks();
	mocks.start.mockResolvedValue("started");
});

describe("scanLivingMemoryFirstSyncFilesActivity", () => {
	it("starts each file as a requested scan and stops it waiting", async () => {
		mocks.list.mockResolvedValue([fileRow("c-1"), fileRow("c-2")]);

		await expect(
			scanLivingMemoryFirstSyncFilesActivity(scope),
		).resolves.toEqual({ started: 2, failed: 0, nextAfterId: null });

		expect(mocks.start).toHaveBeenCalledWith({
			contextId: "c-1",
			scanRequested: true,
		});
		expect(mocks.clear).toHaveBeenCalledWith(fileRow("c-1"));
		expect(mocks.clear).toHaveBeenCalledWith(fileRow("c-2"));
	});

	it("keeps a file waiting when its start failed", async () => {
		mocks.list.mockResolvedValue([fileRow("c-1"), fileRow("c-2")]);
		mocks.start.mockResolvedValueOnce("failed");

		await expect(
			scanLivingMemoryFirstSyncFilesActivity(scope),
		).resolves.toEqual({ started: 1, failed: 1, nextAfterId: null });

		expect(mocks.clear).toHaveBeenCalledTimes(1);
		expect(mocks.clear).toHaveBeenCalledWith(fileRow("c-2"));
	});

	it("stops a file waiting when its version was already read", async () => {
		mocks.list.mockResolvedValue([fileRow("c-1")]);
		mocks.start.mockResolvedValue("already_extracted");

		await scanLivingMemoryFirstSyncFilesActivity(scope);

		expect(mocks.clear).toHaveBeenCalledWith(fileRow("c-1"));
	});

	it("names the next page's start after a full page, even past a failure", async () => {
		const page = Array.from({ length: 20 }, (_, index) =>
			fileRow(`c-${String(index).padStart(2, "0")}`),
		);
		mocks.list.mockResolvedValue(page);
		mocks.start.mockResolvedValue("failed");

		await expect(
			scanLivingMemoryFirstSyncFilesActivity({
				...scope,
				afterId: "c-a",
			}),
		).resolves.toEqual({ started: 0, failed: 20, nextAfterId: "c-19" });

		expect(mocks.list).toHaveBeenCalledWith({
			...scope,
			afterId: "c-a",
			limit: 20,
		});
	});
});
