import { ORPCError } from "@orpc/client";
import {
	approvePromptNomination,
	createPromptNomination,
	db,
	declinePromptNomination,
	getBoundPromptVersion,
	getNominationById,
	listPendingNominations,
	withdrawPromptNomination,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requireOrganizationAdmin,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { announceDefaultChange } from "../lib/announce-default-change";
import { announceNomination } from "../lib/announce-nomination";
import { summariseNominationChange } from "../lib/nomination-summary";
import {
	assertNominatedVersionReachable,
	assertPromptVersionReachable,
} from "../lib/prompt-version-access";

/**
 * Nominating a prompt as a shared default, and reviewing what was nominated.
 *
 * Fizzy #2068 FR15-FR18, FR22, FR23. The tier model is the one the rest of this
 * module uses: a personal default needs nobody's approval, so nomination exists
 * only for ORG and SYSTEM.
 */

const targetSchema = z.object({
	targetKey: z.string().min(1),
	documentType: z.string().min(1),
	storyKind: z.enum(["FEATURE", "BUG"]).nullable().optional(),
});

/**
 * May this caller decide a nomination at this tier?
 *
 * Deliberately the same authority as writing the binding directly
 * (`assertMayBindAtScope` in bind.ts): approving IS binding, so a weaker gate
 * here would be a second, easier route to the same write. Anyone may nominate;
 * only the person who could have set the default may accept one.
 */
async function assertMayReviewAtScope({
	targetScope,
	organizationId,
	user,
}: {
	targetScope: "SYSTEM" | "ORG";
	organizationId: string | null | undefined;
	user: { id: string; role?: string | null };
}) {
	if (targetScope === "SYSTEM") {
		if (user.role !== "admin") {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only a platform admin can review a system-wide default nomination",
			});
		}
		return;
	}

	if (!organizationId) {
		throw new ORPCError("BAD_REQUEST", {
			message: "An organization is required to review this nomination",
		});
	}
	await requireOrganizationAdmin(organizationId, user.id);
}

/** The row, plus the tier check its own stored scope demands. */
async function loadReviewableNomination({
	nominationId,
	user,
	sessionOrganizationId,
}: {
	nominationId: string;
	user: { id: string; role?: string | null };
	sessionOrganizationId: string | null | undefined;
}) {
	const nomination = await getNominationById(nominationId);
	if (!nomination) {
		throw new ORPCError("NOT_FOUND", { message: "Nomination not found" });
	}
	if (nomination.status !== "PENDING") {
		// Not a state the UI should offer, but two admins can hold the same
		// queue open. Say which way it went rather than silently re-deciding.
		throw new ORPCError("CONFLICT", {
			message: `This nomination was already ${nomination.status.toLowerCase()}`,
		});
	}
	// Bound to a local so the narrowing survives into the return type — the
	// column is PromptScope, which includes USER, and a USER row here would be
	// a personal default that never needed reviewing.
	const targetScope = nomination.targetScope;
	if (targetScope !== "SYSTEM" && targetScope !== "ORG") {
		throw new ORPCError("BAD_REQUEST", {
			message: "This nomination has no reviewable scope",
		});
	}

	// The gate is driven by the ROW's scope and organization, never by what the
	// caller sent: an org admin of org A must not reach org B's nomination by
	// passing their own organizationId alongside B's nomination id.
	await assertMayReviewAtScope({
		targetScope,
		organizationId: nomination.organizationId,
		user,
	});

	if (
		targetScope === "ORG" &&
		nomination.organizationId !== sessionOrganizationId
	) {
		throw new ORPCError("FORBIDDEN", {
			message: "This nomination belongs to a different organization",
		});
	}

	return { ...nomination, targetScope };
}

export const nominateProcedures = {
	/**
	 * Propose a prompt as the default for one or more actions (FR15).
	 *
	 * Gated at PROMPT_UPDATE, which every member holds — proposing is the point
	 * of the feature, and a proposal changes nothing until an admin accepts it.
	 */
	create: tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.PROMPT_UPDATE))
		.route({
			method: "POST",
			path: "/prompts/nominations",
			tags: ["Prompts"],
			summary: "Nominate a prompt as the default for one or more actions",
		})
		.input(
			z.object({
				promptVersionId: z.string(),
				targetScope: z.enum(["SYSTEM", "ORG"]),
				organizationId: z.string().nullable().optional(),
				targets: z.array(targetSchema).min(1),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const user = context.user;
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);

			if (input.targetScope === "ORG" && !organizationId) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"An organization is required to nominate an organization default",
				});
			}

			// Before anything reads the body: a version is referenced by id, and
			// the nomination flow SHOWS that body to a reviewing admin. Without
			// this, one member could put another tenant's private prompt in
			// front of their own admin — and bind it if the admin approves.
			await assertPromptVersionReachable({
				promptVersionId: input.promptVersionId,
				organizationId,
				userId: user.id,
			});

			const version = await db.promptVersion.findUnique({
				where: { id: input.promptVersionId },
				select: {
					id: true,
					content: true,
					prompt: { select: { id: true, name: true } },
				},
			});
			if (!version) {
				throw new ORPCError("NOT_FOUND", {
					message: "Prompt version not found",
				});
			}

			// Summarise against the default the first proposed action currently
			// resolves to. One comparison, not one per target: a nomination is a
			// single argument for a single prompt, and N summaries would be N
			// model calls making it N times.
			const first = input.targets[0];
			const current = await getBoundPromptVersion({
				targetType: "AGENT",
				targetKey: first.targetKey,
				documentType: first.documentType,
				storyKind: first.storyKind ?? null,
				userId: user.id,
				organizationId: organizationId ?? undefined,
			});

			const { summary, degraded } = await summariseNominationChange({
				proposedContent: version.content,
				currentContent: current?.content ?? null,
				userId: user.id,
				organizationId,
			});

			const nomination = await createPromptNomination({
				promptVersionId: input.promptVersionId,
				nominatedById: user.id,
				targetScope: input.targetScope,
				organizationId:
					input.targetScope === "ORG" ? organizationId : null,
				targets: input.targets.map((t) => ({
					targetKey: t.targetKey,
					documentType: t.documentType,
					storyKind: t.storyKind ?? null,
				})),
				changeSummary: summary,
				summaryDegraded: degraded,
			});

			// FR16: tell the admins who can decide it. Without this a proposal
			// only exists for someone who happens to open the queue, which for
			// a feature nobody has a habit of visiting means never.
			//
			// Fire-and-forget, like the default-changed announcement: the
			// nomination is written and correct, and a notification failure must
			// not fail the caller's request or imply the proposal was lost.
			await announceNomination({
				nomination,
				targetScope: input.targetScope,
				organizationId,
				targets: input.targets,
				promptId: version.prompt.id,
				promptName: version.prompt.name,
				summary,
				degraded,
				actor: user,
			});

			return nomination;
		}),

	/**
	 * The review queue for a tier (FR18).
	 *
	 * Gated as deciding one is: the queue names who proposed what, and that is
	 * not a member's business to read.
	 */
	listPending: tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.PROMPT_UPDATE))
		.route({
			method: "GET",
			path: "/prompts/nominations",
			tags: ["Prompts"],
			summary: "List pending prompt-default nominations for a tier",
		})
		.input(
			z.object({
				targetScope: z.enum(["SYSTEM", "ORG"]),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);

			await assertMayReviewAtScope({
				targetScope: input.targetScope,
				organizationId,
				user: context.user,
			});

			return await listPendingNominations({
				targetScope: input.targetScope,
				organizationId,
			});
		}),

	/**
	 * Accept a nomination: bind the prompt, close the competing proposals, tell
	 * the people it now applies to (FR17, FR18, FR23).
	 */
	approve: tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.PROMPT_UPDATE))
		.route({
			method: "POST",
			path: "/prompts/nominations/approve",
			tags: ["Prompts"],
			summary: "Approve a prompt-default nomination",
		})
		.input(
			z.object({
				nominationId: z.string(),
				organizationId: z.string().nullable().optional(),
				// FR23: the reviewer may narrow or widen the action set before
				// accepting. Omitted means "as proposed".
				targets: z.array(targetSchema).min(1).optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const user = context.user;
			const sessionOrganizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);

			const nomination = await loadReviewableNomination({
				nominationId: input.nominationId,
				user,
				sessionOrganizationId,
			});

			// The row stores an id, and approval happens later and by someone
			// else. Re-derive entitlement from the NOMINATOR: a row written
			// before this check existed, or a nominator who has since left the
			// organization whose prompt they proposed, must not become a live
			// binding on the strength of the reviewer's own access.
			await assertNominatedVersionReachable({
				promptVersionId: nomination.promptVersionId,
				nominatedById: nomination.nominatedById,
			});

			const proposed = Array.isArray(nomination.targets)
				? (nomination.targets as z.infer<typeof targetSchema>[])
				: [];
			const targets = (input.targets ?? proposed).map((t) => ({
				targetKey: t.targetKey,
				documentType: t.documentType,
				storyKind: t.storyKind ?? null,
			}));

			if (targets.length === 0) {
				throw new ORPCError("BAD_REQUEST", {
					message: "A nomination must name at least one action",
				});
			}

			const targetScope = nomination.targetScope;
			const result = await approvePromptNomination({
				nominationId: input.nominationId,
				reviewedById: user.id,
				targets,
				promptVersionId: nomination.promptVersionId,
				targetScope,
				organizationId: nomination.organizationId,
			});

			// FR6 again: the tier's default just changed, and the people it
			// changed for did not ask for it. Same announcement as setting one
			// directly, because from their side it is the same event.
			for (const target of targets) {
				await announceDefaultChange({
					scope: targetScope,
					organizationId: nomination.organizationId,
					targetKey: target.targetKey,
					documentType: target.documentType,
					storyKind: target.storyKind,
					promptVersionId: nomination.promptVersionId,
					actorUserId: user.id,
				});
			}

			return result;
		}),

	/** Decline a nomination (FR17) — recorded, and silent to the nominator. */
	decline: tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.PROMPT_UPDATE))
		.route({
			method: "POST",
			path: "/prompts/nominations/decline",
			tags: ["Prompts"],
			summary: "Decline a prompt-default nomination",
		})
		.input(
			z.object({
				nominationId: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const sessionOrganizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);

			await loadReviewableNomination({
				nominationId: input.nominationId,
				user: context.user,
				sessionOrganizationId,
			});

			return await declinePromptNomination({
				nominationId: input.nominationId,
				reviewedById: context.user.id,
			});
		}),

	/**
	 * Withdraw your own nomination (FR22).
	 *
	 * No tier gate: this is not a review. The ownership check lives in the
	 * update's own WHERE clause so it cannot be raced past.
	 */
	withdraw: tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.PROMPT_UPDATE))
		.route({
			method: "POST",
			path: "/prompts/nominations/withdraw",
			tags: ["Prompts"],
			summary: "Withdraw your own prompt-default nomination",
		})
		.input(
			z.object({
				nominationId: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const { withdrawn } = await withdrawPromptNomination({
				nominationId: input.nominationId,
				nominatedById: context.user.id,
			});

			if (!withdrawn) {
				// One message for "not yours" and for "already decided" on
				// purpose: telling them apart tells a stranger the id exists.
				throw new ORPCError("NOT_FOUND", {
					message: "No pending nomination of yours matches that id",
				});
			}

			return { withdrawn };
		}),
};
