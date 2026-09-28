/**
 * Glossy recipient logos (Fizzy #2589, KTD23) live in the attachments bucket
 * under `project-brand/{projectId}/recipient-brand/…` and have no
 * StoryAttachment row. The attachment orphan sweeps delete any object under
 * their prefix without such a row — so a recipient logo is only safe if no
 * sweep ever lists the brand prefix. These tests pin that: every prefix the
 * sweeps list is one that a brand key cannot start with.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listObjects: vi.fn(),
	deleteObjects: vi.fn(),
	deleteFile: vi.fn(),
	getFileMetadata: vi.fn(),
	findMany: vi.fn(),
	findUnique: vi.fn(),
}));

vi.mock("@repo/storage", () => ({
	listObjects: (...a: unknown[]) => mocks.listObjects(...a),
	deleteObjects: (...a: unknown[]) => mocks.deleteObjects(...a),
	deleteFile: (...a: unknown[]) => mocks.deleteFile(...a),
	getFileMetadata: (...a: unknown[]) => mocks.getFileMetadata(...a),
}));

vi.mock("@repo/database", () => ({
	db: {
		storyAttachment: {
			findMany: (...a: unknown[]) => mocks.findMany(...a),
			findUnique: (...a: unknown[]) => mocks.findUnique(...a),
		},
	},
}));

vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "project-contexts" } },
	},
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

import { sweepAttachmentFinalOrphansActivity } from "../attachment-final-orphan-sweep";
import { sweepAttachmentTempOrphansActivity } from "../attachment-temp-orphan-sweep";

const BRAND_KEYS = [
	"project-brand/p/recipient-brand/current/c1.png",
	"project-brand/p/recipient-brand/pending/t1.png",
];

function listedPrefixes(): string[] {
	return mocks.listObjects.mock.calls.map(
		(call) => (call[0] as { prefix: string }).prefix,
	);
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.listObjects.mockResolvedValue({
		objects: [],
		nextContinuationToken: undefined,
	});
	mocks.findMany.mockResolvedValue([]);
	mocks.deleteObjects.mockResolvedValue({ deleted: 0, errors: [] });
});

describe("attachment orphan sweeps never list the recipient brand prefix", () => {
	it("the final-orphan sweep lists only story-attachments/", async () => {
		await sweepAttachmentFinalOrphansActivity();

		const prefixes = listedPrefixes();
		expect(prefixes.length).toBeGreaterThan(0);
		expect(new Set(prefixes)).toEqual(new Set(["story-attachments/"]));
		for (const prefix of prefixes) {
			for (const key of BRAND_KEYS) {
				expect(key.startsWith(prefix)).toBe(false);
			}
		}
	});

	it("the temp-orphan sweep lists only story-attachments-tmp/", async () => {
		await sweepAttachmentTempOrphansActivity();

		const prefixes = listedPrefixes();
		expect(prefixes.length).toBeGreaterThan(0);
		expect(new Set(prefixes)).toEqual(new Set(["story-attachments-tmp/"]));
		for (const prefix of prefixes) {
			for (const key of BRAND_KEYS) {
				expect(key.startsWith(prefix)).toBe(false);
			}
		}
	});
});
