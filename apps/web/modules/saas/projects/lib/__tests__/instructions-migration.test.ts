import { describe, expect, it } from "vitest";
import {
	MIGRATION_POLL_MS,
	MIGRATION_SETTLED_POLL_MS,
	migrationActions,
	migrationCommandRefusal,
	migrationEndedNotice,
	migrationFailureKey,
	migrationPause,
	migrationPollInterval,
	moveRefusal,
	type RepositoryMigrationRead,
	type RepositoryMigrationView,
} from "../instructions-migration";

const REPOSITORY = "example-org/instructions";

function view(
	overrides: Partial<RepositoryMigrationView> = {},
): RepositoryMigrationView {
	return {
		state: "OPEN",
		closing: false,
		startedAt: "2026-10-02T10:00:00.000Z",
		startedByUserId: "user-1",
		snapshotId: "snap-1",
		branchId: "branch-1",
		syncId: "sync-1",
		pullRequest: {
			url: "https://example.com/pull/12",
			externalId: "12",
			state: "OPEN",
		},
		targetMismatch: false,
		failure: null,
		...overrides,
	};
}

const MERGED_ELSEWHERE = {
	state: "ABANDONED",
	targetMismatch: true,
	pullRequest: {
		url: "https://example.com/pull/12",
		externalId: "12",
		state: "MERGED",
	},
} as const;

const FLIPPED = {
	state: "BLOCKED",
	pullRequest: null,
	failure: { code: "SOURCE_FLIPPED", retryable: false },
} as const;

function read(
	migration: RepositoryMigrationView | null,
): RepositoryMigrationRead {
	return {
		migration,
		repository: migration
			? {
					provider: "GITHUB",
					owner: "example-org",
					name: "instructions",
					ref: "main",
					folder: "docs/instructions",
				}
			: null,
	};
}

describe("how often a move is read", () => {
	it.each([
		["PROPOSING", MIGRATION_POLL_MS],
		["MERGED", MIGRATION_POLL_MS],
		["SWITCHING", MIGRATION_POLL_MS],
		["OPEN", MIGRATION_SETTLED_POLL_MS],
		["BLOCKED", MIGRATION_SETTLED_POLL_MS],
		["ABANDONED", MIGRATION_POLL_MS],
	] as const)("reads a %s move every %d ms", (state, interval) => {
		expect(migrationPollInterval(read(view({ state })))).toBe(interval);
	});

	it("reads an open pull request quickly while its close is settling", () => {
		expect(
			migrationPollInterval(read(view({ state: "OPEN", closing: true }))),
		).toBe(MIGRATION_POLL_MS);
	});

	it("keeps asking while the first read has not arrived", () => {
		expect(migrationPollInterval(undefined)).toBe(MIGRATION_POLL_MS);
	});

	it("stops once nothing is moving", () => {
		expect(migrationPollInterval(read(null))).toBe(false);
	});
});

describe("what pauses the tab's changes, in a move's own state", () => {
	it("names the pull request that is open", () => {
		expect(migrationPause(view({ state: "OPEN" }))).toEqual({
			key: "migrationOpen",
			number: "12",
		});
	});

	it("says the pull request is being prepared while it is", () => {
		expect(
			migrationPause(view({ state: "PROPOSING", pullRequest: null })),
		).toEqual({ key: "migrationPreparing" });
	});

	it.each(["MERGED", "SWITCHING"] as const)(
		"says a %s move is switching the project over",
		(state) => {
			expect(migrationPause(view({ state }))).toEqual({
				key: "migrationSwitching",
			});
		},
	);

	it("says a stuck move is waiting on someone", () => {
		expect(
			migrationPause(
				view({
					state: "BLOCKED",
					pullRequest: null,
					failure: { code: "PUSH_REFUSED", retryable: true },
				}),
			),
		).toEqual({ key: "migrationBlocked" });
	});

	it("says a move whose pull request ended needs cancelling", () => {
		expect(
			migrationPause(
				view({
					state: "ABANDONED",
					pullRequest: {
						url: "https://example.com/pull/12",
						externalId: "12",
						state: "CLOSED",
					},
				}),
			),
		).toEqual({ key: "migrationEnded" });
	});

	it("says a pull request merged into another branch ended the move", () => {
		expect(migrationPause(view(MERGED_ELSEWHERE))).toEqual({
			key: "migrationMismatch",
		});
	});

	it("says a project switched behind the move's back needs switching to upload mode", () => {
		expect(migrationPause(view(FLIPPED))).toEqual({
			key: "migrationFlipped",
		});
	});

	it("says only that changes are paused before the move has been read", () => {
		expect(migrationPause(null)).toEqual({ key: "migrationPaused" });
	});
});

describe("the sentence for a blocked move", () => {
	it.each([
		["AUTHENTICATION_FAILED", "connection"],
		["PERMISSION_REVOKED", "connection"],
		["BRANCH_WRITE_REFUSED", "refused"],
		["PR_CREATION_REFUSED", "refused"],
		["TARGET_BRANCH_MISSING", "branchMissing"],
		["TREE_CONFLICT", "repositoryChanged"],
		["REMOTE_REF_CONFLICT", "repositoryChanged"],
		["ATTRIBUTION_REJECTED", "attribution"],
		["VALIDATION_REJECTED", "validation"],
		["PROVIDER_TEMPORARY", "temporary"],
		["SOURCE_FLIPPED", "sourceFlipped"],
		["UNEXPECTED", "generic"],
	])("words %s as %s", (code, key) => {
		expect(migrationFailureKey(code)).toBe(key);
	});

	it("is the generic sentence for a code this build has not heard of", () => {
		expect(migrationFailureKey("SOMETHING_NEW")).toBe("generic");
		expect(migrationFailureKey("constructor")).toBe("generic");
	});
});

describe("why canceling or retrying a move was refused", () => {
	it.each([
		"MIGRATION_MERGED",
		"MIGRATION_PREPARING",
		"MIGRATION_CHANGED",
		"MIGRATION_NOT_OPEN",
		"MIGRATION_NOT_RETRYABLE",
		"MIGRATION_SOURCE_FLIPPED",
	])("reads %s off the refusal", (reason) => {
		expect(
			migrationCommandRefusal({ code: "CONFLICT", data: { reason } }),
		).toBe(reason);
	});

	it.each([
		["another reason", { data: { reason: "SOMETHING_ELSE" } }],
		["no data", {}],
		["a plain Error", new Error("boom")],
		["null", null],
	])("is null for %s", (_label, error) => {
		expect(migrationCommandRefusal(error)).toBeNull();
	});
});

describe("why starting a move was refused", () => {
	function refused(reason: string, code = "CONFLICT") {
		return {
			code,
			data: { reason },
			message: "TEXT THAT MUST NOT BE SHOWN",
		};
	}

	it.each([
		["SYNC_CONFIGURED", "syncConfigured", null],
		["NOTHING_PUBLISHED", "nothingPublished", null],
		["NOT_UPLOAD_SOURCED", "notUploadSourced", null],
		["MIGRATION_CANCELED", "canceled", null],
		["ATTRIBUTION_REJECTED", "attribution", null],
	] as const)("words %s as %s", (reason, key, field) => {
		expect(moveRefusal(refused(reason), "docs")).toEqual({ key, field });
	});

	it("blames the folder when it already holds files", () => {
		expect(
			moveRefusal(refused("FOLDER_NOT_EMPTY"), "docs/instructions"),
		).toEqual({ key: "folderNotEmpty", field: "folder" });
	});

	it("says the repository root cannot be used when it has files in the way", () => {
		expect(moveRefusal(refused("FOLDER_NOT_EMPTY"), "")).toEqual({
			key: "folderNotEmptyRoot",
			field: "folder",
		});
	});

	it.each([
		["another reason", refused("SOMETHING_NEW")],
		["no data", { code: "CONFLICT" }],
		["a plain Error", new Error("boom")],
		["null", null],
	])("leaves %s to the other words", (_label, error) => {
		expect(moveRefusal(error, "docs")).toBeNull();
	});
});

describe("what a person may do about a move, in its own state", () => {
	const NONE = { cancel: false, retry: false, switchToUpload: false };

	it.each([
		[
			"preparing the pull request",
			view({ state: "PROPOSING" }),
			"PROPOSING",
			{ ...NONE, cancel: true },
		],
		[
			"a pull request awaiting its merge",
			view(),
			"PROPOSING",
			{ ...NONE, cancel: true },
		],
		[
			"a pull request being closed",
			view({ closing: true }),
			"PROPOSING",
			NONE,
		],
		[
			"a blocked move a retry can fix",
			view({
				state: "BLOCKED",
				failure: { code: "AUTHENTICATION_FAILED", retryable: true },
			}),
			"PROPOSING",
			{ cancel: true, retry: true, switchToUpload: true },
		],
		[
			"a blocked move no retry can fix",
			view({
				state: "BLOCKED",
				failure: { code: "TARGET_BRANCH_MISSING", retryable: false },
			}),
			"PROPOSING",
			{ cancel: true, retry: false, switchToUpload: true },
		],
		[
			"a project switched behind the move's back, whose only exit is upload mode",
			view(FLIPPED),
			"PROPOSING",
			{ cancel: false, retry: false, switchToUpload: true },
		],
		[
			"a pull request merged and settling",
			view({ state: "MERGED" }),
			"PROPOSING",
			NONE,
		],
		[
			"a pull request that ended",
			view({ state: "ABANDONED" }),
			"PROPOSING",
			{ ...NONE, cancel: true },
		],
		[
			"a pull request merged into another branch",
			view(MERGED_ELSEWHERE),
			"PROPOSING",
			{ ...NONE, cancel: true },
		],
		[
			"a project switching over",
			view({ state: "SWITCHING" }),
			"SWITCHING",
			{ ...NONE, switchToUpload: true },
		],
	] as const)("for %s", (_label, move, pointer, expected) => {
		expect(migrationActions(move, pointer)).toEqual(expected);
	});

	it("offers a project that is switching its way out before the move has been read", () => {
		expect(migrationActions(null, "SWITCHING")).toEqual({
			...NONE,
			switchToUpload: true,
		});
	});

	it("offers nothing for a move that has not been read and is not switching", () => {
		expect(migrationActions(null, "PROPOSING")).toEqual(NONE);
	});
});

describe("the notice a move that did not complete leaves behind", () => {
	it("says a pull request merged into another branch when it did", () => {
		expect(
			migrationEndedNotice(view(MERGED_ELSEWHERE), null, REPOSITORY),
		).toEqual({
			pullRequest: "12",
			repository: REPOSITORY,
			mergedElsewhere: true,
		});
	});

	it("is given once when a move whose pull request ended is gone", () => {
		expect(
			migrationEndedNotice(
				view({
					state: "ABANDONED",
					pullRequest: {
						url: "https://example.com/pull/12",
						externalId: "12",
						state: "CLOSED",
					},
				}),
				null,
				REPOSITORY,
			),
		).toEqual({ pullRequest: "12", repository: REPOSITORY });
	});

	it("is given when a move being canceled is gone", () => {
		expect(
			migrationEndedNotice(
				view({ state: "OPEN", closing: true }),
				null,
				REPOSITORY,
			),
		).toEqual({ pullRequest: "12", repository: REPOSITORY });
	});

	it("is not given for a move that completed", () => {
		expect(
			migrationEndedNotice(
				view({ state: "SWITCHING" }),
				null,
				REPOSITORY,
			),
		).toBeNull();
		expect(
			migrationEndedNotice(view({ state: "MERGED" }), null, REPOSITORY),
		).toBeNull();
	});

	it("is not given while the move is still there", () => {
		expect(
			migrationEndedNotice(
				view({ state: "ABANDONED" }),
				view(),
				REPOSITORY,
			),
		).toBeNull();
	});

	it("is not given when no move was seen", () => {
		expect(migrationEndedNotice(null, null, null)).toBeNull();
	});

	it("names no pull request or repository that was never known", () => {
		expect(
			migrationEndedNotice(
				view({ state: "ABANDONED", pullRequest: null }),
				null,
				null,
			),
		).toEqual({ pullRequest: null, repository: null });
	});
});
