/**
 * Whether Fabric's published copy is what the last sync took.
 *
 * The answer is derived from what the server reports for a repository project
 * (`repository.sync.lastRun`: trigger, status, error, commit, finish time) and
 * the published row's commit. The rule that matters most is the negative one:
 * with no finished run for this configuration there is no claim to make, so a
 * status block built on this says nothing rather than guessing.
 */

import { describe, expect, it } from "vitest";
import { fabricCopyState } from "../instructions-copy-state";
import type {
	RepositorySyncState,
	SyncRunView,
} from "../instructions-repository-sync";

const COMMIT = "b".repeat(40);
const OTHER = "a".repeat(40);
const FINISHED = new Date("2026-10-02T14:03:00.000Z");

function run(overrides: Partial<SyncRunView> = {}): SyncRunView {
	return {
		id: "sync_1:run_a",
		trigger: "WEBHOOK",
		startedAt: new Date("2026-10-02T14:02:00.000Z"),
		finishedAt: FINISHED,
		status: "SUCCEEDED",
		error: null,
		note: null,
		commitSha: COMMIT,
		snapshotId: "snap_1",
		snapshotVersion: 12,
		userName: null,
		fromCurrentConfiguration: true,
		...overrides,
	};
}

function state(
	overrides: Partial<RepositorySyncState> = {},
): RepositorySyncState {
	return {
		sourceOfTruth: "REPOSITORY",
		canConfigure: true,
		running: false,
		configured: {
			syncId: "sync_1",
			repositoryIntegrationId: "int_1",
			provider: "GITHUB",
			repositoryOwner: "example-org",
			repositoryName: "instructions",
			repositoryUrl: "https://github.com/example-org/instructions.git",
			integrationStatus: "ACTIVE",
			ref: "main",
			rootPath: "",
			automatic: true,
			automaticPausedReason: null,
			automaticPausedAt: null,
			delegateName: "Example Member",
		},
		latestRun: run(),
		availableIntegrations: [],
		...overrides,
	};
}

describe("fabricCopyState", () => {
	it.each([
		["SUCCEEDED", { status: "SUCCEEDED" as const }],
		["UNCHANGED", { status: "UNCHANGED" as const }],
	])(
		"is current after a %s run of the published commit, and when it finished",
		(_label, overrides) => {
			expect(
				fabricCopyState(state({ latestRun: run(overrides) }), {
					sourceCommitSha: COMMIT,
				}),
			).toEqual({ kind: "current", syncedAt: FINISHED });
		},
	);

	it("does not call the copy current when the last run took a different commit than the one published", () => {
		expect(fabricCopyState(state(), { sourceCommitSha: OTHER })).toEqual({
			kind: "unknown",
		});
	});

	it.each([
		["no run has happened", { latestRun: null }],
		["nothing is configured", { configured: null }],
	] as const)("claims nothing when %s", (_label, overrides) => {
		expect(
			fabricCopyState(state(overrides), { sourceCommitSha: COMMIT }),
		).toEqual({ kind: "unknown" });
	});

	it("claims nothing while nothing is published, or the published version has no commit", () => {
		expect(fabricCopyState(state(), null)).toEqual({ kind: "unknown" });
		expect(fabricCopyState(state(), { sourceCommitSha: null })).toEqual({
			kind: "unknown",
		});
	});

	it("claims nothing while a run is still open, since it has not said anything yet", () => {
		expect(
			fabricCopyState(
				state({
					running: true,
					latestRun: run({ finishedAt: null, status: null }),
				}),
				{ sourceCommitSha: COMMIT },
			),
		).toEqual({ kind: "unknown" });
	});

	it("does not read a receipt of a sync that was switched off as this sync's", () => {
		expect(
			fabricCopyState(
				state({
					latestRun: run({
						status: "REJECTED",
						fromCurrentConfiguration: false,
					}),
				}),
				{ sourceCommitSha: COMMIT },
			),
		).toEqual({ kind: "unknown" });
	});

	it.each([
		["a REJECTED run", { status: "REJECTED" as const, commitSha: OTHER }],
		[
			"a run the tree rules turned away (TREE_REFUSED)",
			{
				status: "FAILED" as const,
				error: "TREE_REFUSED" as const,
				commitSha: OTHER,
			},
		],
	])("says the commit was refused after %s", (_label, overrides) => {
		expect(
			fabricCopyState(state({ latestRun: run(overrides) }), {
				sourceCommitSha: COMMIT,
			}),
		).toEqual({ kind: "refused", commit: OTHER, at: FINISHED });
	});

	it("says a refusal without a commit when the run recorded none", () => {
		expect(
			fabricCopyState(
				state({
					latestRun: run({
						status: "FAILED",
						error: "TREE_REFUSED",
						commitSha: null,
					}),
				}),
				{ sourceCommitSha: COMMIT },
			),
		).toEqual({ kind: "refused", commit: null, at: FINISHED });
	});

	it("carries the failure's own line when the last sync failed", () => {
		expect(
			fabricCopyState(
				state({
					latestRun: run({ status: "FAILED", error: "REF_MISSING" }),
				}),
				{ sourceCommitSha: COMMIT },
			),
		).toEqual({
			kind: "behind-error",
			message: { key: "errors.REF_MISSING", values: { ref: "main" } },
		});
	});

	it("claims nothing for a run that published nothing for a reason that says nothing about the branch", () => {
		expect(
			fabricCopyState(
				state({
					latestRun: run({
						status: "NOT_PUBLISHED",
						error: "CONFIGURATION_CHANGED",
					}),
				}),
				{ sourceCommitSha: COMMIT },
			),
		).toEqual({ kind: "unknown" });
	});
});
