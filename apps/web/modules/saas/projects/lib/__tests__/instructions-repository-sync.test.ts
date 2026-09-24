import { SNAPSHOT_LIMITS } from "@repo/instructions";
import { describe, expect, it } from "vitest";
import {
	configureErrorMessage,
	offersSyncFromRepository,
	offersSyncNow,
	type RepositorySyncState,
	repositorySyncPollInterval,
	type SyncRunView,
	shortCommit,
	syncErrorMessage,
	syncNowResultMessage,
	syncOutcomeMessage,
	syncRunEnded,
	syncRunOutcome,
} from "../instructions-repository-sync";

const IDLE: RepositorySyncState = {
	sourceOfTruth: "UPLOAD",
	canConfigure: true,
	running: false,
	configured: null,
	latestRun: null,
	availableIntegrations: [
		{
			id: "int_1",
			provider: "GITHUB",
			repositoryOwner: "example-org",
			repositoryName: "instructions",
			defaultBranch: "main",
		},
	],
};

const CONFIGURED: RepositorySyncState = {
	...IDLE,
	sourceOfTruth: "REPOSITORY",
	configured: {
		syncId: "sync_1",
		repositoryIntegrationId: "int_1",
		provider: "GITHUB",
		repositoryOwner: "example-org",
		repositoryName: "instructions",
		integrationStatus: "ACTIVE",
		ref: "main",
		rootPath: "agents",
		automatic: false,
		automaticPausedReason: null,
		automaticPausedAt: null,
		delegateName: "Example Member",
	},
};

function run(overrides: Partial<SyncRunView>): SyncRunView {
	return {
		id: "sync_1:run_a",
		trigger: "MANUAL",
		startedAt: "2026-09-23T10:00:00.000Z",
		finishedAt: "2026-09-23T10:01:00.000Z",
		status: "SUCCEEDED",
		error: null,
		note: null,
		commitSha: "0123456789abcdef0123456789abcdef01234567",
		snapshotId: "snap_1",
		snapshotVersion: 4,
		userName: "Example Member",
		...overrides,
	};
}

describe("which button the tab offers (§7.1)", () => {
	it("offers Sync from repository only to a configurer with an ACTIVE integration and nothing configured", () => {
		expect(offersSyncFromRepository(IDLE)).toBe(true);
		expect(
			offersSyncFromRepository({ ...IDLE, availableIntegrations: [] }),
		).toBe(false);
		expect(offersSyncFromRepository({ ...IDLE, canConfigure: false })).toBe(
			false,
		);
		expect(offersSyncFromRepository(CONFIGURED)).toBe(false);
	});

	it("offers Sync now to a configurer once configured, and never to a reader", () => {
		expect(offersSyncNow(CONFIGURED)).toBe(true);
		expect(offersSyncNow({ ...CONFIGURED, canConfigure: false })).toBe(
			false,
		);
		expect(offersSyncNow(IDLE)).toBe(false);
	});
});

describe("polling", () => {
	it("polls every 3 s while a run is open and not at all otherwise", () => {
		expect(repositorySyncPollInterval({ running: true })).toBe(3_000);
		expect(repositorySyncPollInterval({ running: false })).toBe(false);
		expect(repositorySyncPollInterval(undefined)).toBe(false);
	});

	it("reports the end of a run exactly on the running → idle transition", () => {
		expect(syncRunEnded(true, false)).toBe(true);
		expect(syncRunEnded(false, false)).toBe(false);
		expect(syncRunEnded(false, true)).toBe(false);
		expect(syncRunEnded(true, true)).toBe(false);
	});
});

describe("a run's outcome (§7.3)", () => {
	it.each([
		[run({}), false, { kind: "published", version: 4 }],
		[
			run({
				status: "UNCHANGED",
				snapshotId: null,
				snapshotVersion: null,
			}),
			false,
			{ kind: "unchanged" },
		],
		[
			run({ status: "NOT_PUBLISHED", error: "CONFIGURATION_CHANGED" }),
			false,
			{ kind: "not_published", reason: "configuration_changed" },
		],
		[
			run({ status: "NOT_PUBLISHED", error: "PERMISSION_DENIED" }),
			false,
			{ kind: "not_published", reason: "permission_revoked" },
		],
		[
			run({ status: "NOT_PUBLISHED", error: null }),
			false,
			{ kind: "not_published", reason: "older" },
		],
		[run({ status: "REJECTED" }), false, { kind: "rejected" }],
		[run({ status: "SKIPPED", error: null }), false, { kind: "skipped" }],
		[
			run({ status: "FAILED", error: "REF_MISSING" }),
			false,
			{ kind: "failed", error: "REF_MISSING" },
		],
		[run({ finishedAt: null, status: null }), true, { kind: "running" }],
		// Decision 24: an unfinished row with no workflow open was interrupted.
		[
			run({ finishedAt: null, status: null }),
			false,
			{ kind: "interrupted" },
		],
	])("%#", (row, running, expected) => {
		expect(syncRunOutcome(row, running)).toEqual(expected);
	});

	it("names each outcome by a key under the repositorySync namespace", () => {
		expect(syncOutcomeMessage({ kind: "published", version: 4 })).toEqual({
			key: "outcomes.published",
			values: { version: 4 },
		});
		expect(
			syncOutcomeMessage({ kind: "published", version: null }),
		).toEqual({
			key: "outcomes.publishedNoVersion",
		});
		expect(
			syncOutcomeMessage({
				kind: "not_published",
				reason: "configuration_changed",
			}),
		).toEqual({ key: "outcomes.notPublished.configuration_changed" });
	});
});

describe("a failed run's message (§7.3)", () => {
	const configuration = { ref: "main", rootPath: "agents" };

	it("names the branch for REF_MISSING and the folder for ROOT_MISSING", () => {
		expect(syncErrorMessage("REF_MISSING", configuration)).toEqual({
			key: "errors.REF_MISSING",
			values: { ref: "main" },
		});
		expect(syncErrorMessage("ROOT_MISSING", configuration)).toEqual({
			key: "errors.ROOT_MISSING",
			values: { ref: "main", rootPath: "agents" },
		});
	});

	it("states all three limits for LIMITS_EXCEEDED, since the run row carries no counts", () => {
		expect(syncErrorMessage("LIMITS_EXCEEDED", configuration)).toEqual({
			key: "errors.LIMITS_EXCEEDED",
			values: {
				maxFiles: SNAPSHOT_LIMITS.maxFiles.toLocaleString("en-US"),
				maxFileMb: Math.round(SNAPSHOT_LIMITS.maxFileBytes / 1_048_576),
				maxTotalMb: Math.round(
					SNAPSHOT_LIMITS.maxTotalBytes / 1_048_576,
				),
			},
		});
	});

	it("maps every other code to its own key, and no code to nothing", () => {
		expect(syncErrorMessage("CLONE_FAILED", configuration)).toEqual({
			key: "errors.CLONE_FAILED",
		});
		expect(syncErrorMessage(null, configuration)).toBeNull();
	});
});

describe("configure errors (§7.2: branch verification renders inline)", () => {
	const orpcError = (code: string) =>
		Object.assign(new Error(code), { data: { code } });

	it.each([
		["BRANCH_NOT_FOUND", true],
		["REPOSITORY_CREDENTIALS_EXPIRED", true],
		["REPOSITORY_UNAVAILABLE", true],
		["REPOSITORY_NOT_FOUND", true],
		["INVALID_ROOT_PATH", true],
		["REPOSITORY_UNREACHABLE", false],
	])("%s → inline %s", (code, inline) => {
		expect(configureErrorMessage(orpcError(code))).toEqual({
			key: `configureDialog.errors.${code}`,
			inline,
		});
	});

	it("falls back to a generic toast for anything else", () => {
		expect(configureErrorMessage(new Error("boom"))).toEqual({
			key: "configureDialog.errors.generic",
			inline: false,
		});
	});
});

describe("Sync now results", () => {
	it("announces a start, an already-running refusal and the two blocked states", () => {
		expect(syncNowResultMessage({ started: true })).toEqual({
			key: "syncNowResult.started",
			tone: "success",
		});
		expect(
			syncNowResultMessage({ started: false, reason: "already_running" }),
		).toEqual({
			key: "syncNowResult.already_running",
			tone: "info",
		});
		expect(
			syncNowResultMessage({
				started: false,
				reason: "integration_unavailable",
			}),
		).toEqual({
			key: "syncNowResult.integration_unavailable",
			tone: "error",
		});
	});

	it("shortens a commit to seven characters", () => {
		expect(shortCommit("0123456789abcdef")).toBe("0123456");
		expect(shortCommit(null)).toBeNull();
	});
});
