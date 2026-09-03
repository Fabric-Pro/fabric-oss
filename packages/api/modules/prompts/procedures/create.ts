import { ORPCError } from "@orpc/server";
import { createPrompt } from "@repo/database";
import { logger } from "@repo/logs";
import type { TemplateFormat } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import { assertValidTemplate } from "../lib/assert-valid-template";

const PromptFormatSchema = z.enum([
	"PLAIN_TEXT",
	"MARKDOWN",
	"HANDLEBARS",
	"MUSTACHE",
	"LIQUID",
	"JINJA2",
]);

const PromptScopeSchema = z.enum(["SYSTEM", "ORG", "USER"]);

/**
 * Did the database layer refuse this key because its retirement is on record?
 *
 * Duck-typed on the code, exactly like the `P2025` check in `./delete.ts`, so
 * the handler does not import the error class and a test can hand it a plain
 * object carrying the code. The code is `PromptKeyRetiredError.code` in
 * `packages/database/prisma/queries/prompts.ts`.
 */
function isRetiredPromptKey(error: unknown): boolean {
	return (
		(error as { code?: unknown } | null | undefined)?.code ===
		"PROMPT_KEY_RETIRED"
	);
}

/**
 * Did the guarded insert run out of time?
 *
 * The same detector as `./delete.ts`, and this path needs it for a reason that
 * detector's own budget spells out: a SYSTEM creation waits on the per-key
 * retirement lock, its transaction ceiling is deliberately BELOW the deletion's
 * cascade budget, and the documented outcome of losing that race is "it fails
 * instead, and the retry gets the refusal". A retry is only reachable if the
 * failure says to retry — an administrator who reads "Transaction already
 * closed" is being shown a database internal in place of the one instruction
 * that resolves it.
 *
 * Duck-typed on the code and the message, exactly like the retired-key check
 * above: this handler does not import Prisma's error class, and a test can hand
 * it a plain object.
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
		message.includes("The timeout for this transaction was")
	);
}

export const createProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROMPT_CREATE))
	.route({
		method: "POST",
		path: "/prompts",
		tags: ["Prompts"],
		summary: "Create a new prompt",
		description:
			"Create a new prompt (admin for system-level, org admin for org-level, any user for user-level)",
	})
	.input(
		z.object({
			key: z.string().min(1).max(255),
			name: z.string().min(1).max(255),
			description: z.string().optional(),
			scope: PromptScopeSchema,
			organizationId: z.string().nullable().optional(),
			format: PromptFormatSchema.default("PLAIN_TEXT"),
			category: z.string().optional(),
			tags: z.array(z.string()).default([]),
			isPublic: z.boolean().default(false),
			initialContent: z.string().optional(),
			initialVariables: z.record(z.string(), z.any()).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// A body that cannot render under its own format is rejected here rather
		// than at generation time, where it is a log line nobody is watching.
		if (input.initialContent) {
			assertValidTemplate(
				input.format as TemplateFormat,
				input.initialContent,
			);
		}

		// Authorization checks
		if (input.scope === "SYSTEM") {
			// Only admins can create system prompts
			if (user.role !== "admin") {
				throw new ORPCError("FORBIDDEN", {
					message: "Only administrators can create system prompts",
				});
			}
		} else if (input.scope === "ORG") {
			// Verify organization membership and admin role
			if (!organizationId) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Organization ID is required for organization-scoped prompts",
				});
			}

			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}

			if (membership.role !== "admin" && membership.role !== "owner") {
				throw new ORPCError("FORBIDDEN", {
					message:
						"Only organization admins can create organization prompts",
				});
			}
		}
		// USER scope - any authenticated user can create

		try {
			const prompt = await createPrompt({
				key: input.key,
				name: input.name,
				description: input.description,
				scope: input.scope as any,
				userId: input.scope === "USER" ? user.id : undefined,
				organizationId:
					input.scope === "ORG" ? organizationId : undefined,
				format: input.format as any,
				category: input.category,
				tags: input.tags,
				isPublic: input.isPublic,
				createdBy: user.id,
				initialContent: input.initialContent,
				initialVariables: input.initialVariables,
			});

			return { prompt };
		} catch (error) {
			// A retired key is a REFUSAL, not a failure: the platform recorded
			// that this system prompt was deliberately deleted, and recreating
			// it here would be an unaudited restore under the same name (R9).
			// The message names the operator path because it is the only way
			// back — an administrator who cannot see that reads a 500 and
			// retries, which is how the "DO NOT USE" prompts came back before.
			if (isRetiredPromptKey(error)) {
				throw new ORPCError("CONFLICT", {
					message: `The prompt key "${input.key}" was retired when its system prompt was deleted, so it cannot be created again from here. Restoring it is an operator action: remove the retirement record for this key, then run the prompt catalogue seed.`,
				});
			}
			if (error instanceof ORPCError) {
				throw error;
			}
			const message =
				error instanceof Error ? error.message : String(error);
			const stack = error instanceof Error ? error.stack : undefined;
			logger.error("[prompts.create] Error creating prompt", {
				promptKey: input.key,
				scope: input.scope,
				userId: user.id,
				error: message,
				stack,
			});
			// The lock this creation waits on is usually held by a deletion of
			// the same key, so a timeout here most often means that deletion is
			// still cascading. Retrying is the right move and the retry is the
			// one that learns the key is now retired — but only if the failure
			// says so instead of handing back the raw Prisma text.
			if (isTransactionTimeout(error)) {
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message:
						"The creation took too long and was rolled back — nothing was created. Try again.",
				});
			}
			// Anything left is unclassified, and it must not reach the client
			// as a raw database error: the whole point of this catch is that an
			// administrator reads a sentence about prompts. Same shape as
			// `./delete.ts`, dev-only detail included, so the two halves of the
			// retirement guard fail the same way as each other.
			if (process.env.NODE_ENV === "development") {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: `Failed to create prompt: ${message}`,
				});
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to create prompt",
			});
		}
	});
