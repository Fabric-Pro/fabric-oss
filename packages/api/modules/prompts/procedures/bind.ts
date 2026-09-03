import { ORPCError } from "@orpc/client";
import {
	bindPromptVersion,
	bindPromptVersionToTargets,
	clearPromptBinding,
	listActionsForPrompt,
	listMyPromptOverrides,
	listPromptsForStages,
} from "@repo/database";
import {
	findPromptAgentTarget,
	promptDocumentTypeLabel,
} from "@repo/utils/prompt-action-catalog";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requireOrganizationAdmin,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import { announceDefaultChange } from "../lib/announce-default-change";
import { assertPromptVersionReachable } from "../lib/prompt-version-access";
import { resolveProjectForOrg } from "../lib/resolve-project-for-org";

/**
 * May this caller write a binding at this tier?
 *
 * The procedure-level gate is PROMPT_UPDATE, which every org MEMBER holds —
 * enough to bind a prompt for yourself, not enough to choose what another
 * tenant gets. The version check cannot carry this either: it passes
 * unconditionally for a SYSTEM version, and those are readable by everyone.
 *
 * Shared by every write path so a second one cannot be added with a weaker gate.
 */

async function assertMayBindAtScope({
	scope,
	isDefault: _isDefault,
	organizationId,
	projectId,
	user,
}: {
	scope: "SYSTEM" | "ORG" | "USER";
	isDefault?: boolean;
	organizationId: string | null | undefined;
	projectId?: string | null;
	user: { id: string; role?: string | null };
}) {
	if (scope === "SYSTEM" || scope === "USER") {
		// A project narrowing is meaningless at these tiers — SYSTEM is every
		// tenant's fallback and USER is already scoped to one person.
		if (projectId) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"A project scope applies only to organization-scope bindings",
			});
		}
	}

	if (scope === "SYSTEM") {
		// Platform admin (User.role), not an organization admin — a SYSTEM
		// binding is the default every tenant without an override falls back to.
		if (user.role !== "admin") {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only a platform admin can set a system-wide default prompt",
			});
		}
		return;
	}

	if (scope === "ORG") {
		if (!organizationId) {
			// Otherwise this writes scope ORG with a null organizationId — a
			// row no tenant can ever resolve.
			throw new ORPCError("BAD_REQUEST", {
				message:
					"An organization is required to bind a prompt at organization scope",
			});
		}
		// Every ORG write is an org-admin action, including one that clears
		// isDefault and including the project-narrowed variant — there are no
		// project-level roles yet, so the org admins are the writers.
		await requireOrganizationAdmin(organizationId, user.id);
	}
}

/**
 * A tier's default must be backed by content of at least that tier.
 *
 * Otherwise the default rests on a prompt one person can edit or delete, and
 * `assertPromptVersionReachable` permits exactly that for the caller's own.
 * Promoting a personal prompt upward is what the nomination flow is for.
 */
function assertVersionSuitsScope(
	scope: "SYSTEM" | "ORG" | "USER",
	// PromptVersion.scope is nullable in the schema; a version with no scope
	// is not system or org content, so it fails both checks below as it should.
	versionScope: string | null,
) {
	if (scope === "SYSTEM" && versionScope !== "SYSTEM") {
		throw new ORPCError("BAD_REQUEST", {
			message: "A system-wide default must use a system-scoped prompt",
		});
	}

	if (
		scope === "ORG" &&
		versionScope !== "ORG" &&
		versionScope !== "SYSTEM"
	) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"An organization default must use an organization or system prompt — fork this prompt to the organization first",
		});
	}
}

export const bindProcedures = {
	set: tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.PROMPT_UPDATE))
		.route({
			method: "PUT",
			path: "/prompts/bind",
			tags: ["Prompts"],
			summary:
				"Bind a prompt version to a target (agent/feature) for a specific document type",
		})
		.input(
			z.object({
				targetType: z.enum(["AGENT", "FEATURE"]),
				targetKey: z.string(),
				documentType: z.string().min(1, "Document type is required"),
				// Exact-match scoping for stage bindings. Null/omit = non-stage binding.
				storyKind: z.enum(["FEATURE", "BUG"]).nullable().optional(),
				scope: z.enum(["SYSTEM", "ORG", "USER"]),
				organizationId: z.string().nullable().optional(),
				/** Narrows an ORG binding to one project (the PROJECT tier). */
				projectId: z.string().nullable().optional(),
				promptVersionId: z.string(),
				isDefault: z.boolean().optional().default(false),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const user = context.user;
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);

			// Tier compatibility FIRST, so a projectId on SYSTEM/USER fails with
			// the scope message rather than a membership lookup's refusal.
			await assertMayBindAtScope({
				scope: input.scope,
				isDefault: input.isDefault,
				organizationId,
				projectId: input.projectId,
				user,
			});

			const projectId = await resolveProjectForOrg(
				input.projectId,
				organizationId,
			);

			const pv = await assertPromptVersionReachable({
				promptVersionId: input.promptVersionId,
				organizationId,
				userId: user.id,
			});
			assertVersionSuitsScope(input.scope, pv.scope);

			const record = await bindPromptVersion({
				targetType: input.targetType,
				targetKey: input.targetKey,
				documentType: input.documentType,
				storyKind: input.storyKind ?? null,
				scope: input.scope,
				userId: input.scope === "USER" ? user.id : undefined,
				organizationId:
					input.scope === "ORG" ? organizationId : undefined,
				projectId:
					input.scope === "ORG" ? (projectId ?? null) : undefined,
				promptVersionId: input.promptVersionId,
				isDefault: input.isDefault,
				callerUserId: user.id,
			});

			if (input.isDefault) {
				await announceDefaultChange({
					scope: input.scope,
					organizationId,
					targetKey: input.targetKey,
					documentType: input.documentType,
					storyKind: input.storyKind ?? null,
					promptVersionId: input.promptVersionId,
					actorUserId: user.id,
				});
			}

			return record;
		}),

	/**
	 * Clear one tier's override for a target, letting the effective default
	 * fall through to the tier below.
	 *
	 * Gated exactly as `set` is: clearing changes which prompt everyone at and
	 * below the tier receives, so it is the same authority. Gating only the
	 * write would let a member reach the same outcome by removing the admin's
	 * row instead of replacing it.
	 */
	/**
	 * The caller's own personal defaults across all actions ("My Overrides",
	 * Fizzy #2068 F8). Read-only, and scoped to the session user — the same
	 * rule as every USER-surface here: the identity comes from the session,
	 * never from the request.
	 */
	listMine: tenantProtectedProcedure
		.use(requirePermission(Permissions.PROMPT_READ))
		.route({
			method: "GET",
			path: "/prompts/bind/mine",
			tags: ["Prompts"],
			summary: "List my personal default overrides across actions",
		})
		// Takes nothing — the identity comes from the session. The builder still
		// requires an input schema before `.output`, so declare the empty one,
		// as the other no-argument procedures here do.
		.input(z.object({}))
		.output(z.any())
		.handler(async ({ context }) => {
			const rows = await listMyPromptOverrides({
				userId: context.user.id,
			});
			return rows.map((row) => {
				const agent = findPromptAgentTarget(row.targetKey);
				return {
					targetKey: row.targetKey,
					documentType: row.documentType,
					storyKind: row.storyKind ?? null,
					actionLabel: agent
						? `${agent.label} — ${promptDocumentTypeLabel(row.documentType)}`
						: promptDocumentTypeLabel(row.documentType),
					promptId: row.promptVersion.prompt.id,
					promptName: row.promptVersion.prompt.name,
					promptVersionId: row.promptVersionId,
					updatedAt: row.updatedAt,
				};
			});
		}),

	clear: tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.PROMPT_UPDATE))
		.route({
			method: "DELETE",
			path: "/prompts/bind",
			tags: ["Prompts"],
			summary: "Clear a tier's default prompt binding for a target",
		})
		.input(
			z.object({
				targetType: z.enum(["AGENT", "FEATURE"]),
				targetKey: z.string(),
				documentType: z.string().min(1, "Document type is required"),
				storyKind: z.enum(["FEATURE", "BUG"]).nullable().optional(),
				scope: z.enum(["SYSTEM", "ORG", "USER"]),
				organizationId: z.string().nullable().optional(),
				/** Clearing the PROJECT tier targets exactly that row. */
				projectId: z.string().nullable().optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const user = context.user;
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);

			// Tier compatibility FIRST — see the single-action handler in `set`.
			if (input.scope !== "ORG" && input.projectId) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"A project scope applies only to organization-scope bindings",
				});
			}

			const projectId = await resolveProjectForOrg(
				input.projectId,
				organizationId,
			);

			if (input.scope === "SYSTEM") {
				if (user.role !== "admin") {
					throw new ORPCError("FORBIDDEN", {
						message:
							"Only a platform admin can clear the system-wide default prompt",
					});
				}
			} else if (input.scope === "ORG") {
				if (!organizationId) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"An organization is required to clear a prompt binding at organization scope",
					});
				}
				await requireOrganizationAdmin(organizationId, user.id);
			}

			// The personal identity comes from the session, never the input, so
			// nothing here can point at somebody else's override.
			return await clearPromptBinding({
				targetType: input.targetType,
				targetKey: input.targetKey,
				documentType: input.documentType,
				storyKind: input.storyKind ?? null,
				scope: input.scope,
				userId: input.scope === "USER" ? user.id : undefined,
				organizationId:
					input.scope === "ORG" ? organizationId : undefined,
				projectId:
					input.scope === "ORG" ? (projectId ?? null) : undefined,
			});
		}),

	/**
	 * Bind one prompt to several actions at once (FR19).
	 *
	 * Same tier authorization as `set`, applied once to the whole request: the
	 * scope is one value for every target, so checking per target would ask the
	 * identical question N times. Provenance is checked once for the same
	 * reason — it is one prompt version.
	 *
	 * All or nothing. Half-applied is a state nobody asked for and the UI would
	 * report as success.
	 */
	setMany: tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.PROMPT_UPDATE))
		.route({
			method: "PUT",
			path: "/prompts/bind/many",
			tags: ["Prompts"],
			summary: "Bind one prompt version to several actions at once",
		})
		.input(
			z.object({
				targets: z
					.array(
						z.object({
							targetType: z.enum(["AGENT", "FEATURE"]),
							targetKey: z.string(),
							documentType: z
								.string()
								.min(1, "Document type is required"),
							storyKind: z
								.enum(["FEATURE", "BUG"])
								.nullable()
								.optional(),
						}),
					)
					.min(1, "Select at least one action"),
				scope: z.enum(["SYSTEM", "ORG", "USER"]),
				organizationId: z.string().nullable().optional(),
				/** Narrows an ORG binding to one project (the PROJECT tier). */
				projectId: z.string().nullable().optional(),
				promptVersionId: z.string(),
				isDefault: z.boolean().optional().default(false),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const user = context.user;
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);
			// Tier compatibility FIRST — see the single-action handler above.
			await assertMayBindAtScope({
				scope: input.scope,
				isDefault: input.isDefault,
				organizationId,
				projectId: input.projectId,
				user,
			});

			const projectId = await resolveProjectForOrg(
				input.projectId,
				organizationId,
			);

			const pv = await assertPromptVersionReachable({
				promptVersionId: input.promptVersionId,
				organizationId,
				userId: user.id,
			});
			assertVersionSuitsScope(input.scope, pv.scope);

			const result = await bindPromptVersionToTargets({
				targets: input.targets.map((t) => ({
					targetType: t.targetType,
					targetKey: t.targetKey,
					documentType: t.documentType,
					storyKind: t.storyKind ?? null,
				})),
				scope: input.scope,
				userId: input.scope === "USER" ? user.id : undefined,
				organizationId:
					input.scope === "ORG" ? organizationId : undefined,
				projectId:
					input.scope === "ORG" ? (projectId ?? null) : undefined,
				promptVersionId: input.promptVersionId,
				isDefault: input.isDefault,
				callerUserId: user.id,
			});

			if (input.isDefault) {
				// One announcement per action. Each is a separate thing a reader
				// may be subject to, and the dedupe key includes the action, so
				// they coalesce per action rather than collapsing into one.
				for (const target of input.targets) {
					await announceDefaultChange({
						scope: input.scope,
						organizationId,
						targetKey: target.targetKey,
						documentType: target.documentType,
						storyKind: target.storyKind ?? null,
						promptVersionId: input.promptVersionId,
						actorUserId: user.id,
					});
				}
			}

			return result;
		}),

	/**
	 * The actions one prompt is bound to.
	 *
	 * Read before saving an edit: the content is shared, so every action bound
	 * to the prompt takes the change together, and the editor says so rather
	 * than letting the reach be discovered afterwards.
	 */
	listForPrompt: tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.PROMPT_READ))
		.route({
			method: "GET",
			path: "/prompts/:promptId/actions",
			tags: ["Prompts"],
			summary: "List the actions a prompt is currently bound to",
		})
		.input(
			z.object({
				promptId: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);

			const actions = await listActionsForPrompt({
				promptId: input.promptId,
				userId: context.user.id,
				organizationId: organizationId ?? undefined,
			});

			return { actions };
		}),

	listForStages: tenantProtectedProcedure
		.use(requirePermission(Permissions.PROMPT_READ))
		.route({
			method: "GET",
			path: "/prompts/bind/list-for-stages",
			tags: ["Prompts"],
			summary:
				"List all prompts bound to each (agent, documentType) pair, with default markers",
		})
		.input(
			z.object({
				targetType: z.literal("AGENT"),
				targetKey: z.string(),
				documentTypes: z.array(z.string().min(1)).min(1),
				// Exact-match against PromptBinding.storyKind. Omit for non-kind-scoped
				// bindings (matches storyKind IS NULL); pass "BUG"/"FEATURE" for stage tabs.
				storyKind: z.enum(["FEATURE", "BUG"]).nullable().optional(),
				organizationId: z.string().nullable().optional(),
				/** Include PROJECT-tier bindings for this project. */
				projectId: z.string().nullable().optional(),
				scope: z.enum(["SYSTEM", "ORG", "USER"]).optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const user = context.user;
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);
			const projectId = await resolveProjectForOrg(
				input.projectId,
				organizationId,
			);

			if (organizationId) {
				const membership = await verifyOrganizationMembership(
					organizationId,
					user.id,
				);

				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}
			}

			return await listPromptsForStages({
				agentName: input.targetKey,
				documentTypes: input.documentTypes,
				storyKind: input.storyKind ?? null,
				userId: user.id,
				organizationId: organizationId ?? null,
				projectId,
				scope: input.scope,
			});
		}),
};
