import { ORPCError } from "@orpc/server";
import { deletePrompt, getPromptById } from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertPromptDeleteAuthority } from "../lib/scope-authority";

/**
 * Did the database say the rows this operation needed were not there?
 *
 * Duck-typed on the code rather than an `instanceof` check so the handler does
 * not have to import Prisma's error class (and so a test can hand it a plain
 * object carrying the code). `P2025` is Prisma's "an operation failed because
 * it depends on records that were required but not found" — raised by the
 * single-row delete on its own, and raised deliberately by the SYSTEM path's
 * in-transaction recheck, because a key-scoped multi-row delete removes zero
 * rows silently instead of raising anything.
 */
function isRecordNotFound(error: unknown): boolean {
	return (error as { code?: unknown } | null | undefined)?.code === "P2025";
}

/**
 * Did the transaction run out of time?
 *
 * Reported distinctly from a failed retirement write, because the two mean
 * opposite things to whoever is looking at the failure. A timeout means the
 * deletion took longer than the cascade budget and NOTHING was removed — the
 * right answer is to retry. A failed record write means the deletion itself is
 * sound but the durability guarantee could not be honoured, so the prompt was
 * deliberately left in place rather than deleted-and-resurrectable.
 */
function isTransactionTimeout(error: unknown): boolean {
	const code = (error as { code?: unknown } | null | undefined)?.code;
	if (code === "P2028") {
		return true;
	}
	const message = error instanceof Error ? error.message : "";
	return (
		message.includes("Transaction already closed") ||
		message.includes("Transaction API error") ||
		// Prisma's own wording when an interactive transaction outlives its
		// window: "The timeout for this transaction was 5000 ms". The phrase
		// this replaced — "transaction timed out" — is in no Prisma message,
		// so that branch could never have matched anything.
		message.includes("The timeout for this transaction was")
	);
}

/**
 * Did the database say `retired_prompt_key` is not there?
 *
 * A SYSTEM deletion records the key's retirement inside the same transaction
 * that removes the rows, so on a database that has not yet run that table's
 * migration the retirement write aborts the whole deletion — nothing is removed
 * and the caller gets a Prisma error neither classifier above recognises. That
 * is a real deployment window (code ahead of migrations), and the bare "Failed
 * to delete prompt" it used to produce sends an operator hunting for a bug in
 * the deletion instead of at the migration that has not run.
 *
 * The three signals are the ones `isMissingRetirementTable` uses in
 * `packages/database/prisma/queries/prompts.ts`, kept identical on purpose:
 * `P2021` is Prisma's "table does not exist in the current database", `42P01`
 * is Postgres' `undefined_table` SQLSTATE — which is what surfaces when the
 * driver adapter passes the database's error through untranslated — and the
 * message text covers the case where neither code survives the round trip.
 */
function isMissingRetirementTable(error: unknown): boolean {
	const code = (error as { code?: unknown } | null | undefined)?.code;
	if (
		code === "PROMPT_RETIREMENT_UNAVAILABLE" ||
		code === "P2021" ||
		code === "42P01"
	) {
		return true;
	}
	const message = error instanceof Error ? error.message : "";
	return message.includes("retired_prompt_key") && message.includes("exist");
}

export const deleteProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROMPT_DELETE))
	.route({
		method: "DELETE",
		path: "/prompts/:id",
		tags: ["Prompts"],
		summary: "Delete a prompt",
		description: "Delete a prompt (with authorization checks)",
	})
	.input(
		z.object({
			id: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		// An organization context must exist, and this is NOT redundant with
		// the `requirePermission` middleware above. That middleware returns
		// `next()` without evaluating any role when `tenantContext` is absent
		// or personal, so on its own it waves a global admin with no active
		// organization straight through to the most destructive action in this
		// module on the strength of the per-scope check alone. Under
		// `docs/adr/018-organization-is-the-only-tenant-context.md` a session
		// with no organization means resolution FAILED, and a deletion that
		// reaches every tenant's bindings is not a capability worth offering
		// from that state. The impact READ this deletion follows already
		// refuses it (`deletion-impact.ts`, gate 2) — the write must never be
		// the laxer of the two.
		//
		// Runs FIRST for the same reason it does there: a caller with no
		// organization has no business learning that a prompt id exists.
		const tenantContext = context.tenantContext;
		if (
			!tenantContext ||
			tenantContext.type !== "organization" ||
			!tenantContext.organizationId
		) {
			throw new ORPCError("FORBIDDEN", {
				message: "This operation requires an organization context",
			});
		}

		// Get existing prompt
		const existing = await getPromptById(input.id);

		if (!existing) {
			throw new ORPCError("NOT_FOUND", {
				message: "Prompt not found",
			});
		}

		// Authorization checks. Shared with the platform-wide impact read, which
		// is only legitimate because its caller could carry out this deletion.
		await assertPromptDeleteAuthority(existing, user);

		try {
			const removed = await deletePrompt({
				id: input.id,
				deletedBy: user.id,
			});

			// A SYSTEM deletion is the one action in this module that reaches
			// other tenants' rows, so it gets a curated row carrying what it
			// ACTUALLY removed rather than what the pre-flight snapshot
			// predicted (R12, R15). An ORG or USER deletion is already captured
			// by the automatic activity middleware — this route is a DELETE, so
			// `isCapturableMethod` keeps it — and adds nothing cross-tenant to
			// record. Category is explicitly "audit": the same forensic bucket
			// as the impact read this deletion follows, so the two halves of one
			// operator decision are found side by side.
			if (removed.scope === "SYSTEM") {
				recordAuditFromRequest(context, {
					action: "prompt.system_deleted",
					category: "audit",
					// From the validated context above, never an optional
					// chain: `buildAuditRow` connects the organization relation
					// only when the id is truthy, so `undefined` writes a row
					// with `organizationId: null` — and the organization audit
					// surface filters strictly on `organizationId`. A null there
					// makes the record of the one cross-tenant action in this
					// module unreachable from every tenant's audit view, which
					// is the opposite of what a curated forensic row is for.
					organizationId: tenantContext.organizationId,
					resource: {
						type: "prompt",
						id: existing.id,
						name: existing.name ?? null,
					},
					metadata: {
						promptKey: removed.promptKey,
						promptRowCount: removed.promptRowCount,
						bindingCount: removed.bindingCount,
						organizationCount: removed.organizationCount,
						personalOverrideUserCount:
							removed.personalOverrideUserCount,
						documentTypeCount: removed.documentTypeLabels.length,
						documentTypes: removed.documentTypeLabels,
						retirementRecorded: removed.retirementRecorded,
					},
				});
			}

			// The figures go back to the caller so the completion message
			// reports what happened rather than echoing the stale snapshot the
			// confirmation dialog showed (R15).
			return { success: true, ...removed };
		} catch (error) {
			if (error instanceof ORPCError) {
				throw error;
			}
			// Somebody else deleted it between the read above and the delete.
			// That is a race with a correct outcome, not an internal error
			// (R11) — and the SYSTEM path reports it only because it rechecks
			// inside the transaction.
			if (isRecordNotFound(error)) {
				throw new ORPCError("NOT_FOUND", {
					message: "This prompt has already been deleted",
				});
			}
			const message =
				error instanceof Error ? error.message : String(error);
			const stack = error instanceof Error ? error.stack : undefined;
			logger.error("[prompts.delete] Error deleting prompt", {
				promptId: input.id,
				userId: user.id,
				error: message,
				stack,
			});
			if (isTransactionTimeout(error)) {
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message:
						"The deletion took too long and was rolled back — nothing was removed. Try again.",
				});
			}
			// SERVICE_UNAVAILABLE rather than INTERNAL_SERVER_ERROR: nothing is
			// wrong with the request or the handler — the deployment is missing
			// a piece of schema this code depends on, and the same call
			// succeeds once the migration runs. The message names the migration
			// because that is the whole content of the answer; "Failed to
			// delete prompt" costs an operator the debugging session that ends
			// at `prisma migrate deploy`.
			if (isMissingRetirementTable(error)) {
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message:
						"This deployment has not yet created the retired_prompt_key table, so the deletion was rolled back and nothing was removed. Apply the pending database migration (20260902142708_retire_system_prompt), then delete again.",
				});
			}
			if (process.env.NODE_ENV === "development") {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: `Failed to delete prompt: ${message}`,
				});
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to delete prompt",
			});
		}
	});
