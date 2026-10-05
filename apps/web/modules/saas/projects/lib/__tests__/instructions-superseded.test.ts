import { describe, expect, it } from "vitest";
import type { InstructionsSnapshot } from "../instructions-snapshot";
import { supersededEdit } from "../instructions-superseded";

function snapshot(
	over: Partial<InstructionsSnapshot> = {},
): InstructionsSnapshot {
	return {
		id: "s9",
		version: 9,
		status: "READY",
		source: "UPLOAD",
		fileCount: 2,
		excludedCount: 0,
		createdAt: new Date(),
		baseVersion: 7,
		baseSnapshotId: "s7",
		publishedAt: null,
		...over,
	};
}

const PUBLISHED = snapshot({
	id: "s8",
	version: 8,
	baseVersion: null,
	baseSnapshotId: null,
});

describe("an edit that passed its checks but was not published", () => {
	it("names the edit and the version it was made from", () => {
		expect(
			supersededEdit({
				newest: snapshot(),
				published: PUBLISHED,
				newerThanPublished: true,
			}),
		).toEqual({ version: 9, baseVersion: 7 });
	});

	it("is not a rollback: a version that held the pointer before was published, then replaced on purpose", () => {
		expect(
			supersededEdit({
				newest: snapshot({ publishedAt: new Date() }),
				published: PUBLISHED,
				newerThanPublished: true,
			}),
		).toBeNull();
	});

	it("is not an upload, which has no version it was edited from", () => {
		expect(
			supersededEdit({
				newest: snapshot({ baseVersion: null, baseSnapshotId: null }),
				published: PUBLISHED,
				newerThanPublished: true,
			}),
		).toBeNull();
	});

	it("is not an edit made from the version that is published now", () => {
		expect(
			supersededEdit({
				newest: snapshot({ baseSnapshotId: "s8" }),
				published: PUBLISHED,
				newerThanPublished: true,
			}),
		).toBeNull();
	});

	it("is not an edit that meant to wait for someone to publish it", () => {
		expect(
			supersededEdit({
				newest: snapshot({ publishOnReady: false }),
				published: PUBLISHED,
				newerThanPublished: true,
			}),
		).toBeNull();
	});

	it("is only about a version that is ready and newer than the published one", () => {
		expect(
			supersededEdit({
				newest: snapshot({ status: "VALIDATING" }),
				published: PUBLISHED,
				newerThanPublished: true,
			}),
		).toBeNull();
		expect(
			supersededEdit({
				newest: snapshot(),
				published: PUBLISHED,
				newerThanPublished: false,
			}),
		).toBeNull();
		expect(
			supersededEdit({
				newest: null,
				published: PUBLISHED,
				newerThanPublished: true,
			}),
		).toBeNull();
	});
});
