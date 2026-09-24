import { describe, expect, it } from "vitest";
import {
	activeContextSyncIntegrations,
	CONTEXT_SYNC_INDEXING_POLL_BUDGET_MS,
	CONTEXT_SYNC_INDEXING_POLL_MS,
	CONTEXT_SYNC_MAX_PATHS,
	CONTEXT_SYNC_RUNNING_POLL_MS,
	type ContextSyncRunView,
	type ContextSyncState,
	contextSyncAttentionMessageKey,
	contextSyncConfigureErrorMessage,
	contextSyncLastAppliedMessage,
	contextSyncLastAppliedSummary,
	contextSyncNowResultMessage,
	contextSyncPathValidationMessage,
	contextSyncPollInterval,
	contextSyncRunEnded,
	offersSyncFromRepository,
	offersSyncNow,
	shortCommit,
	tallyContextDeleteOutcomes,
	validateContextSyncPathAddition,
} from "../context-repository-sync";

const IDLE: ContextSyncState = {
	canConfigure: true,
	running: false,
	configured: null,
	latestRun: null,
	lastAppliedRun: null,
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

	it("accepts an empty string alone, but not alongside another path", () => {
		expect(validateContextSyncPathAddition("", [])).toEqual({
			ok: true,
			path: "",
		});
		const result = validateContextSyncPathAddition("", ["docs"]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("PATH_PREFIX_OVERLAP");
		}
		const reverse = validateContextSyncPathAddition("docs", [""]);
		expect(reverse.ok).toBe(false);
		if (!reverse.ok) {
			expect(reverse.error.code).toBe("PATH_PREFIX_OVERLAP");
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

	it("rejects a path once 50 are already selected", () => {
		const existing = Array.from(
			{ length: CONTEXT_SYNC_MAX_PATHS },
			(_, i) => `folder-${i}`,
		);
		const result = validateContextSyncPathAddition("one-more", existing);
		expect(result).toEqual({
			ok: false,
			error: { code: "TOO_MANY_PATHS" },
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
