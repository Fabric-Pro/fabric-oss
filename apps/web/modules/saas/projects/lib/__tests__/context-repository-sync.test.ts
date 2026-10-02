import en from "@repo/i18n/translations/en.json";
import { describe, expect, it } from "vitest";
import {
	activeContextSyncIntegrations,
	CONTEXT_SYNC_IDLE_POLL_MS,
	CONTEXT_SYNC_INDEXING_POLL_BUDGET_MS,
	CONTEXT_SYNC_INDEXING_POLL_MS,
	CONTEXT_SYNC_MAX_PATHS,
	CONTEXT_SYNC_RUNNING_POLL_MS,
	type ContextSyncRunView,
	type ContextSyncState,
	contextSyncActionErrorMessage,
	contextSyncAttentionMessageKey,
	contextSyncAutomaticInput,
	contextSyncConfigureErrorMessage,
	contextSyncFailureMessage,
	contextSyncLastAppliedMessage,
	contextSyncLastAppliedSummary,
	contextSyncLatestRunChanged,
	contextSyncLatestRunFingerprint,
	contextSyncNowResultMessage,
	contextSyncPathValidationMessage,
	contextSyncPausedReason,
	contextSyncPollInterval,
	contextSyncProgress,
	contextSyncRunEnded,
	contextSyncTreeErrorMessage,
	contextSyncTriggerLabelKey,
	offersSyncFromRepository,
	offersSyncNow,
	shortCommit,
	showsLivingMemorySection,
	tallyContextDeleteOutcomes,
	validateContextSyncPathAddition,
} from "../context-repository-sync";

const IDLE: ContextSyncState = {
	canConfigure: true,
	running: false,
	configured: null,
	latestRun: null,
	lastAppliedRun: null,
	latestFinishedRun: null,
	managedCount: 0,
	awaitingIndexCount: 0,
	cleanupPending: 0,
	availableIntegrations: [
		{
			id: "int_1",
			provider: "GITHUB",
			repositoryOwner: "example-org",
			repositoryName: "memory",
			defaultBranch: "main",
			status: "ACTIVE",
		},
	],
};

const CONFIGURED: ContextSyncState = {
	...IDLE,
	configured: {
		syncId: "sync_1",
		repositoryIntegrationId: "int_1",
		ref: "main",
		paths: ["docs"],
		automatic: false,
		automaticPausedReason: null,
		automaticPausedAt: null,
		nextCheckAt: "2026-09-23T10:00:00.000Z",
		failureCount: 0,
		lastAppliedCommitSha: null,
		configuredByName: "Example Member",
		createdAt: "2026-09-23T10:00:00.000Z",
		updatedAt: "2026-09-23T10:00:00.000Z",
		integration: {
			provider: "GITHUB",
			repositoryOwner: "example-org",
			repositoryName: "memory",
			status: "ACTIVE",
		},
	},
};

function run(overrides: Partial<ContextSyncRunView>): ContextSyncRunView {
	return {
		id: "sync_1:run_a",
		trigger: "MANUAL",
		startedAt: "2026-09-23T10:00:00.000Z",
		finishedAt: "2026-09-23T10:01:00.000Z",
		status: "SUCCEEDED",
		error: null,
		commitSha: "abc1234def5678901234567890123456789abcd",
		userName: "Example Member",
		counts: {
			created: 14,
			updated: 0,
			adopted: 0,
			unchanged: 0,
			conflict: 0,
			pathInUse: 0,
			removed: 0,
			pruneConflicts: 0,
		},
		plan: null,
		applyAttention: [],
		pruneConflicts: { keys: [], overflow: 0 },
		...overrides,
	};
}

describe("entry points (§7.1)", () => {
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

	it("never offers Sync from repository from an integration that isn't ACTIVE", () => {
		const inactive = {
			...IDLE,
			availableIntegrations: IDLE.availableIntegrations.map((i) => ({
				...i,
				status: "REVOKED",
			})),
		};
		expect(offersSyncFromRepository(inactive)).toBe(false);
		expect(
			activeContextSyncIntegrations(inactive.availableIntegrations),
		).toEqual([]);
	});
});

describe("shortCommit", () => {
	it("takes the first 7 characters, and is null for no commit", () => {
		expect(shortCommit("abc1234def5678")).toBe("abc1234");
		expect(shortCommit(null)).toBeNull();
		expect(shortCommit(undefined)).toBeNull();
	});
});

describe("the last-applied summary (§7.1)", () => {
	it.each([
		[null, { kind: "not-synced" }],
		[run({ commitSha: null }), { kind: "not-synced" }],
		[
			run({ status: "SUCCEEDED" }),
			{
				kind: "applied",
				shortSha: "abc1234",
				startedAt: "2026-09-23T10:00:00.000Z",
				fileCount: 14,
			},
		],
		[
			run({
				status: "UNCHANGED",
				counts: {
					created: 0,
					updated: 0,
					adopted: 0,
					unchanged: 9,
					conflict: 0,
					pathInUse: 0,
					removed: 0,
					pruneConflicts: 0,
				},
			}),
			{
				kind: "applied",
				shortSha: "abc1234",
				startedAt: "2026-09-23T10:00:00.000Z",
				fileCount: 9,
			},
		],
		[
			run({
				status: "PARTIAL",
				counts: {
					created: 3,
					updated: 0,
					adopted: 0,
					unchanged: 0,
					conflict: 2,
					pathInUse: 0,
					removed: 0,
					pruneConflicts: 0,
				},
			}),
			{ kind: "partial", shortSha: "abc1234", keptOlderCount: 2 },
		],
		[run({ status: "FAILED" }), { kind: "failed", shortSha: "abc1234" }],
	] as const)("%#", (input, expected) => {
		expect(contextSyncLastAppliedSummary(input)).toEqual(expected);
	});

	it("maps each summary kind to a distinct translation key", () => {
		expect(contextSyncLastAppliedMessage({ kind: "not-synced" }).key).toBe(
			"status.notSynced",
		);
		expect(
			contextSyncLastAppliedMessage({
				kind: "applied",
				shortSha: "abc1234",
				startedAt: "2026-09-23T10:00:00.000Z",
				fileCount: 14,
			}).key,
		).toBe("status.applied");
		expect(
			contextSyncLastAppliedMessage({
				kind: "partial",
				shortSha: "abc1234",
				keptOlderCount: 2,
			}).key,
		).toBe("status.partial");
		expect(
			contextSyncLastAppliedMessage({
				kind: "failed",
				shortSha: "abc1234",
			}).key,
		).toBe("status.failed");
	});
});

describe("polling (§7.1)", () => {
	it("polls every 3s while a run is open", () => {
		expect(
			contextSyncPollInterval(
				{ running: true, awaitingIndexCount: 0 },
				0,
			),
		).toBe(CONTEXT_SYNC_RUNNING_POLL_MS);
	});

	it("polls every 15s while files await indexing, within the 10-minute budget", () => {
		expect(
			contextSyncPollInterval(
				{ running: false, awaitingIndexCount: 3 },
				0,
			),
		).toBe(CONTEXT_SYNC_INDEXING_POLL_MS);
		expect(
			contextSyncPollInterval(
				{ running: false, awaitingIndexCount: 3 },
				CONTEXT_SYNC_INDEXING_POLL_BUDGET_MS - 1,
			),
		).toBe(CONTEXT_SYNC_INDEXING_POLL_MS);
	});

	it("stops polling once the indexing budget elapses", () => {
		expect(
			contextSyncPollInterval(
				{ running: false, awaitingIndexCount: 3 },
				CONTEXT_SYNC_INDEXING_POLL_BUDGET_MS,
			),
		).toBe(false);
	});

	it("does not poll when idle and nothing awaits indexing", () => {
		expect(
			contextSyncPollInterval(
				{ running: false, awaitingIndexCount: 0 },
				0,
			),
		).toBe(false);
		expect(contextSyncPollInterval(undefined, 0)).toBe(false);
	});

	describe("while automatic sync is on (Fizzy #2713)", () => {
		const automatic = (
			configured: {
				automatic: boolean;
				automaticPausedReason:
					| "PERMISSION_REVOKED"
					| "REF_MISSING"
					| null;
			} | null,
			overrides: { running?: boolean; awaitingIndexCount?: number } = {},
		) => ({
			running: false,
			awaitingIndexCount: 0,
			configured,
			...overrides,
		});
		const on = { automatic: true, automaticPausedReason: null };

		it("re-reads every 60 s with nothing open, to find a run the scheduled check or a push started", () => {
			expect(CONTEXT_SYNC_IDLE_POLL_MS).toBe(60_000);
			expect(contextSyncPollInterval(automatic(on), 0)).toBe(
				CONTEXT_SYNC_IDLE_POLL_MS,
			);
			// Once the indexing budget is spent, the idle poll carries on.
			expect(
				contextSyncPollInterval(
					automatic(on, { awaitingIndexCount: 3 }),
					CONTEXT_SYNC_INDEXING_POLL_BUDGET_MS,
				),
			).toBe(CONTEXT_SYNC_IDLE_POLL_MS);
		});

		it("still polls faster while a run is open or files await indexing", () => {
			expect(
				contextSyncPollInterval(automatic(on, { running: true }), 0),
			).toBe(CONTEXT_SYNC_RUNNING_POLL_MS);
			expect(
				contextSyncPollInterval(
					automatic(on, { awaitingIndexCount: 3 }),
					0,
				),
			).toBe(CONTEXT_SYNC_INDEXING_POLL_MS);
		});

		it.each([
			[
				"automatic sync is off",
				{ automatic: false, automaticPausedReason: null },
			],
			[
				"it is paused",
				{
					automatic: true,
					automaticPausedReason: "REF_MISSING" as const,
				},
			],
			["nothing is configured", null],
		])("does not poll idle when %s", (_label, configured) => {
			expect(contextSyncPollInterval(automatic(configured), 0)).toBe(
				false,
			);
		});
	});

	it("reports a latest run that changed between two reads, never on the first read", () => {
		expect(contextSyncLatestRunChanged("run-1", "run-2")).toBe(true);
		// A sync's first run is noticed.
		expect(contextSyncLatestRunChanged(null, "run-1")).toBe(true);
		expect(contextSyncLatestRunChanged("run-1", "run-1")).toBe(false);
		expect(contextSyncLatestRunChanged(undefined, "run-1")).toBe(false);
		expect(contextSyncLatestRunChanged("run-1", undefined)).toBe(false);
	});

	it("fingerprints the newest run by its id and whether it finished, so one receipt finishing counts as a change", () => {
		const open = { id: "sync_1:run_a", finishedAt: null };
		const done = {
			id: "sync_1:run_a",
			finishedAt: "2026-09-23T10:01:00.000Z",
		};
		expect(contextSyncLatestRunFingerprint(null)).toBeNull();
		expect(
			contextSyncLatestRunChanged(
				contextSyncLatestRunFingerprint(open),
				contextSyncLatestRunFingerprint(done),
			),
		).toBe(true);
		// Finished is final: the same finished receipt read twice is no change,
		// whatever form its time arrives in.
		expect(
			contextSyncLatestRunChanged(
				contextSyncLatestRunFingerprint(done),
				contextSyncLatestRunFingerprint({
					...done,
					finishedAt: new Date(done.finishedAt),
				}),
			),
		).toBe(false);
		expect(
			contextSyncLatestRunChanged(
				contextSyncLatestRunFingerprint(done),
				contextSyncLatestRunFingerprint({
					id: "sync_1:run_b",
					finishedAt: null,
				}),
			),
		).toBe(true);
	});

	it("reports the end of a run exactly on the running → idle transition", () => {
		expect(contextSyncRunEnded(true, false)).toBe(true);
		expect(contextSyncRunEnded(false, false)).toBe(false);
		expect(contextSyncRunEnded(false, true)).toBe(false);
		expect(contextSyncRunEnded(true, true)).toBe(false);
	});
});

describe("attention reasons (§7.3)", () => {
	it.each([
		"path-in-use",
		"too-large",
		"binary",
		"empty",
		"invalid-path",
		"conflict",
		"prune-conflict",
		"path-missing",
		"ignore-policy-unreadable",
	])("maps %s to its own key", (reason) => {
		expect(contextSyncAttentionMessageKey(reason)).toBe(
			`attention.${reason}`,
		);
	});
});

describe("configure dialog error mapping (§5.1, §7.2)", () => {
	function orpcLikeError(code: string, extra: Record<string, unknown> = {}) {
		return { message: "server message", data: { code, ...extra } };
	}

	it.each([
		["INVALID_PATH", "paths"],
		["EXCLUDED_PATH", "paths"],
		["PATH_PREFIX_OVERLAP", "paths"],
		["TOO_MANY_PATHS", "paths"],
		["EXCLUDED_PATH_POLICY_FILE", "paths"],
		["TOO_MANY_EXCLUDED_PATHS", "paths"],
		["EXCLUDED_PATH_OUTSIDE_SELECTION", "paths"],
		["EXCLUDED_PATH_OVERLAP", "paths"],
		["EXCLUDED_PATHS_STALE", "paths"],
		["BRANCH_NOT_FOUND", "branch"],
	] as const)("%s is inline, attached to the %s field", (code, field) => {
		const mapped = contextSyncConfigureErrorMessage(orpcLikeError(code));
		expect(mapped.inline).toBe(true);
		expect(mapped.field).toBe(field);
		expect(mapped.key).toBe(`configureDialog.errors.${code}`);
	});

	it.each([
		"REPOSITORY_NOT_FOUND",
		"REPOSITORY_UNAVAILABLE",
		"REPOSITORY_CREDENTIALS_EXPIRED",
		"REPOSITORY_CHANGE_REQUIRES_DISCONNECT",
	])("%s is inline but attached to no field", (code) => {
		const mapped = contextSyncConfigureErrorMessage(orpcLikeError(code));
		expect(mapped.inline).toBe(true);
		expect(mapped.field).toBeNull();
	});

	it("words a server EXCLUDED_PATH for a .fabric path with the .fabric copy", () => {
		const mapped = contextSyncConfigureErrorMessage(
			orpcLikeError("EXCLUDED_PATH", { path: ".FABRIC/x.md" }),
		);
		expect(mapped).toMatchObject({
			key: "configureDialog.errors.EXCLUDED_FABRIC_PATH",
			inline: true,
			field: "paths",
			values: { path: ".FABRIC/x.md" },
		});
		expect(
			contextSyncConfigureErrorMessage(
				orpcLikeError("EXCLUDED_PATH", { path: "docs/AGENTS.md" }),
			).key,
		).toBe("configureDialog.errors.EXCLUDED_PATH");
	});

	it("carries the path and the path it overlaps for EXCLUDED_PATH_OVERLAP (Fizzy #2750 §5.3)", () => {
		const mapped = contextSyncConfigureErrorMessage(
			orpcLikeError("EXCLUDED_PATH_OVERLAP", {
				path: "docs/old/notes.md",
				withPath: "docs/old",
			}),
		);
		expect(mapped).toMatchObject({
			key: "configureDialog.errors.EXCLUDED_PATH_OVERLAP",
			field: "paths",
			values: { path: "docs/old/notes.md", withPath: "docs/old" },
		});
	});

	it("carries managedCount for REPOSITORY_CHANGE_REQUIRES_DISCONNECT", () => {
		const mapped = contextSyncConfigureErrorMessage(
			orpcLikeError("REPOSITORY_CHANGE_REQUIRES_DISCONNECT", {
				managedCount: 7,
			}),
		);
		expect(mapped.values.managedCount).toBe(7);
	});

	it("REPOSITORY_UNREACHABLE and an unrecognized code are toasts, not inline", () => {
		expect(
			contextSyncConfigureErrorMessage(
				orpcLikeError("REPOSITORY_UNREACHABLE"),
			).inline,
		).toBe(false);
		expect(
			contextSyncConfigureErrorMessage(new Error("network down")).inline,
		).toBe(false);
		expect(
			contextSyncConfigureErrorMessage(new Error("network down")).key,
		).toBe("configureDialog.errors.generic");
	});
});

describe("syncNow result (§5.1)", () => {
	it.each([
		[{ started: true } as const, "syncNowResult.started", "success"],
		[
			{ started: false, reason: "already_running" } as const,
			"syncNowResult.already_running",
			"info",
		],
		[
			{ started: false, reason: "not_configured" } as const,
			"syncNowResult.not_configured",
			"error",
		],
		[
			{ started: false, reason: "integration_unavailable" } as const,
			"syncNowResult.integration_unavailable",
			"error",
		],
	])("%#", (result, key, tone) => {
		const message = contextSyncNowResultMessage(result);
		expect(message.key).toBe(key);
		expect(message.tone).toBe(tone);
	});
});

describe("paths editor validation (§2, §5.1)", () => {
	it("accepts a canonical folder or file path", () => {
		expect(validateContextSyncPathAddition("docs/guides", [])).toEqual({
			ok: true,
			path: "docs/guides",
		});
	});

	it("rejects a path that isn't trimmed", () => {
		const result = validateContextSyncPathAddition(" docs ", []);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("INVALID_PATH");
		}
	});

	it("rejects a backslash", () => {
		const result = validateContextSyncPathAddition("docs\\guides", []);
		expect(result).toEqual({
			ok: false,
			error: { code: "INVALID_PATH", path: "docs\\guides" },
		});
	});

	it("rejects a trailing slash", () => {
		const result = validateContextSyncPathAddition("docs/", []);
		expect(result).toEqual({
			ok: false,
			error: { code: "INVALID_PATH", path: "docs/" },
		});
	});

	it("accepts the whole repository, or a folder holding selected paths, which the reducer then absorbs (Fizzy #2750 §5.7)", () => {
		expect(validateContextSyncPathAddition("", [])).toEqual({
			ok: true,
			path: "",
		});
		// Adding "" or a folder that holds selected paths is the same
		// transition as ticking a partial folder: it absorbs them.
		expect(validateContextSyncPathAddition("", ["docs"])).toEqual({
			ok: true,
			path: "",
		});
		expect(
			validateContextSyncPathAddition("docs", ["docs/guides", "notes"]),
		).toEqual({ ok: true, path: "docs" });
		// Anything is inside the whole repository, worded without an empty name.
		const reverse = validateContextSyncPathAddition("docs", [""]);
		expect(reverse).toEqual({
			ok: false,
			error: { code: "PATH_PREFIX_OVERLAP", path: "docs", withPath: "" },
		});
		if (!reverse.ok) {
			expect(contextSyncPathValidationMessage(reverse.error)).toEqual({
				key: "pathErrors.INSIDE_WHOLE_REPOSITORY",
				values: { path: "docs" },
			});
		}
	});

	it("rejects a path that overlaps an existing one by whole segments", () => {
		const result = validateContextSyncPathAddition("docs/guides", ["docs"]);
		expect(result).toEqual({
			ok: false,
			error: {
				code: "PATH_PREFIX_OVERLAP",
				path: "docs/guides",
				withPath: "docs",
			},
		});
		// "docs-archive" is not inside "docs" — different segment.
		expect(
			validateContextSyncPathAddition("docs-archive", ["docs"]),
		).toEqual({ ok: true, path: "docs-archive" });
	});

	it("leaves the 50-path cap to the reducer, which checks it after absorbing", () => {
		// Validation alone never refuses by count: a path that absorbs
		// selected paths can be added to a full selection
		// (`applyContextAction`, tested in context-selection.test.ts).
		const existing = Array.from(
			{ length: CONTEXT_SYNC_MAX_PATHS },
			(_, i) => `folder-${i}`,
		);
		expect(validateContextSyncPathAddition("one-more", existing)).toEqual({
			ok: true,
			path: "one-more",
		});
	});

	it("rejects a duplicate", () => {
		const result = validateContextSyncPathAddition("docs", ["docs"]);
		expect(result).toEqual({
			ok: false,
			error: { code: "DUPLICATE_PATH", path: "docs" },
		});
	});

	it.each([
		"CLAUDE.md",
		"claude.md",
		"AGENTS.md",
		"GEMINI.md",
		".contextignore",
	])("rejects the excluded basename %s, case-insensitively", (name) => {
		const result = validateContextSyncPathAddition(`docs/${name}`, []);
		expect(result).toEqual({
			ok: false,
			error: { code: "EXCLUDED_PATH", path: `docs/${name}` },
		});
	});

	it.each([
		".fabric",
		".fabric/notes.md",
		".FABRIC/x.md",
		"docs/.Fabric/state.json",
		".fabric/CLAUDE.md",
	])(
		"rejects %s, with a .fabric segment at any depth and in any case, as EXCLUDED_PATH",
		(path) => {
			const result = validateContextSyncPathAddition(path, []);
			expect(result).toEqual({
				ok: false,
				error: { code: "EXCLUDED_PATH", path },
			});
			if (!result.ok) {
				expect(contextSyncPathValidationMessage(result.error)).toEqual({
					key: "pathErrors.EXCLUDED_FABRIC_PATH",
					values: { path },
				});
			}
		},
	);

	it("matches .fabric as a whole segment only", () => {
		for (const path of ["docs/.fabricrc", "fabric/notes.md", "my.fabric"]) {
			expect(validateContextSyncPathAddition(path, []), path).toEqual({
				ok: true,
				path,
			});
		}
	});

	it("does not exclude a folder that merely shares a name with an excluded file", () => {
		// Only the FILE patterns exclude by basename; "skills/" is a folder
		// pattern the server applies inside a selected folder, not here.
		expect(validateContextSyncPathAddition("skills", [])).toEqual({
			ok: true,
			path: "skills",
		});
	});

	it("gives every validation error a translation key", () => {
		expect(
			contextSyncPathValidationMessage({
				code: "INVALID_PATH",
				path: "x",
			}).key,
		).toBe("pathErrors.INVALID_PATH");
		expect(
			contextSyncPathValidationMessage({
				code: "EXCLUDED_PATH",
				path: "x",
			}).key,
		).toBe("pathErrors.EXCLUDED_PATH");
		expect(
			contextSyncPathValidationMessage({ code: "TOO_MANY_PATHS" }).key,
		).toBe("pathErrors.TOO_MANY_PATHS");
		expect(
			contextSyncPathValidationMessage({
				code: "PATH_PREFIX_OVERLAP",
				path: "x",
				withPath: "y",
			}).key,
		).toBe("pathErrors.PATH_PREFIX_OVERLAP");
		expect(
			contextSyncPathValidationMessage({
				code: "DUPLICATE_PATH",
				path: "x",
			}).key,
		).toBe("pathErrors.DUPLICATE_PATH");
	});
});

describe("Remove duplicates tallying (§6, §7.3)", () => {
	it("counts deleted, skipped (CONFLICT) and failed separately", () => {
		expect(
			tallyContextDeleteOutcomes([
				"deleted",
				"deleted",
				"skipped",
				"failed",
			]),
		).toEqual({ deleted: 2, skipped: 1, failed: 1 });
		expect(tallyContextDeleteOutcomes([])).toEqual({
			deleted: 0,
			skipped: 0,
			failed: 0,
		});
	});
});

describe("automatic sync (§11.1, Fizzy #2673)", () => {
	const configured = CONFIGURED.configured as NonNullable<
		ContextSyncState["configured"]
	>;

	it("reports a pause only while automatic sync is on", () => {
		expect(contextSyncPausedReason(null)).toBeNull();
		expect(contextSyncPausedReason(configured)).toBeNull();
		expect(
			contextSyncPausedReason({ ...configured, automatic: true }),
		).toBeNull();
		// Dormant: a pause left on a row whose automatic sync is off says
		// nothing, because nothing is waiting to resume.
		expect(
			contextSyncPausedReason({
				...configured,
				automaticPausedReason: "REF_MISSING",
			}),
		).toBeNull();
		expect(
			contextSyncPausedReason({
				...configured,
				automatic: true,
				automaticPausedReason: "REF_MISSING",
			}),
		).toBe("REF_MISSING");
		expect(
			contextSyncPausedReason({
				...configured,
				automatic: true,
				automaticPausedReason: "PERMISSION_REVOKED",
			}),
		).toBe("PERMISSION_REVOKED");
	});

	it.each([
		["MANUAL", "triggers.MANUAL"],
		["POLL", "triggers.POLL"],
		["WEBHOOK", "triggers.WEBHOOK"],
		["PULL_REQUEST_MERGED", "triggers.OTHER"],
	])("labels a %s run with %s", (trigger, key) => {
		expect(contextSyncTriggerLabelKey(trigger)).toBe(key);
	});

	it("always sends the checkbox on a first configure", () => {
		expect(
			contextSyncAutomaticInput({
				current: null,
				touched: false,
				automatic: true,
			}),
		).toEqual({ automatic: true });
		expect(
			contextSyncAutomaticInput({
				current: null,
				touched: true,
				automatic: false,
			}),
		).toEqual({ automatic: false });
	});

	it("omits automatic when changing a configuration without touching the checkbox, so the stored value stands", () => {
		expect(
			contextSyncAutomaticInput({
				current: configured,
				touched: false,
				automatic: false,
			}),
		).toEqual({});
	});

	it("sends the checkbox when changing a configuration after touching it", () => {
		expect(
			contextSyncAutomaticInput({
				current: configured,
				touched: true,
				automatic: true,
			}),
		).toEqual({ automatic: true });
	});
});

describe("contextSyncTreeErrorMessage", () => {
	it.each([
		"REPOSITORY_NOT_FOUND",
		"REPOSITORY_UNAVAILABLE",
		"REPOSITORY_CREDENTIALS_EXPIRED",
	])("reuses configure's copy for %s", (code) => {
		expect(contextSyncTreeErrorMessage({ data: { code } }, "main")).toEqual(
			{
				key: `configureDialog.errors.${code}`,
				values: { path: "", withPath: "", managedCount: 0 },
			},
		);
	});

	it("names the branch in BRANCH_NOT_FOUND, which the error data does not carry", () => {
		expect(
			contextSyncTreeErrorMessage(
				{ data: { code: "BRANCH_NOT_FOUND" } },
				"feature/x",
			),
		).toEqual({
			key: "configureDialog.errors.BRANCH_NOT_FOUND",
			values: { path: "feature/x", withPath: "", managedCount: 0 },
		});
	});

	it.each([
		{ data: { code: "REPOSITORY_UNREACHABLE" } },
		{ data: { code: "FORBIDDEN" } },
		new Error("network"),
		undefined,
	])("falls back to the tree's own message for %j", (error) => {
		expect(contextSyncTreeErrorMessage(error, "main")).toEqual({
			key: "tree.error",
		});
	});
});

describe("a failed run's message (Fizzy #2784)", () => {
	const failed = (
		error: NonNullable<ContextSyncState["latestFinishedRun"]>["error"],
		limitDetail: NonNullable<
			ContextSyncState["latestFinishedRun"]
		>["limitDetail"] = null,
	) => ({ status: "FAILED" as const, error, limitDetail });

	it("has nothing to say for a run that did not fail", () => {
		expect(
			contextSyncFailureMessage(
				{ status: "SUCCEEDED", error: null, limitDetail: null },
				null,
			),
		).toBeNull();
		expect(
			contextSyncFailureMessage(
				{ status: "UNCHANGED", error: null, limitDetail: null },
				null,
			),
		).toBeNull();
	});

	it.each([
		"NOT_CONFIGURED",
		"INTEGRATION_UNAVAILABLE",
		"PERMISSION_DENIED",
		"RUN_IN_PROGRESS",
		"PATHS_MISSING",
		"CLONE_FAILED",
		"STORE_FAILED",
		"CONFIGURATION_CHANGED",
		"SUPERSEDED",
		"INTERRUPTED",
	] as const)("words %s by its own code", (code) => {
		expect(contextSyncFailureMessage(failed(code), null)).toEqual({
			key: `failure.${code}`,
		});
	});

	it("names the branch for REF_MISSING, and leaves it blank with no configuration", () => {
		expect(
			contextSyncFailureMessage(failed("REF_MISSING"), { ref: "main" }),
		).toEqual({ key: "failure.REF_MISSING", values: { ref: "main" } });
		expect(contextSyncFailureMessage(failed("REF_MISSING"), null)).toEqual({
			key: "failure.REF_MISSING",
			values: { ref: "" },
		});
	});

	it.each([
		[
			{ kind: "fileCount", actual: 6_000, max: 5_000 },
			{
				key: "failure.limit.fileCount",
				values: { actual: "6,000", max: "5,000" },
			},
		],
		[
			{ kind: "fileCount", max: 5_000 },
			{ key: "failure.limit.fileCountUnknown", values: { max: "5,000" } },
		],
		[
			{ kind: "totalSize", actual: 60_000_000, max: 52_428_800 },
			{
				key: "failure.limit.totalSize",
				values: { actual: "57.2 MB", max: "50 MB" },
			},
		],
		[
			{ kind: "fileSize", actual: 6_291_456, max: 5_242_880 },
			{
				key: "failure.limit.fileSize",
				values: { actual: "6 MB", max: "5 MB" },
			},
		],
		[
			{ kind: "fileSize", actual: 5_243_904, max: 5_242_880 },
			{
				key: "failure.limit.fileSize",
				values: { actual: "5.001 MB", max: "5 MB" },
			},
		],
		[
			{
				kind: "totalSize",
				actual: 60_000_000,
				max: 52_428_800,
				atLeast: true,
			},
			{
				key: "failure.limit.totalSizeAtLeast",
				values: { actual: "57.2 MB", max: "50 MB" },
			},
		],
		[
			{ kind: "inventory", max: 200_000 },
			{ key: "failure.limit.inventory", values: { max: "200,000" } },
		],
		[
			{ kind: "repositorySize", max: 171_966_464 },
			{
				key: "failure.limit.repositorySize",
				values: { max: "164 MB" },
			},
		],
	] as const)("words the limit %j exactly", (limit, message) => {
		expect(
			contextSyncFailureMessage(failed("LIMITS_EXCEEDED", limit), null),
		).toEqual(message);
	});

	it("names the line and the count for a rejected .contextignore rule", () => {
		expect(
			contextSyncFailureMessage(
				failed("IGNORE_RULE_REJECTED", {
					kind: "doubleStarGroups",
					max: 2,
					actual: 3,
					line: 4,
				}),
				null,
			),
		).toEqual({
			key: "failure.limit.doubleStarGroups",
			values: { line: 4, actual: 3, max: 2 },
		});
	});

	it("falls back to the generic rejected-rule line when the run kept no line", () => {
		expect(
			contextSyncFailureMessage(failed("IGNORE_RULE_REJECTED"), null),
		).toEqual({ key: "failure.IGNORE_RULE_REJECTED" });
		expect(
			contextSyncFailureMessage(
				failed("IGNORE_RULE_REJECTED", {
					kind: "doubleStarGroups",
					max: 2,
				}),
				null,
			),
		).toEqual({ key: "failure.IGNORE_RULE_REJECTED" });
	});

	it("falls back to the generic limit line when no detail was recorded", () => {
		expect(
			contextSyncFailureMessage(failed("LIMITS_EXCEEDED"), null),
		).toEqual({ key: "failure.LIMITS_EXCEEDED" });
	});
});

describe("the Living Memory section's visibility (Fizzy #2784)", () => {
	it("stays up when the state could not be read, so the failure has somewhere to be said", () => {
		expect(
			showsLivingMemorySection({
				folderCount: 0,
				state: undefined,
				readFailed: true,
			}),
		).toBe(true);
	});

	it("stays down for a project with nothing to show and nothing to configure", () => {
		expect(
			showsLivingMemorySection({
				folderCount: 0,
				state: undefined,
				readFailed: false,
			}),
		).toBe(false);
		expect(
			showsLivingMemorySection({
				folderCount: 0,
				state: { ...IDLE, canConfigure: false },
				readFailed: false,
			}),
		).toBe(false);
	});

	it("is up for synced folders, a configuration, or a configurer with a repository to pick", () => {
		expect(
			showsLivingMemorySection({
				folderCount: 2,
				state: undefined,
				readFailed: false,
			}),
		).toBe(true);
		expect(
			showsLivingMemorySection({
				folderCount: 0,
				state: CONFIGURED,
				readFailed: false,
			}),
		).toBe(true);
		expect(
			showsLivingMemorySection({
				folderCount: 0,
				state: IDLE,
				readFailed: false,
			}),
		).toBe(true);
	});
});

describe("a failed sync action's message (Fizzy #2784)", () => {
	it("names the action for an error with no typed code", () => {
		expect(
			contextSyncActionErrorMessage(new Error("upstream"), "syncNow"),
		).toEqual({ key: "actionErrors.syncNow" });
		expect(
			contextSyncActionErrorMessage(new Error("upstream"), "disable"),
		).toEqual({ key: "actionErrors.disable" });
	});

	it("keeps a typed code's own copy", () => {
		expect(
			contextSyncActionErrorMessage(
				{ data: { code: "REPOSITORY_UNAVAILABLE" } },
				"syncNow",
			).key,
		).toBe("configureDialog.errors.REPOSITORY_UNAVAILABLE");
	});
});

describe("the copy the failure messages ask for exists (Fizzy #2784)", () => {
	const copy = en.projects.contexts.livingMemory.repositorySync;
	const lookup = (key: string): unknown =>
		key
			.split(".")
			.reduce<unknown>(
				(node, part) =>
					node && typeof node === "object"
						? (node as Record<string, unknown>)[part]
						: undefined,
				copy,
			);

	it.each([
		"NOT_CONFIGURED",
		"INTEGRATION_UNAVAILABLE",
		"PERMISSION_DENIED",
		"RUN_IN_PROGRESS",
		"REF_MISSING",
		"PATHS_MISSING",
		"LIMITS_EXCEEDED",
		"CLONE_FAILED",
		"STORE_FAILED",
		"CONFIGURATION_CHANGED",
		"SUPERSEDED",
		"INTERRUPTED",
		"IGNORE_RULE_REJECTED",
	] as const)("has a line for %s", (error) => {
		const message = contextSyncFailureMessage(
			{ status: "FAILED", error, limitDetail: null },
			{ ref: "main" },
		);

		expect(typeof lookup(message?.key ?? "missing")).toBe("string");
	});

	it.each([
		{ kind: "fileCount", actual: 1, max: 2 },
		{ kind: "fileCount", max: 2 },
		{ kind: "fileSize", actual: 1, max: 2 },
		{ kind: "fileSize", max: 2 },
		{ kind: "totalSize", actual: 1, max: 2 },
		{ kind: "totalSize", max: 2 },
		{ kind: "inventory", max: 2 },
		{ kind: "repositorySize", max: 2 },
		{ kind: "doubleStarGroups", max: 2, actual: 3, line: 4 },
	] as const)("has a line for the limit %j", (limitDetail) => {
		const message = contextSyncFailureMessage(
			{ status: "FAILED", error: "LIMITS_EXCEEDED", limitDetail },
			null,
		);

		expect(typeof lookup(message?.key ?? "missing")).toBe("string");
	});

	it("has the wrapper, read-failure and action lines", () => {
		for (const key of [
			"failure.line",
			"failure.unknown",
			"loadError.message",
			"loadError.retry",
			"actionErrors.syncNow",
			"actionErrors.disable",
		]) {
			expect(typeof lookup(key), key).toBe("string");
		}
	});
});

describe("contextSyncProgress", () => {
	const counts = {
		created: 0,
		updated: 0,
		adopted: 0,
		unchanged: 0,
		conflict: 0,
		pathInUse: 0,
		removed: 0,
		pruneConflicts: 0,
	};
	const plan = {
		keptCount: 10,
		excludedCount: 0,
		attentionCount: 0,
		attention: [],
		missingPaths: [],
		protectedPrefixes: [],
	};
	const openRun = (
		overrides: Partial<ContextSyncRunView> = {},
	): ContextSyncRunView => ({
		id: "run_1",
		trigger: "MANUAL",
		startedAt: new Date(),
		finishedAt: null,
		status: null,
		error: null,
		commitSha: null,
		userName: null,
		counts,
		plan: null,
		applyAttention: [],
		pruneConflicts: { keys: [], overflow: 0 },
		...overrides,
	});
	const state = (
		overrides: Partial<ContextSyncState> = {},
	): Pick<
		ContextSyncState,
		"running" | "latestRun" | "managedCount" | "awaitingIndexCount"
	> => ({
		running: true,
		latestRun: openRun(),
		managedCount: 0,
		awaitingIndexCount: 0,
		...overrides,
	});

	it("only names the phase before the plan exists: nothing is decided and no total is known", () => {
		expect(contextSyncProgress(state())).toEqual({ kind: "fetching" });
	});

	it("counts every file the committed batches have decided, out of the files the plan keeps", () => {
		expect(
			contextSyncProgress(
				state({
					latestRun: openRun({
						plan,
						counts: {
							...counts,
							created: 2,
							updated: 1,
							adopted: 1,
							unchanged: 3,
							conflict: 1,
							pathInUse: 1,
						},
					}),
				}),
			),
		).toEqual({ kind: "applying", done: 9, total: 10 });
	});

	it("does not count the removals and prune conflicts as applied files", () => {
		expect(
			contextSyncProgress(
				state({
					latestRun: openRun({
						plan,
						counts: {
							...counts,
							created: 4,
							removed: 3,
							pruneConflicts: 2,
						},
					}),
				}),
			),
		).toEqual({ kind: "applying", done: 4, total: 10 });
	});

	it("moves to pruning, with no total, once every kept file is decided", () => {
		expect(
			contextSyncProgress(
				state({
					latestRun: openRun({
						plan,
						counts: { ...counts, created: 10, removed: 2 },
					}),
				}),
			),
		).toEqual({ kind: "pruning", removed: 2 });
	});

	it("reports rows awaiting indexing as indexed out of managed once the run is over", () => {
		expect(
			contextSyncProgress(
				state({
					running: false,
					latestRun: openRun({ finishedAt: new Date() }),
					managedCount: 20,
					awaitingIndexCount: 5,
				}),
			),
		).toEqual({ kind: "indexing", indexed: 15, managed: 20 });
	});

	it("says nothing when nothing awaits indexing, or when the open run is not the latest row yet", () => {
		expect(
			contextSyncProgress(
				state({
					running: false,
					managedCount: 20,
					awaitingIndexCount: 0,
				}),
			),
		).toBeNull();
		expect(
			contextSyncProgress(
				state({ latestRun: openRun({ finishedAt: new Date() }) }),
			),
		).toBeNull();
		expect(contextSyncProgress(state({ latestRun: null }))).toBeNull();
	});
});
