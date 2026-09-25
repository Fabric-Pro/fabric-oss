import { SNAPSHOT_LIMITS } from "@repo/instructions";
import { describe, expect, it } from "vitest";
import {
	cloneDirectoryName,
	configureErrorMessage,
	type LocalSetupRoute,
	latestSyncRunChanged,
	localSetupRouteFor,
	offersSyncFromRepository,
	offersSyncNow,
	quoteShellArgIfNeeded,
	REPOSITORY_SYNC_IDLE_POLL_MS,
	type RepositorySyncConfiguration,
	type RepositorySyncState,
	repositorySyncPollInterval,
	type SyncRunView,
	shortCommit,
	syncErrorMessage,
	syncNowResultMessage,
	syncOutcomeMessage,
	syncRunEnded,
	syncRunOutcome,
	triggerLabelKey,
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
		repositoryUrl: "https://github.com/example-org/instructions.git",
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
		fromCurrentConfiguration: true,
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

describe("automatic sync copy (§7.3, PR 2)", () => {
	it.each([
		["MANUAL", "triggers.MANUAL"],
		["POLL", "triggers.POLL"],
		["WEBHOOK", "triggers.WEBHOOK"],
		// Fizzy #2563: a merged suggestion's pull request starts its own run.
		["PULL_REQUEST_MERGED", "triggers.PULL_REQUEST_MERGED"],
	] as const)("labels a %s run with %s", (trigger, key) => {
		expect(triggerLabelKey(trigger)).toBe(key);
	});

	it("labels a trigger this build does not know with the generic label instead of throwing (Decision 47)", () => {
		// A value a later migration might add to the enum.
		expect(triggerLabelKey("FUTURE_AUTOMATIC_TRIGGER")).toBe(
			"triggers.OTHER",
		);
	});

	it("says a failed fetch is being retried only while automatic sync is on and not paused", () => {
		const base = { ref: "main", rootPath: "agents" };
		expect(
			syncErrorMessage("CLONE_FAILED", {
				...base,
				automatic: true,
				automaticPausedReason: null,
			}),
		).toEqual({ key: "errors.CLONE_FAILED_RETRYING" });
		expect(
			syncErrorMessage("CLONE_FAILED", {
				...base,
				automatic: false,
				automaticPausedReason: null,
			}),
		).toEqual({ key: "errors.CLONE_FAILED" });
		expect(
			syncErrorMessage("CLONE_FAILED", {
				...base,
				automatic: true,
				automaticPausedReason: "PERMISSION_REVOKED",
			}),
		).toEqual({ key: "errors.CLONE_FAILED" });
		expect(syncErrorMessage("CLONE_FAILED", null)).toEqual({
			key: "errors.CLONE_FAILED",
		});
	});
});

describe("idle discovery of automatic runs (Decision 39)", () => {
	const automatic = { automatic: true, automaticPausedReason: null };

	it("reads an idle automatic sync every 60 s, and an open run every 3 s", () => {
		expect(REPOSITORY_SYNC_IDLE_POLL_MS).toBe(60_000);
		expect(
			repositorySyncPollInterval({
				running: false,
				configured: automatic,
			}),
		).toBe(60_000);
		expect(
			repositorySyncPollInterval({
				running: true,
				configured: automatic,
			}),
		).toBe(3_000);
	});

	it("does not poll an idle sync that is manual, paused or not configured", () => {
		expect(
			repositorySyncPollInterval({
				running: false,
				configured: { ...automatic, automatic: false },
			}),
		).toBe(false);
		expect(
			repositorySyncPollInterval({
				running: false,
				configured: {
					...automatic,
					automaticPausedReason: "REF_MISSING",
				},
			}),
		).toBe(false);
		expect(
			repositorySyncPollInterval({ running: false, configured: null }),
		).toBe(false);
		expect(repositorySyncPollInterval(undefined)).toBe(false);
	});

	it("reports a new latest run only once both ids are known", () => {
		expect(latestSyncRunChanged("sync_1:run_a", "sync_1:run_b")).toBe(true);
		// The first run of a sync that had none.
		expect(latestSyncRunChanged(null, "sync_1:run_a")).toBe(true);
		expect(latestSyncRunChanged("sync_1:run_a", "sync_1:run_a")).toBe(
			false,
		);
		// Not loaded yet: the first read is never a change.
		expect(latestSyncRunChanged(undefined, "sync_1:run_a")).toBe(false);
		expect(latestSyncRunChanged("sync_1:run_a", undefined)).toBe(false);
	});
});

describe("cloneDirectoryName (Fizzy #2721)", () => {
	it("takes the last path segment and drops a trailing .git", () => {
		expect(
			cloneDirectoryName(
				"https://github.com/example-org/instructions.git",
			),
		).toBe("instructions");
		expect(
			cloneDirectoryName("https://github.com/example-org/instructions"),
		).toBe("instructions");
	});

	it("ignores a trailing slash", () => {
		expect(
			cloneDirectoryName(
				"https://github.com/example-org/instructions.git/",
			),
		).toBe("instructions");
	});

	it("returns null when the URL has no usable segment", () => {
		expect(cloneDirectoryName("")).toBeNull();
		expect(cloneDirectoryName("   ")).toBeNull();
		expect(cloneDirectoryName("https://github.com/")).toBeNull();
		expect(cloneDirectoryName("https://github.com/.git")).toBeNull();
	});
});

describe("quoteShellArgIfNeeded (Fizzy #2721)", () => {
	it("returns a plain path unchanged", () => {
		expect(quoteShellArgIfNeeded("instructions")).toBe("instructions");
		expect(quoteShellArgIfNeeded("instructions/agents")).toBe(
			"instructions/agents",
		);
	});

	it("single-quotes a path with whitespace or a shell metacharacter", () => {
		expect(quoteShellArgIfNeeded("my project")).toBe("'my project'");
		expect(quoteShellArgIfNeeded("agents$HOME")).toBe("'agents$HOME'");
		expect(quoteShellArgIfNeeded("agents;rm")).toBe("'agents;rm'");
	});

	it("escapes an embedded single quote as '\\''", () => {
		expect(quoteShellArgIfNeeded("agent's rules")).toBe(
			"'agent'\\''s rules'",
		);
	});
});

describe("localSetupRouteFor (Fizzy #2721)", () => {
	const configured: RepositorySyncConfiguration = {
		syncId: "sync_1",
		repositoryIntegrationId: "int_1",
		provider: "GITHUB",
		repositoryOwner: "example-org",
		repositoryName: "instructions",
		repositoryUrl: "https://github.com/example-org/instructions.git",
		integrationStatus: "ACTIVE",
		ref: "main",
		rootPath: "agents",
		automatic: false,
		automaticPausedReason: null,
		automaticPausedAt: null,
		delegateName: "Example Member",
	};

	it("returns null while a repository project's settings have not been confirmed yet", () => {
		expect(
			localSetupRouteFor({
				repositoryBacked: true,
				repositoryConfirmed: false,
				configured,
			}),
		).toBeNull();
	});

	it("offers the upload route for an upload project", () => {
		const route = localSetupRouteFor({
			repositoryBacked: false,
			repositoryConfirmed: false,
			configured: null,
		});
		expect(route).toEqual<LocalSetupRoute>({ kind: "upload" });
	});

	it("offers the repository route once a sync names a repository", () => {
		const route = localSetupRouteFor({
			repositoryBacked: true,
			repositoryConfirmed: true,
			configured,
		});
		expect(route).toEqual<LocalSetupRoute>({
			kind: "repository",
			cloneUrl: "https://github.com/example-org/instructions.git",
			directory: "instructions",
			ref: "main",
			rootPath: "agents",
		});
	});

	it("falls back to the repository's own name when the URL has no usable segment", () => {
		const route = localSetupRouteFor({
			repositoryBacked: true,
			repositoryConfirmed: true,
			configured: {
				...configured,
				repositoryUrl: "https://github.com/",
			},
		});
		expect(route).toMatchObject({ directory: "instructions" });
	});

	it("normalises an empty, '.' or '/' rootPath to null", () => {
		for (const rootPath of ["", ".", "/", "  "]) {
			const route = localSetupRouteFor({
				repositoryBacked: true,
				repositoryConfirmed: true,
				configured: { ...configured, rootPath },
			});
			expect(route).toMatchObject({ rootPath: null });
		}
	});

	it("strips leading and trailing slashes from a real rootPath", () => {
		const route = localSetupRouteFor({
			repositoryBacked: true,
			repositoryConfirmed: true,
			configured: { ...configured, rootPath: "/agents/" },
		});
		expect(route).toMatchObject({ rootPath: "agents" });
	});

	it("returns null for a repository project with no configured sync", () => {
		expect(
			localSetupRouteFor({
				repositoryBacked: true,
				repositoryConfirmed: true,
				configured: null,
			}),
		).toBeNull();
	});

	it("returns null for a repository project whose sync carries no clone URL", () => {
		expect(
			localSetupRouteFor({
				repositoryBacked: true,
				repositoryConfirmed: true,
				configured: { ...configured, repositoryUrl: "" },
			}),
		).toBeNull();
	});

	it("offers the repository route for GITHUB and GITLAB", () => {
		for (const provider of ["GITHUB", "GITLAB"]) {
			expect(
				localSetupRouteFor({
					repositoryBacked: true,
					repositoryConfirmed: true,
					configured: { ...configured, provider },
				}),
			).toMatchObject({ kind: "repository" });
		}
	});

	it("returns null for AZURE_DEVOPS: the CLI classifies it as unsupported and refuses init", () => {
		expect(
			localSetupRouteFor({
				repositoryBacked: true,
				repositoryConfirmed: true,
				configured: { ...configured, provider: "AZURE_DEVOPS" },
			}),
		).toBeNull();
	});

	it("returns null for a provider string this build does not recognise", () => {
		expect(
			localSetupRouteFor({
				repositoryBacked: true,
				repositoryConfirmed: true,
				configured: { ...configured, provider: "BITBUCKET" },
			}),
		).toBeNull();
	});

	it("offers the route when the derived directory starts with a dash", () => {
		const route = localSetupRouteFor({
			repositoryBacked: true,
			repositoryConfirmed: true,
			configured: {
				...configured,
				repositoryUrl: "https://github.com/example-org/-rules.git",
			},
		});
		// A leading `-` is not rejected here — the dialog's `--` terminators
		// are what make it safe to paste, not this check.
		expect(route).toMatchObject({ directory: "-rules" });
	});

	// `cloneDirectoryName` reads a URL's normalised `pathname`, so a literal
	// `.` or `..` path segment can never survive to become its own return
	// value — the platform `URL` parser removes dot segments before this
	// code ever sees them. The real source of an empty/`.`/`..` directory is
	// the defensive `repositoryName` FALLBACK (used only when the URL has no
	// usable segment at all, e.g. a bare host with nothing after it), so
	// these three hold `repositoryUrl` at that shape and vary `repositoryName`.
	it.each(["", ".", ".."])(
		"returns null when the repositoryName fallback is %j",
		(repositoryName) => {
			expect(
				localSetupRouteFor({
					repositoryBacked: true,
					repositoryConfirmed: true,
					configured: {
						...configured,
						repositoryUrl: "https://github.com/",
						repositoryName,
					},
				}),
			).toBeNull();
		},
	);

	it("returns null when rootPath is exactly '..'", () => {
		expect(
			localSetupRouteFor({
				repositoryBacked: true,
				repositoryConfirmed: true,
				configured: { ...configured, rootPath: ".." },
			}),
		).toBeNull();
	});

	it("returns null when rootPath contains a '..' segment", () => {
		expect(
			localSetupRouteFor({
				repositoryBacked: true,
				repositoryConfirmed: true,
				configured: { ...configured, rootPath: "agents/../etc" },
			}),
		).toBeNull();
	});
});
