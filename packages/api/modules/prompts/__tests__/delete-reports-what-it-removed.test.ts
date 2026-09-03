/**
 * Who may reach the delete procedure, and what it says happened afterwards
 * (Fizzy #2328 — R10, R11, R12, R15).
 *
 * The gate comes first, because it is the one thing here that is not about
 * reporting: an organization context must exist before anything else runs. The
 * `requirePermission` middleware in front of this handler returns `next()`
 * without evaluating any role when the tenant context is absent or personal, so
 * without the handler's own check a global admin with no active organization
 * reached the module's most destructive action on the per-scope check alone.
 * The impact READ has refused that state since it shipped; the write must not
 * be the laxer of the two.
 *
 * Then four failures this suite exists to prevent, each of which shipped as the
 * "obvious" version of this handler:
 *
 *   - A deletion of a prompt somebody else removed a moment earlier reported as
 *     an internal server error, or — on the multi-row SYSTEM path, where a
 *     key-scoped delete removes zero rows SILENTLY — as a success. The database
 *     layer raises Prisma's own `P2025` for both, and this handler is where that
 *     becomes "already deleted" (R11).
 *   - A transaction that ran out of time reported identically to a retirement
 *     record that could not be written. They mean opposite things: the first
 *     removed nothing and should be retried, the second means the deletion was
 *     deliberately abandoned because it could not be made durable.
 *   - The completion message echoing the figures the confirmation dialog showed.
 *     Those are a snapshot taken before a human decision; a binding written
 *     during that window is removed and, if the handler replays the snapshot,
 *     never mentioned (R15). The handler returns and audits what the deletion
 *     actually removed instead.
 *   - A deletion attempted before `retired_prompt_key`'s migration has run
 *     reporting a bare "Failed to delete prompt". The retirement write lives
 *     inside the deletion's transaction, so a missing table aborts the whole
 *     thing — nothing is removed, and the answer the operator needs is the name
 *     of the migration, not a generic failure.
 *
 * Run with:
 *   pnpm --filter api test modules/prompts/__tests__/delete-reports-what-it-removed.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	deletePrompt,
	getPromptById,
	assertPromptDeleteAuthority,
	recordAuditFromRequest,
	loggerError,
} = vi.hoisted(() => ({
	deletePrompt: vi.fn(),
	getPromptById: vi.fn(),
	assertPromptDeleteAuthority: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	loggerError: vi.fn(),
}));

vi.mock("@repo/database", () => ({ deletePrompt, getPromptById }));
vi.mock("@repo/logs", () => ({ logger: { error: loggerError } }));
vi.mock("../../../lib/audit", () => ({ recordAuditFromRequest }));
vi.mock("../lib/scope-authority", () => ({ assertPromptDeleteAuthority }));

vi.mock("../../../orpc/procedures", () => ({
	Permissions: { PROMPT_DELETE: "prompt:delete" },
	requirePermission: () => (next: unknown) => next,
	tenantProtectedProcedure: {
		use: () => ({
			route: () => ({
				input: () => ({ handler: (fn: unknown) => fn }),
			}),
		}),
	},
}));

import { deleteProcedure } from "../procedures/delete";

/** What the deletion actually removed — deliberately different from the
 *  pre-flight snapshot the dialog would have shown (see the R15 case). */
const REMOVED = {
	promptKey: "story_drafter",
	scope: "SYSTEM" as const,
	promptRowCount: 2,
	bindingCount: 8,
	organizationCount: 3,
	personalOverrideUserCount: 1,
	documentTypeLabels: ["General", "Test Plan"],
	retirementRecorded: true,
};

type Handler = (a: unknown) => Promise<unknown>;

/** The tenant shapes a request can arrive in. `absent` is a context carrying no
 *  `tenantContext` at all — what a procedure built on plain
 *  `protectedProcedure` leaves behind, and what `requirePermission` treats as
 *  personal-equivalent. */
type TenantShape = "organization" | "personal" | "none" | "absent";

const callDelete = (id = "prompt-1", tenant: TenantShape = "organization") => {
	const organizationId = tenant === "organization" ? "org-1" : null;

	return (deleteProcedure as unknown as Handler)({
		input: { id },
		context: {
			user: {
				id: "user-1",
				email: "operator@example.com",
				name: "Operator",
				role: "admin",
			},
			session: { id: "session-1", activeOrganizationId: organizationId },
			tenantContext:
				tenant === "absent"
					? undefined
					: { userId: "user-1", type: tenant, organizationId },
		},
	});
};

beforeEach(() => {
	vi.clearAllMocks();
	getPromptById.mockResolvedValue({
		id: "prompt-1",
		key: "story_drafter",
		name: "DO NOT USE - Story Drafter",
		scope: "SYSTEM",
		organizationId: null,
		userId: null,
	});
	assertPromptDeleteAuthority.mockResolvedValue(undefined);
	deletePrompt.mockResolvedValue(REMOVED);
});

// The gate the impact READ has carried since it shipped, and the write did not.
// `requirePermission(PROMPT_DELETE)` returns `next()` without evaluating any
// role when `tenantContext` is absent or personal, so on its own it waved a
// global admin with no active organization through to the most destructive
// action in this module. Not reachable through the UI — `canDeletePrompt` in
// `apps/web` is deliberately STRICTER and withholds the control in exactly that
// state — which is why manual QA cannot see it and only a direct
// `DELETE /prompts/:id` can. That is the case these rows exist for.
describe("prompts.delete — the organization gate", () => {
	it("refuses a global admin with no active organization", async () => {
		await expect(callDelete("prompt-1", "personal")).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "This operation requires an organization context",
		});

		// Runs before the read, exactly as it does in `deletion-impact.ts`: a
		// caller with no organization has no business learning the id exists.
		expect(getPromptById).not.toHaveBeenCalled();
		expect(assertPromptDeleteAuthority).not.toHaveBeenCalled();
		expect(deletePrompt).not.toHaveBeenCalled();
		expect(recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("refuses a caller whose tenant context resolved to none", async () => {
		await expect(callDelete("prompt-1", "none")).rejects.toThrow(
			/organization/i,
		);
		expect(deletePrompt).not.toHaveBeenCalled();
	});

	it("refuses a caller whose tenant context is absent entirely", async () => {
		await expect(callDelete("prompt-1", "absent")).rejects.toThrow(
			/organization/i,
		);
		expect(deletePrompt).not.toHaveBeenCalled();
	});

	// The type says "organization" and the id is missing anyway. Refused on the
	// id, not on the label — a context that names no organization cannot be
	// used to scope an audit row to one either (see the audit test below).
	it("refuses an organization context carrying no organization id", async () => {
		await expect(
			(deleteProcedure as unknown as Handler)({
				input: { id: "prompt-1" },
				context: {
					user: { id: "user-1", role: "admin" },
					session: { id: "session-1", activeOrganizationId: null },
					tenantContext: {
						userId: "user-1",
						type: "organization",
						organizationId: null,
					},
				},
			}),
		).rejects.toThrow(/organization/i);
		expect(deletePrompt).not.toHaveBeenCalled();
	});
});

describe("prompts.delete — what it returns", () => {
	it("hands the caller the figures the deletion actually removed", async () => {
		await expect(callDelete()).resolves.toEqual({
			success: true,
			...REMOVED,
		});

		expect(deletePrompt).toHaveBeenCalledWith({
			id: "prompt-1",
			// The record has to name who retired the key; without the actor the
			// row is an anonymous veto nobody can review.
			deletedBy: "user-1",
		});
	});

	// AE16. The dialog showed one binding. Another tenant set a default while
	// the operator read it. The completion message must report two.
	it("reports the deletion's own count, not the pre-flight snapshot's", async () => {
		const snapshotBindingCount = 1;
		deletePrompt.mockResolvedValue({ ...REMOVED, bindingCount: 2 });

		const result = (await callDelete()) as { bindingCount: number };

		expect(result.bindingCount).toBe(2);
		expect(result.bindingCount).not.toBe(snapshotBindingCount);
		expect(
			recordAuditFromRequest.mock.calls[0][1].metadata.bindingCount,
		).toBe(2);
	});
});

describe("prompts.delete — the audit trail", () => {
	// AE11. This is the one action in the module that removes rows belonging to
	// other tenants, so the row records who, which prompt, and how much.
	it("records the actor, the prompt and the removed counts for a SYSTEM deletion", async () => {
		await callDelete();

		expect(recordAuditFromRequest).toHaveBeenCalledTimes(1);
		const [context, entry] = recordAuditFromRequest.mock.calls[0];

		expect((context as { user: { id: string } }).user.id).toBe("user-1");
		expect(entry.action).toBe("prompt.system_deleted");
		expect(entry.category).toBe("audit");
		// Not merely "some id": `buildAuditRow` connects the organization
		// relation only when this is truthy, and the organization audit surface
		// filters strictly on `organizationId`. A null or undefined here writes
		// the record of the module's one cross-tenant action into a row no
		// tenant's audit view can reach. The gate above is what guarantees the
		// context always carries one by the time this runs.
		expect(entry.organizationId).toBe("org-1");
		expect(entry.organizationId).not.toBeUndefined();
		expect(entry.organizationId).not.toBeNull();
		expect(entry.resource).toEqual({
			type: "prompt",
			id: "prompt-1",
			name: "DO NOT USE - Story Drafter",
		});
		expect(entry.metadata).toMatchObject({
			promptKey: "story_drafter",
			promptRowCount: 2,
			bindingCount: 8,
			organizationCount: 3,
			personalOverrideUserCount: 1,
			retirementRecorded: true,
		});
		// Counts and labels only — the row names no tenant and no person, the
		// same restraint the impact read observes.
		expect(JSON.stringify(entry.metadata)).not.toContain("org-");
	});

	// An ordinary tenant deletion is already captured by the automatic activity
	// middleware (this route is a DELETE, which `isCapturableMethod` keeps), and
	// it reaches nobody else's rows. A curated row would be noise in the ledger
	// the cross-tenant ones have to be findable in.
	it("adds no curated row for an organization's own prompt", async () => {
		getPromptById.mockResolvedValue({
			id: "prompt-2",
			key: "story_drafter",
			name: "Team drafter",
			scope: "ORG",
			organizationId: "org-1",
			userId: null,
		});
		deletePrompt.mockResolvedValue({
			...REMOVED,
			scope: "ORG",
			promptRowCount: 1,
			retirementRecorded: false,
		});

		await callDelete("prompt-2");

		expect(recordAuditFromRequest).not.toHaveBeenCalled();
	});
});

describe("prompts.delete — failures", () => {
	// AE9. `P2025` is what both deletion paths raise for "the rows are gone":
	// the single-row delete raises it itself, and the SYSTEM path raises it from
	// its in-transaction recheck precisely because a multi-row delete would not.
	it("reports a prompt that has already gone as already deleted", async () => {
		deletePrompt.mockRejectedValue(
			Object.assign(new Error("no rows"), { code: "P2025" }),
		);

		await expect(callDelete()).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "This prompt has already been deleted",
		});
		expect(recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("reports a transaction timeout distinctly from a failed record write", async () => {
		deletePrompt.mockRejectedValue(
			Object.assign(
				new Error(
					"Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction.",
				),
				{ code: "P2028" },
			),
		);

		const timedOut = await callDelete().catch((error) => error);

		deletePrompt.mockRejectedValue(
			new Error("retirement record write failed"),
		);
		const writeFailed = await callDelete().catch((error) => error);

		// A timeout removed nothing and is worth retrying; a failed record write
		// means the deletion was abandoned so it could not become a prompt that
		// silently comes back. Reporting both as one message tells the operator
		// nothing about which happened.
		expect(timedOut.code).toBe("SERVICE_UNAVAILABLE");
		expect(timedOut.message).toContain("nothing was removed");
		expect(writeFailed.code).toBe("INTERNAL_SERVER_ERROR");
		expect(writeFailed.code).not.toBe(timedOut.code);
	});

	// Prisma reports an expired interactive transaction as
	// "The timeout for this transaction was 5000 ms" — never as "transaction
	// timed out", which is what the detector used to look for and what nothing
	// could ever match. Driven WITHOUT the `P2028` code so it is the message
	// arm being exercised: a driver adapter that passes the database's error
	// through untranslated is exactly the case the message arms are here for.
	it("recognises Prisma's own wording for an expired transaction", async () => {
		deletePrompt.mockRejectedValue(
			new Error(
				"Invalid `prisma.$transaction()` invocation: The timeout for this transaction was 60000 ms, however 60001 ms passed since the start of the transaction.",
			),
		);

		await expect(callDelete()).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			message: expect.stringContaining("nothing was removed"),
		});
	});

	// The deployment window between this code and its migration. The retirement
	// write happens inside the deletion's transaction, so a missing table aborts
	// the whole thing — nothing is removed, and neither the P2025 nor the
	// timeout classifier recognises it. Without this branch the operator reads
	// "Failed to delete prompt" and goes looking for a bug in the deletion.
	it.each([
		["Prisma's table-does-not-exist code", "P2021"],
		["Postgres' undefined_table SQLSTATE", "42P01"],
	])(
		"names the pending migration when %s comes back",
		async (_label, code) => {
			deletePrompt.mockRejectedValue(
				Object.assign(
					new Error(
						"The table `public.retired_prompt_key` does not exist in the current database.",
					),
					{ code },
				),
			);

			const error = await callDelete().catch((e) => e);

			expect(error.code).toBe("SERVICE_UNAVAILABLE");
			expect(error.message).toContain("retired_prompt_key");
			expect(error.message).toMatch(/migration/i);
			expect(error.message).toContain("nothing was removed");
			// Not the generic failure the operator used to get.
			expect(error.message).not.toBe("Failed to delete prompt");
			expect(recordAuditFromRequest).not.toHaveBeenCalled();
		},
	);

	it("recognises the missing table from the message when no code survives", async () => {
		// The driver adapter can hand back the database's text with no Prisma
		// code attached; the message arm is what covers that.
		deletePrompt.mockRejectedValue(
			new Error('relation "retired_prompt_key" does not exist'),
		);

		await expect(callDelete()).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			message: expect.stringMatching(/migration/i),
		});
	});

	it("passes an authorization refusal through untouched", async () => {
		const { ORPCError } = await import("@orpc/server");
		assertPromptDeleteAuthority.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "Only administrators can delete system prompts",
			}),
		);

		await expect(callDelete()).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Only administrators can delete system prompts",
		});
		expect(deletePrompt).not.toHaveBeenCalled();
		expect(recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("reports an unknown prompt id as not found", async () => {
		getPromptById.mockResolvedValue(null);

		await expect(callDelete("nope")).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Prompt not found",
		});
		expect(deletePrompt).not.toHaveBeenCalled();
	});
});
