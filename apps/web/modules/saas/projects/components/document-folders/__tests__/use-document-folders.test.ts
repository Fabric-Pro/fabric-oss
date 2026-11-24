/**
 * What a document folder's card says, worked out from the list row alone.
 *
 * Pinned: one state per folder with a fixed precedence; a folder just
 * connected reads as being read, and is polled quickly, until its first read
 * lands; a folder whose first read failed is not polled quickly; the list is
 * polled quickly for a while after an action asks for a read; folders
 * overlap by path within one drive, compared segment by segment and without
 * case; imported contexts are recognised by their provider.
 */

import { describe, expect, it } from "vitest";
import {
	type DocumentFolder,
	documentFolderPollInterval,
	documentFolderProvenance,
	folderPlace,
	folderRelation,
	folderState,
	isFolderBusy,
} from "../use-document-folders";

function folder(overrides: Partial<DocumentFolder> = {}): DocumentFolder {
	return {
		id: "folder-1",
		provider: "onedrive",
		name: "Plans",
		drivePath: "/Plans",
		siteName: null,
		libraryName: null,
		description: null,
		connectedAt: new Date("2026-11-01T10:00:00Z"),
		lastReadAt: new Date("2026-11-01T10:05:00Z"),
		reading: false,
		discoveryComplete: true,
		lastListingComplete: true,
		problemCode: null,
		pausedRemovalsCode: null,
		heldRemovalCount: null,
		nextReadAfter: null,
		counts: {
			found: 4,
			imported: 4,
			skipped: 0,
			failed: 0,
			excluded: 0,
			inProgress: 0,
		},
		...overrides,
	};
}

describe("folderState", () => {
	it("is up to date when nothing is pending", () => {
		expect(folderState(folder())).toEqual({ kind: "upToDate" });
	});

	it("puts a running read before every other state", () => {
		expect(
			folderState(
				folder({
					reading: true,
					problemCode: "RECONNECT",
					pausedRemovalsCode: "MASS_REMOVAL",
					heldRemovalCount: 12,
				}),
			),
		).toEqual({ kind: "reading" });
	});

	it("ranks a problem above throttling, held and paused removals", () => {
		expect(
			folderState(
				folder({
					problemCode: "NO_ACCESS",
					pausedRemovalsCode: "THROTTLED",
				}),
			),
		).toEqual({ kind: "problem", code: "NO_ACCESS" });
	});

	it("ranks throttling above held removals", () => {
		const nextReadAfter = new Date("2026-11-01T11:00:00Z");
		expect(
			folderState(
				folder({ pausedRemovalsCode: "THROTTLED", nextReadAfter }),
			),
		).toEqual({ kind: "throttled", nextReadAfter });
	});

	it("stays throttled when no next read time was given", () => {
		expect(
			folderState(
				folder({
					pausedRemovalsCode: "THROTTLED",
					nextReadAfter: null,
					lastListingComplete: true,
				}),
			),
		).toEqual({ kind: "throttled", nextReadAfter: null });
	});

	it("shows held removals with their count", () => {
		expect(
			folderState(
				folder({
					pausedRemovalsCode: "MASS_REMOVAL",
					heldRemovalCount: 14,
				}),
			),
		).toEqual({ kind: "held", count: 14 });
	});

	it("shows paused removals with their reason", () => {
		expect(
			folderState(folder({ pausedRemovalsCode: "TOO_LARGE" })),
		).toEqual({ kind: "paused", code: "TOO_LARGE" });
	});

	it("reads a folder that was never read as being read", () => {
		expect(
			folderState(
				folder({
					lastReadAt: null,
					discoveryComplete: false,
					counts: { ...folder().counts, found: 0, imported: 0 },
				}),
			),
		).toEqual({ kind: "reading" });
	});

	it("is importing, not up to date, while files wait after a read", () => {
		expect(
			folderState(
				folder({ counts: { ...folder().counts, inProgress: 3 } }),
			),
		).toEqual({ kind: "importing", count: 3 });
	});
});

describe("isFolderBusy", () => {
	it("is busy while reading, importing, or before the first read", () => {
		expect(isFolderBusy(folder({ reading: true }))).toBe(true);
		expect(
			isFolderBusy(
				folder({ counts: { ...folder().counts, inProgress: 1 } }),
			),
		).toBe(true);
		expect(isFolderBusy(folder({ lastReadAt: null }))).toBe(true);
		expect(isFolderBusy(folder())).toBe(false);
	});

	it("is not busy when the first read ended in a problem", () => {
		expect(
			isFolderBusy(
				folder({
					lastReadAt: null,
					discoveryComplete: false,
					problemCode: "SYNC_START_FAILED",
				}),
			),
		).toBe(false);
	});
});

describe("documentFolderPollInterval", () => {
	const now = Date.parse("2026-11-01T12:00:00Z");

	it("polls quickly while a folder is busy, slowly otherwise, and not at all with no folder", () => {
		expect(
			documentFolderPollInterval({
				folders: [folder({ reading: true })],
				fastUntil: 0,
				now,
			}),
		).toBe(5_000);
		expect(
			documentFolderPollInterval({
				folders: [folder()],
				fastUntil: 0,
				now,
			}),
		).toBe(60_000);
		expect(
			documentFolderPollInterval({ folders: [], fastUntil: 0, now }),
		).toBe(false);
	});

	it("polls quickly after an action asked for a read, until the window ends", () => {
		expect(
			documentFolderPollInterval({
				folders: [folder()],
				fastUntil: now + 30_000,
				now,
			}),
		).toBe(5_000);
		expect(
			documentFolderPollInterval({
				folders: [folder()],
				fastUntil: now + 30_000,
				now: now + 30_000,
			}),
		).toBe(60_000);
	});
});

describe("folderRelation", () => {
	const at = (drivePath: string | null, driveId = "drive-1") => ({
		driveId,
		drivePath,
	});

	it("tells inside, holds and same apart, ignoring case", () => {
		expect(folderRelation(at("/Plans/2026"), at("/plans"))).toBe("inside");
		expect(folderRelation(at("/Plans"), at("/PLANS/2026/Q1"))).toBe(
			"contains",
		);
		expect(folderRelation(at("/Plans"), at("/plans"))).toBe("same");
		expect(folderRelation(at("/"), at("/Plans"))).toBe("contains");
	});

	it("does not match a sibling that shares a prefix", () => {
		expect(folderRelation(at("/Sales 2"), at("/Sales"))).toBeNull();
	});

	it("never matches across drives or an unknown path", () => {
		expect(folderRelation(at("/Plans"), at("/Plans", "drive-2"))).toBe(
			null,
		);
		expect(folderRelation(at("/Plans"), at(null))).toBeNull();
	});
});

describe("folderPlace", () => {
	it("names OneDrive, and a SharePoint site with its library", () => {
		expect(folderPlace(folder())).toBe("OneDrive");
		expect(
			folderPlace(
				folder({
					provider: "sharepoint",
					siteName: "Marketing Team",
					libraryName: "Documents",
				}),
			),
		).toBe("SharePoint · Marketing Team · Documents");
		expect(
			folderPlace(
				folder({ provider: "sharepoint", libraryName: "Documents" }),
			),
		).toBe("SharePoint · Documents");
	});
});

describe("documentFolderProvenance", () => {
	it("recognises contexts imported from a document folder", () => {
		expect(
			documentFolderProvenance({ provider: "onedrive-documents" }),
		).toBe("onedrive");
		expect(
			documentFolderProvenance({ provider: "sharepoint-documents" }),
		).toBe("sharepoint");
	});

	it("leaves every other context alone", () => {
		expect(documentFolderProvenance({ provider: "onedrive-folder" })).toBe(
			null,
		);
		expect(documentFolderProvenance(null)).toBeNull();
		expect(documentFolderProvenance({})).toBeNull();
	});
});
