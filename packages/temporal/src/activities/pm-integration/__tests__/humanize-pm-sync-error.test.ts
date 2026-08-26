import { describe, expect, it } from "vitest";
import { humanizePmSyncError } from "../humanize-pm-sync-error";

describe("humanizePmSyncError", () => {
	it("translates Atlassian 'cloud id isn't granted' into board-reselect guidance", () => {
		const raw =
			"Cloud id: f4f670d4-1357-4707-b25a-75abdbf714bf isn't explicitly granted by the user.";
		const out = humanizePmSyncError(raw);
		expect(out).toMatch(/re-select a board/i);
		expect(out).toMatch(/Settings → Project Management/i);
		// Original detail preserved for support.
		expect(out).toContain(raw);
	});

	it("matches the apostrophe-free 'isnt' variant too", () => {
		const raw = "cloud id abc isnt granted to this token";
		expect(humanizePmSyncError(raw)).toMatch(/re-select a board/i);
	});

	it("translates 'no accessible resources' into a reconnect hint", () => {
		const raw = "Request failed: no accessible resources for this token";
		const out = humanizePmSyncError(raw);
		expect(out).toMatch(/reconnect atlassian/i);
		expect(out).toContain(raw);
	});

	it("translates Jira CONTENT_LIMIT_EXCEEDED into the attachments hint", () => {
		const raw = "Error: CONTENT_LIMIT_EXCEEDED on field description";
		const out = humanizePmSyncError(raw);
		expect(out).toMatch(/image attachments/i);
		expect(out).toContain(raw);
	});

	it("passes unknown errors through unchanged", () => {
		const raw = "Some unrelated 500 internal server error";
		expect(humanizePmSyncError(raw)).toBe(raw);
	});

	it("handles empty input", () => {
		expect(humanizePmSyncError("")).toBe("");
	});

	it("does not match a benign mention of the word 'granted'", () => {
		const raw = "Permission granted successfully";
		expect(humanizePmSyncError(raw)).toBe(raw);
	});

	it("translates a deleted-card 404 into unlink guidance", () => {
		const raw = 'Resource not found: {"status":404,"error":"Not Found"}';
		const out = humanizePmSyncError(raw);
		expect(out).toMatch(/no longer exists/i);
		expect(out).toMatch(/Review Center/i);
		// Original detail preserved for support.
		expect(out).toContain(raw);
	});

	it("treats 'does not exist' / 'not found' as a missing card", () => {
		expect(humanizePmSyncError("Work item 42 does not exist")).toMatch(
			/no longer exists/i,
		);
		expect(humanizePmSyncError("Card not found")).toMatch(
			/no longer exists/i,
		);
	});

	it("does NOT treat a permission error as a missing card (veto)", () => {
		// "not found" alongside access-denied is a permission shape, not a
		// deleted card — the veto keeps it from being mislabeled as missing.
		const raw = "Work item not found: access denied (403)";
		expect(humanizePmSyncError(raw)).toBe(raw);
	});
});
