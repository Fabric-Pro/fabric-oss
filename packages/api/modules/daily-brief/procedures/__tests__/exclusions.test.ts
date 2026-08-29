/**
 * Unit tests for the Daily Brief release-notes exclusion procedures (Fizzy
 * 1869 follow-up) — `hideReleaseNoteProcedure` / `unhideReleaseNoteProcedure` /
 * `listReleaseNoteExclusionsProcedure`.
 * Fully offline — mirrors the harness in sends-approve.test.ts: `@repo/database`,
 * `@repo/temporal`, `../lib/request-regeneration`, and `../../../orpc/procedures`
 * are mocked, and each procedure's `.handler` is invoked directly via the
 * chainable-proxy `_handler`.
 *
 * Coverage:
 *  - hide: creates the exclusion + emits `dailyBrief.releaseNote.hidden` in the
 *    tx exactly once (right action/metadata/resource) + best-effort regenerate
 *    with `force:true` and the VIEWED window forwarded verbatim.
 *  - hide: a duplicate (`created:false`) is a no-op — NO audit AND NO regenerate.
 *  - hide: omitting `timeWindow` forwards `undefined` (helper defaults).
 *  - unhide: deletes + emits `dailyBrief.releaseNote.unhidden` with
 *    `metadata:{kind,targetKey}` + `resource.name` from the PRE-DELETE row.
 *  - unhide: a missing row (`deleted:false`) is a no-op — NO audit AND NO regen.
 *  - list: returns the project's exclusions, scoped to the VERIFIED tenant
 *    (never raw input) — including the XOR case where the caller's ambient org
 *    context differs from the project's own tenant. Where the caller passes an
 *    organizationId that CONTRADICTS the project, that is BAD_REQUEST rather
 *    than a silently re-scoped query.
 *  - hide/unhide: a project that does not resolve -> NOT_FOUND, no write / audit
 *    / regen. (Cross-tenant rejection lives in requireProjectPermission, which
 *    this harness stubs; an input org contradicting the project is BAD_REQUEST.)
 *  - hide/unhide: a regenerate failure does NOT throw or roll back the mutation.
 *  - list: a project that does not resolve -> NOT_FOUND, no query.
 *  - permission wiring: hide/unhide/list all declare PROJECT_SETTINGS_EDIT
 *    (mock-level check plus a source-scan of exclusions-hide.ts /
 *    exclusions-unhide.ts / exclusions-list.ts, since the mocked Permissions
 *    proxy alone can't distinguish PROJECT_SETTINGS_EDIT from any other key
 *    or from a deleted `.use(...)` call) — list is editor-only because it
 *    exposes hidden-target identities that a plain PROJECT_READ caller must
 *    not be able to recover.
 *  - helper: `requestDailyBriefRegeneration({force:true})` skips the rate-limit
 *    branch (recent-generation project still -> `started`) while force-absent
 *    returns `rate_limited`.
 *
 * Run with: pnpm --filter @repo/api test exclusions
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const {
	mockProjectFindUnique,
	mockTransaction,
	mockCreateExclusion,
	mockDeleteExclusion,
	mockListExclusions,
	mockRecordAuditTx,
	mockRequestRegen,
	mockIsTemporalAvailable,
	mockGetTemporalClient,
	mockWorkflowStart,
	mockDailyBriefFindFirst,
	mockDailyBriefCreate,
	mockDailyBriefUpdate,
} = vi.hoisted(() => ({
	mockProjectFindUnique: vi.fn(),
	// db.$transaction runs the callback with a sentinel tx client and returns
	// its result — createReleaseNoteExclusion / deleteReleaseNoteExclusion /
	// recordAuditTx are all mocked, so the tx identity is irrelevant.
	mockTransaction: vi.fn(),
	mockCreateExclusion: vi.fn(),
	mockDeleteExclusion: vi.fn(),
	mockListExclusions: vi.fn(),
	mockRecordAuditTx: vi.fn(),
	mockRequestRegen: vi.fn(),
	mockIsTemporalAvailable: vi.fn(),
	mockGetTemporalClient: vi.fn(),
	mockWorkflowStart: vi.fn(),
	mockDailyBriefFindFirst: vi.fn(),
	mockDailyBriefCreate: vi.fn(),
	mockDailyBriefUpdate: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mockProjectFindUnique },
		$transaction: mockTransaction,
		dailyBrief: {
			findFirst: mockDailyBriefFindFirst,
			create: mockDailyBriefCreate,
			update: mockDailyBriefUpdate,
		},
	},
	createReleaseNoteExclusion: mockCreateExclusion,
	deleteReleaseNoteExclusion: mockDeleteExclusion,
	listReleaseNoteExclusions: mockListExclusions,
	recordAuditTx: mockRecordAuditTx,
	// Real target-key builder (matches the @repo/database implementation) so the
	// audit metadata/resource assertions exercise the real key shape.
	buildExclusionTargetKey: (input: {
		kind: "pr" | "story";
		repoFullName?: string;
		prNumber?: number;
		storyIdentifier?: string;
	}) =>
		input.kind === "pr"
			? `pr:${input.repoFullName}#${input.prNumber}`
			: `story:${input.storyIdentifier}`,
	// Real, lightweight zod enum — the procedure modules call
	// `timeWindowKindSchema.optional()` at import time.
	timeWindowKindSchema: z.enum(["LAST_24H", "LAST_7D", "LAST_2W", "CUSTOM"]),
	// Consumed by the REAL request-regeneration helper in the helper-level test.
	DEFAULT_DAILY_BRIEF_WINDOW: "LAST_7D",
	resolveTimeWindow: () => ({
		start: new Date("2026-07-01T00:00:00.000Z"),
		end: new Date("2026-07-08T00:00:00.000Z"),
	}),
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mockGetTemporalClient,
	isTemporalAvailable: mockIsTemporalAvailable,
}));

vi.mock("../../lib/request-regeneration", () => ({
	requestDailyBriefRegeneration: mockRequestRegen,
}));

vi.mock("../../../../orpc/procedures", () => {
	// biome-ignore lint/suspicious/noExplicitAny: minimal chainable test double
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null) => organizationId ?? null,
		),
	};
});

import { hideReleaseNoteProcedure } from "../exclusions-hide";
import { listReleaseNoteExclusionsProcedure } from "../exclusions-list";
import { unhideReleaseNoteProcedure } from "../exclusions-unhide";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const hide = (hideReleaseNoteProcedure as unknown as { _handler: Handler })
	._handler;
const unhide = (unhideReleaseNoteProcedure as unknown as { _handler: Handler })
	._handler;
const list = (
	listReleaseNoteExclusionsProcedure as unknown as { _handler: Handler }
)._handler;

const orgContext = {
	user: { id: "reviewer-1", email: "r@example.com", name: "Reviewer" },
	session: { activeOrganizationId: "org-9" },
};

// The VERIFIED project row — tenant columns for the stored exclusion + regen
// are derived from THIS, never from raw input.
const project = { id: "p1", organizationId: "org-9", userId: "owner-1" };
const tenant = { projectId: "p1", organizationId: "org-9", userId: "owner-1" };

beforeEach(() => {
	vi.clearAllMocks();
	mockProjectFindUnique.mockResolvedValue(project);
	// $transaction executes the callback and returns its result.
	mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
		cb({ __tx: true }),
	);
	mockRecordAuditTx.mockResolvedValue(undefined);
	mockRequestRegen.mockResolvedValue({
		status: "started",
		brief: { id: "b-1", temporalWorkflowId: "wf-1" },
	});
	// Helper-level defaults (only exercised by the real-helper test).
	mockIsTemporalAvailable.mockResolvedValue(true);
	mockGetTemporalClient.mockResolvedValue({
		workflow: { start: mockWorkflowStart },
	});
	mockWorkflowStart.mockResolvedValue({ workflowId: "wf-1" });
	mockDailyBriefCreate.mockResolvedValue({ id: "brief-1" });
	mockDailyBriefUpdate.mockResolvedValue({});
	// First findFirst is the in-flight guard (status: "GENERATING") -> none.
	// The rate-limit guard (where has `generatedAt`) -> a recent row.
	mockDailyBriefFindFirst.mockImplementation(
		async (args: { where?: { status?: unknown } }) =>
			args?.where?.status === "GENERATING"
				? null
				: { id: "recent-1", generatedAt: new Date() },
	);
});

describe("dailyBrief.exclusions.hide", () => {
	it("creates the exclusion, emits the hidden audit once, and regenerates the VIEWED window with force", async () => {
		mockCreateExclusion.mockResolvedValue({
			created: true,
			row: { id: "ex-1" },
		});

		const result = await hide({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				kind: "pr",
				repoFullName: "acme/web",
				prNumber: 42,
				timeWindow: "LAST_24H",
			},
			context: orgContext,
		});

		expect(result).toEqual({ created: true, exclusion: { id: "ex-1" } });

		// Persisted under the VERIFIED tenant + the acting user.
		expect(mockCreateExclusion).toHaveBeenCalledTimes(1);
		expect(mockCreateExclusion).toHaveBeenCalledWith(
			expect.anything(),
			tenant,
			expect.objectContaining({
				kind: "pr",
				repoFullName: "acme/web",
				prNumber: 42,
			}),
			"reviewer-1",
		);

		// Audit committed in-tx exactly once, with the right action + metadata.
		expect(mockRecordAuditTx).toHaveBeenCalledTimes(1);
		expect(mockRecordAuditTx).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "dailyBrief.releaseNote.hidden",
				organizationId: "org-9",
				projectId: "p1",
				resource: {
					type: "daily_brief_release_note_exclusion",
					id: "ex-1",
					name: "pr:acme/web#42",
				},
				metadata: { kind: "pr", targetKey: "pr:acme/web#42" },
			}),
		);
		expect(mockRecordAuditTx.mock.calls[0]?.[1]).toMatchObject({
			actor: {
				type: "user",
				userId: "reviewer-1",
				emailSnapshot: "r@example.com",
				nameSnapshot: "Reviewer",
			},
		});

		// Regenerate: force + the viewed window forwarded verbatim.
		expect(mockRequestRegen).toHaveBeenCalledTimes(1);
		expect(mockRequestRegen).toHaveBeenCalledWith({
			projectId: "p1",
			project: { organizationId: "org-9", userId: "owner-1" },
			triggeredByUserId: "reviewer-1",
			force: true,
			timeWindow: "LAST_24H",
		});
	});

	it("emits a story-keyed audit + targetKey for a story exclusion", async () => {
		mockCreateExclusion.mockResolvedValue({
			created: true,
			row: { id: "ex-2" },
		});

		await hide({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				kind: "story",
				storyIdentifier: "F-123",
			},
			context: orgContext,
		});

		expect(mockRecordAuditTx).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "dailyBrief.releaseNote.hidden",
				metadata: { kind: "story", targetKey: "story:F-123" },
				resource: expect.objectContaining({ name: "story:F-123" }),
			}),
		);
	});

	it("a duplicate hide (created:false) is a no-op — NO audit AND NO regenerate", async () => {
		mockCreateExclusion.mockResolvedValue({
			created: false,
			row: { id: "ex-1" },
		});

		const result = await hide({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				kind: "pr",
				repoFullName: "acme/web",
				prNumber: 42,
				timeWindow: "LAST_24H",
			},
			context: orgContext,
		});

		expect(result).toEqual({ created: false, exclusion: { id: "ex-1" } });
		expect(mockRecordAuditTx).not.toHaveBeenCalled();
		expect(mockRequestRegen).not.toHaveBeenCalled();
	});

	it("omitting timeWindow forwards undefined to the regenerate helper", async () => {
		mockCreateExclusion.mockResolvedValue({
			created: true,
			row: { id: "ex-1" },
		});

		await hide({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				kind: "pr",
				repoFullName: "acme/web",
				prNumber: 42,
			},
			context: orgContext,
		});

		expect(mockRequestRegen).toHaveBeenCalledWith(
			expect.objectContaining({ force: true, timeWindow: undefined }),
		);
	});

	it("a project that does not resolve -> NOT_FOUND, no write / audit / regenerate", async () => {
		mockProjectFindUnique.mockResolvedValue(null);

		const error = await hide({
			input: {
				projectId: "other-tenant",
				organizationId: "org-9",
				kind: "pr",
				repoFullName: "acme/web",
				prNumber: 42,
			},
			context: orgContext,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
		expect(mockCreateExclusion).not.toHaveBeenCalled();
		expect(mockRecordAuditTx).not.toHaveBeenCalled();
		expect(mockRequestRegen).not.toHaveBeenCalled();
	});

	it("a CUSTOM timeWindow is normalized to undefined for the regenerate helper (resolveTimeWindow throws on CUSTOM) — the mutation still commits (Codex finding)", async () => {
		mockCreateExclusion.mockResolvedValue({
			created: true,
			row: { id: "ex-1" },
		});

		const result = await hide({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				kind: "pr",
				repoFullName: "acme/web",
				prNumber: 42,
				timeWindow: "CUSTOM",
			},
			context: orgContext,
		});

		// The exclusion still persists regardless of the window normalization.
		expect(result).toEqual({ created: true, exclusion: { id: "ex-1" } });
		expect(mockCreateExclusion).toHaveBeenCalledTimes(1);

		// The forced regen is invoked with a resolvable window (undefined ->
		// helper defaults), never the literal "CUSTOM" that would throw inside
		// resolveTimeWindow and be swallowed by the best-effort catch.
		expect(mockRequestRegen).toHaveBeenCalledTimes(1);
		expect(mockRequestRegen).toHaveBeenCalledWith(
			expect.objectContaining({ force: true, timeWindow: undefined }),
		);
	});

	it("a regenerate failure does NOT throw or roll back the persisted exclusion", async () => {
		mockCreateExclusion.mockResolvedValue({
			created: true,
			row: { id: "ex-1" },
		});
		mockRequestRegen.mockRejectedValue(new Error("temporal down"));

		const result = await hide({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				kind: "pr",
				repoFullName: "acme/web",
				prNumber: 42,
				timeWindow: "LAST_24H",
			},
			context: orgContext,
		});

		expect(result).toEqual({ created: true, exclusion: { id: "ex-1" } });
		// The create + audit committed despite the regen failure.
		expect(mockCreateExclusion).toHaveBeenCalledTimes(1);
		expect(mockRecordAuditTx).toHaveBeenCalledTimes(1);
	});
});

describe("dailyBrief.exclusions.unhide", () => {
	it("deletes + emits the unhidden audit with metadata/resource from the PRE-DELETE row + regenerates", async () => {
		mockDeleteExclusion.mockResolvedValue({
			deleted: true,
			row: { id: "ex-1", kind: "story", targetKey: "story:F-9" },
		});

		const result = await unhide({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				id: "ex-1",
				timeWindow: "LAST_24H",
			},
			context: orgContext,
		});

		expect(result).toEqual({ deleted: true });

		expect(mockDeleteExclusion).toHaveBeenCalledTimes(1);
		expect(mockDeleteExclusion).toHaveBeenCalledWith(
			expect.anything(),
			tenant,
			"ex-1",
		);

		// Audit target details come from the (hard-deleted) pre-delete row.
		expect(mockRecordAuditTx).toHaveBeenCalledTimes(1);
		expect(mockRecordAuditTx).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "dailyBrief.releaseNote.unhidden",
				organizationId: "org-9",
				projectId: "p1",
				resource: {
					type: "daily_brief_release_note_exclusion",
					id: "ex-1",
					name: "story:F-9",
				},
				metadata: { kind: "story", targetKey: "story:F-9" },
			}),
		);

		expect(mockRequestRegen).toHaveBeenCalledTimes(1);
		expect(mockRequestRegen).toHaveBeenCalledWith({
			projectId: "p1",
			project: { organizationId: "org-9", userId: "owner-1" },
			triggeredByUserId: "reviewer-1",
			force: true,
			timeWindow: "LAST_24H",
		});
	});

	it("a missing row (deleted:false) is a no-op — NO audit AND NO regenerate", async () => {
		mockDeleteExclusion.mockResolvedValue({ deleted: false });

		const result = await unhide({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				id: "missing",
				timeWindow: "LAST_24H",
			},
			context: orgContext,
		});

		expect(result).toEqual({ deleted: false });
		expect(mockRecordAuditTx).not.toHaveBeenCalled();
		expect(mockRequestRegen).not.toHaveBeenCalled();
	});

	it("a project that does not resolve -> NOT_FOUND, no delete / audit / regenerate", async () => {
		mockProjectFindUnique.mockResolvedValue(null);

		const error = await unhide({
			input: {
				projectId: "other-tenant",
				organizationId: "org-9",
				id: "ex-1",
			},
			context: orgContext,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
		expect(mockDeleteExclusion).not.toHaveBeenCalled();
		expect(mockRecordAuditTx).not.toHaveBeenCalled();
		expect(mockRequestRegen).not.toHaveBeenCalled();
	});

	it("a CUSTOM timeWindow is normalized to undefined for the regenerate helper (resolveTimeWindow throws on CUSTOM) — the delete still commits (Codex finding)", async () => {
		mockDeleteExclusion.mockResolvedValue({
			deleted: true,
			row: { id: "ex-1", kind: "pr", targetKey: "pr:acme/web#42" },
		});

		const result = await unhide({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				id: "ex-1",
				timeWindow: "CUSTOM",
			},
			context: orgContext,
		});

		// The delete still commits regardless of the window normalization.
		expect(result).toEqual({ deleted: true });
		expect(mockDeleteExclusion).toHaveBeenCalledTimes(1);

		// The forced regen is invoked with a resolvable window (undefined ->
		// helper defaults), never the literal "CUSTOM" that would throw inside
		// resolveTimeWindow and be swallowed by the best-effort catch.
		expect(mockRequestRegen).toHaveBeenCalledTimes(1);
		expect(mockRequestRegen).toHaveBeenCalledWith(
			expect.objectContaining({ force: true, timeWindow: undefined }),
		);
	});

	it("a regenerate failure does NOT throw or roll back the persisted delete", async () => {
		mockDeleteExclusion.mockResolvedValue({
			deleted: true,
			row: { id: "ex-1", kind: "pr", targetKey: "pr:acme/web#42" },
		});
		mockRequestRegen.mockRejectedValue(new Error("temporal down"));

		const result = await unhide({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				id: "ex-1",
				timeWindow: "LAST_24H",
			},
			context: orgContext,
		});

		expect(result).toEqual({ deleted: true });
		expect(mockDeleteExclusion).toHaveBeenCalledTimes(1);
		expect(mockRecordAuditTx).toHaveBeenCalledTimes(1);
	});
});

describe("dailyBrief.exclusions.list", () => {
	it("returns the project's exclusions from the VERIFIED tenant scope", async () => {
		const rows = [
			{
				id: "ex-1",
				kind: "pr",
				repoFullName: "acme/web",
				prNumber: 42,
				storyIdentifier: null,
				reason: null,
				excludedByUserId: "owner-1",
				createdAt: new Date("2026-07-01T00:00:00.000Z"),
			},
			{
				id: "ex-2",
				kind: "story",
				repoFullName: null,
				prNumber: null,
				storyIdentifier: "F-123",
				reason: "flag-gated",
				excludedByUserId: "owner-1",
				createdAt: new Date("2026-07-02T00:00:00.000Z"),
			},
		];
		mockListExclusions.mockResolvedValue(rows);

		const result = await list({
			input: { projectId: "p1", organizationId: "org-9" },
			context: orgContext,
		});

		expect(result).toBe(rows);
		expect(mockListExclusions).toHaveBeenCalledTimes(1);
		expect(mockListExclusions).toHaveBeenCalledWith(
			expect.anything(),
			tenant,
		);
	});

	it("a project that does not resolve -> NOT_FOUND, no query", async () => {
		mockProjectFindUnique.mockResolvedValue(null);

		const error = await list({
			input: { projectId: "other-tenant", organizationId: "org-9" },
			context: orgContext,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
		expect(mockListExclusions).not.toHaveBeenCalled();
	});

	it("an input organizationId that contradicts the project is rejected, and nothing is queried", async () => {
		// Replaces an assertion that could not happen in production. It used to
		// mock a PERSONAL project while the caller passed `organizationId`, then
		// check the tenant came from the project — but the old lookup was
		// `where: { id, organizationId }`, so a personal row could never be
		// returned for that call. The mock, not the code, produced the scenario.
		//
		// The lookup is now by id alone, which makes the contradiction reachable
		// for the first time — so it is checked explicitly instead.
		mockProjectFindUnique.mockResolvedValue({
			id: "p2",
			organizationId: null,
			userId: "owner-2",
		});

		const error = await list({
			input: { projectId: "p2", organizationId: "org-9" },
			context: orgContext,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		// BAD_REQUEST, not NOT_FOUND: requireProjectPermission already authorized
		// this caller for this project, so refusing to confirm it exists would
		// hide nothing they do not already know.
		expect((error as ORPCError<string, unknown>).code).toBe("BAD_REQUEST");
		expect(mockListExclusions).not.toHaveBeenCalled();
	});

	it("XOR scoping: the tenant is derived from the VERIFIED project row, not from the caller's context", async () => {
		// The caller sits in an org context but omits organizationId, which a
		// guest on a personal-context page legitimately does. The project is
		// personal, so the query must be scoped to the project OWNER's userId —
		// never to the caller, and never to the caller's ambient org.
		mockProjectFindUnique.mockResolvedValue({
			id: "p2",
			organizationId: null,
			userId: "owner-2",
		});
		mockListExclusions.mockResolvedValue([]);

		await list({
			input: { projectId: "p2" },
			context: orgContext,
		});

		expect(mockListExclusions).toHaveBeenCalledWith(expect.anything(), {
			projectId: "p2",
			organizationId: null,
			userId: "owner-2",
		});
	});
});

describe("permission wiring (1869 follow-up)", () => {
	it("hide/unhide/list declare PROJECT_SETTINGS_EDIT", async () => {
		const { requireProjectPermission, Permissions } = (await import(
			"../../../../orpc/procedures"
			// biome-ignore lint/suspicious/noExplicitAny: mocked proxy round-trip
		)) as any;
		// The procedure modules evaluate requireProjectPermission(Permissions.X)
		// at import time; the mocked Permissions proxy returns the key name
		// itself, so PROJECT_SETTINGS_EDIT round-trips.
		expect(Permissions.PROJECT_SETTINGS_EDIT).toBe("PROJECT_SETTINGS_EDIT");
		expect(typeof requireProjectPermission).toBe("function");
	});

	// Source-scan (mirrors packages/temporal/__tests__/daily-brief-workflow-wiring.test.ts):
	// the mocked proxy above echoes ANY key back, so a mock-level assertion alone
	// can't tell PROJECT_SETTINGS_EDIT apart from PROJECT_READ (or from the `.use`
	// call being deleted entirely) — reading the real source is the only thing
	// that actually proves the editor-only permission gate is wired.
	const readProcedureSource = (filename: string) =>
		readFileSync(join(__dirname, "..", filename), "utf8");

	it("exclusions-hide.ts wires requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT)", () => {
		const source = readProcedureSource("exclusions-hide.ts");
		expect(source).toMatch(
			/\.use\(\s*requireProjectPermission\(\s*Permissions\.PROJECT_SETTINGS_EDIT\s*\)\s*\)/,
		);
	});

	it("exclusions-unhide.ts wires requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT)", () => {
		const source = readProcedureSource("exclusions-unhide.ts");
		expect(source).toMatch(
			/\.use\(\s*requireProjectPermission\(\s*Permissions\.PROJECT_SETTINGS_EDIT\s*\)\s*\)/,
		);
	});

	it("exclusions-list.ts wires requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT) — editor-only, so a plain PROJECT_READ caller cannot recover hidden-target identities", () => {
		const source = readProcedureSource("exclusions-list.ts");
		expect(source).toMatch(
			/\.use\(\s*requireProjectPermission\(\s*Permissions\.PROJECT_SETTINGS_EDIT\s*\)\s*\)/,
		);
	});
});

describe("requestDailyBriefRegeneration force / rate-limit gate", () => {
	// The REAL helper (bypassing the module mock the procedures use) against a
	// mocked @repo/database + @repo/temporal.
	const importRealHelper = async () =>
		(
			await vi.importActual<
				typeof import("../../lib/request-regeneration")
			>("../../lib/request-regeneration")
		).requestDailyBriefRegeneration;

	it("force:true skips the rate-limit branch — a recent-generation project still starts", async () => {
		const requestDailyBriefRegeneration = await importRealHelper();

		const result = await requestDailyBriefRegeneration({
			projectId: "p1",
			project: { organizationId: "org-9", userId: "owner-1" },
			triggeredByUserId: "reviewer-1",
			force: true,
			timeWindow: "LAST_7D",
		});

		expect(result.status).toBe("started");
		// Passed the rate-limit gate and inserted a GENERATING row.
		expect(mockDailyBriefCreate).toHaveBeenCalledTimes(1);
		expect(mockWorkflowStart).toHaveBeenCalledTimes(1);
	});

	it("force absent returns rate_limited when a recent generation exists", async () => {
		const requestDailyBriefRegeneration = await importRealHelper();

		const result = await requestDailyBriefRegeneration({
			projectId: "p1",
			project: { organizationId: "org-9", userId: "owner-1" },
			triggeredByUserId: "reviewer-1",
			timeWindow: "LAST_7D",
		});

		expect(result.status).toBe("rate_limited");
		expect(mockDailyBriefCreate).not.toHaveBeenCalled();
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});
});
