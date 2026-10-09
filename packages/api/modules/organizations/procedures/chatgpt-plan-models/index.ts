/**
 * Which ChatGPT plan model runs which kind of work in the organization
 * (Fizzy #2770). The organization decides; members' own plans and its shared
 * accounts all run its choice. Every member may read it — the plan card and
 * the connect page show it — and only admins and owners change it, never
 * while acting as another user for the fallback model. The organization is
 * the session's; nothing in the input names one. With `CHATGPT_PLAN` off
 * every procedure answers NOT_FOUND; pooling plays no part.
 *
 * The models offered are the catalog's plan models that one of the
 * organization's plans lists as served (Fizzy #2770 F8); before any plan was
 * checked, all of them. A list older than a day is refreshed in the
 * background on read.
 */

import { ORPCError } from "@orpc/server";
import { refreshStaleChatGptPlanServedModels } from "@repo/ai/lib/chatgpt-plan/served-models";
import type { PlanSourceRef } from "@repo/ai/lib/chatgpt-plan/sources";
import {
	CHATGPT_PLAN_MODEL_TASK_TYPES,
	type ChatGptPlanServedModel,
	chatGptPlanModelLabel,
	DEFAULT_CHATGPT_PLAN_FALLBACK_MODEL,
	getChatGptPlanOrgModelChoices,
	getChatGptPlanOrgPolicy,
	getChatGptPlanServedModels,
	isFeatureEnabled,
	listChatGptPlanModels,
	listChatGptPlanOrgSources,
	setChatGptPlanOrgFallbackModel,
	setChatGptPlanOrgModel,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../lib/membership";

const taskTypeSchema = z.enum(CHATGPT_PLAN_MODEL_TASK_TYPES);

const choicesSchema = z.object({
	tasks: z.array(
		z.object({
			taskType: taskTypeSchema,
			model: z
				.object({ canonicalName: z.string(), displayName: z.string() })
				.nullable(),
			source: z.enum(["organization", "default"]),
			/** No plan of the organization lists the model any more; calls use the fallback. */
			noLongerServed: z.boolean(),
		}),
	),
	models: z.array(
		z.object({
			canonicalName: z.string(),
			/** The model id a plan call names; what the fallback setting stores. */
			slug: z.string(),
			displayName: z.string(),
			description: z.string().nullable(),
			/** Added from a plan's model list rather than seeded. */
			autoDetected: z.boolean(),
			/** OpenAI lists it first: its newest or most capable model. */
			newest: z.boolean(),
		}),
	),
	/** The model a call retries on when the plan refuses the chosen one; null for none. */
	fallbackModel: z.string().nullable(),
	recommendedFallbackModel: z.string(),
	/** When a plan's model list was last read; null before any was. */
	servedCheckedAt: z.date().nullable(),
	/** Members whose own ACTIVE plan is turned on in this organization. */
	ownPlanMembers: z.number(),
	canEdit: z.boolean(),
});

async function requirePlanOrganization(context: {
	user: { id: string };
	session: { activeOrganizationId?: string | null };
}): Promise<{ organizationId: string; role: string }> {
	const organizationId = resolveOrganizationId(undefined, context.session);
	if (
		!organizationId ||
		!(await isFeatureEnabled("CHATGPT_PLAN", organizationId))
	) {
		throw new ORPCError("NOT_FOUND", {
			message: "ChatGPT plans are not available here",
		});
	}
	const membership = await requireOrgMembership(
		context.user.id,
		organizationId,
	);
	if (!membership) {
		throw new ORPCError("FORBIDDEN", {
			message: "You are not a member of this organization",
		});
	}
	return { organizationId, role: membership.role };
}

function toPlanSource(
	organizationId: string,
	source: { sourceKind: "USER" | "ORG"; sourceId: string },
): PlanSourceRef {
	return source.sourceKind === "USER"
		? { kind: "user", userId: source.sourceId }
		: { kind: "org", organizationId, accountId: source.sourceId };
}

/** The slug OpenAI lists first (lowest priority) among served models. */
function newestSlug(rows: ChatGptPlanServedModel[]): string | null {
	const ranked = rows
		.filter((row) => row.priority !== null)
		.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
	return ranked[0]?.slug ?? null;
}

async function choicesFor(organizationId: string, canEdit: boolean) {
	const sources = await listChatGptPlanOrgSources(organizationId);
	const [tasks, catalog, policy, rows] = await Promise.all([
		getChatGptPlanOrgModelChoices(organizationId),
		listChatGptPlanModels(),
		getChatGptPlanOrgPolicy(organizationId),
		getChatGptPlanServedModels(sources),
	]);
	try {
		refreshStaleChatGptPlanServedModels(
			sources.map((source) => toPlanSource(organizationId, source)),
			rows,
		);
	} catch (error) {
		logger.warn("[chatgpt-plan] Starting a model-list refresh failed", {
			organizationId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	// Before any plan was checked nothing is known to be unserved.
	const served =
		rows.length > 0 ? new Set(rows.map((row) => row.slug)) : null;
	const newest = newestSlug(rows);
	const slugOf = new Map(
		catalog.map((model) => [model.canonicalName, model.slug]),
	);
	const checked = rows.map((row) => row.checkedAt.getTime());
	return {
		tasks: tasks.map((task) => {
			const slug = task.model
				? (slugOf.get(task.model.canonicalName) ??
					task.model.canonicalName)
				: null;
			return {
				...task,
				model: task.model
					? {
							canonicalName: task.model.canonicalName,
							displayName: chatGptPlanModelLabel(
								task.model.displayName,
							),
						}
					: null,
				noLongerServed: Boolean(served && slug && !served.has(slug)),
			};
		}),
		models: catalog
			.filter((model) => !served || served.has(model.slug))
			.map((model) => ({ ...model, newest: model.slug === newest })),
		fallbackModel: policy.fallbackModel,
		recommendedFallbackModel: DEFAULT_CHATGPT_PLAN_FALLBACK_MODEL,
		servedCheckedAt:
			checked.length > 0 ? new Date(Math.max(...checked)) : null,
		ownPlanMembers: sources.filter((source) => source.sourceKind === "USER")
			.length,
		canEdit,
	};
}

export const getChatGptPlanModelsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_READ))
	.route({
		method: "GET",
		path: "/organizations/chatgpt-plan-models",
		tags: ["Organizations"],
		summary: "Get the organization's ChatGPT plan models",
		description:
			"The ChatGPT plan model the organization runs for each kind of work, the models a plan serves, and whether the caller may change them",
	})
	.output(choicesSchema)
	.handler(async ({ context }) => {
		const { organizationId, role } = await requirePlanOrganization(context);
		return choicesFor(organizationId, role === "admin" || role === "owner");
	});

export const setChatGptPlanModelProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_AI_CONFIG_EDIT))
	.route({
		method: "POST",
		path: "/organizations/chatgpt-plan-models",
		tags: ["Organizations"],
		summary: "Set the organization's ChatGPT plan model for a task",
		description:
			"Choose which ChatGPT plan model runs one kind of work, or clear the choice to use the default",
	})
	.input(
		z.object({
			taskType: taskTypeSchema,
			/** Null clears the organization's choice; the default applies again. */
			modelCanonicalName: z.string().min(1).nullable(),
		}),
	)
	.output(choicesSchema)
	.handler(async ({ context, input }) => {
		const { organizationId, role } = await requirePlanOrganization(context);
		if (role !== "admin" && role !== "owner") {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only organization admins can choose ChatGPT plan models",
			});
		}
		const saved = await setChatGptPlanOrgModel({
			organizationId,
			taskType: input.taskType,
			modelCanonicalName: input.modelCanonicalName,
		});
		if (!saved) {
			throw new ORPCError("BAD_REQUEST", {
				message: "That model is not served by a ChatGPT plan",
			});
		}
		return choicesFor(organizationId, true);
	});

export const setChatGptPlanFallbackModelProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_AI_CONFIG_EDIT))
	.route({
		method: "POST",
		path: "/organizations/chatgpt-plan-models/fallback",
		tags: ["Organizations"],
		summary: "Set the organization's ChatGPT plan fallback model",
		description:
			"Choose the plan model a call retries on, once, when the plan does not serve the chosen model, or null for no fallback",
	})
	.input(
		z.object({
			/** A plan model's slug; null turns the fallback off. */
			fallbackModel: z.string().min(1).nullable(),
		}),
	)
	.output(choicesSchema)
	.handler(async ({ context, input }) => {
		const { organizationId, role } = await requirePlanOrganization(context);
		if (role !== "admin" && role !== "owner") {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only organization admins can choose the ChatGPT plan fallback model",
			});
		}
		if (context.session.impersonatedBy) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"This change cannot be made while acting as another user.",
			});
		}
		const { saved, before } = await setChatGptPlanOrgFallbackModel({
			organizationId,
			slug: input.fallbackModel,
		});
		if (!saved) {
			throw new ORPCError("BAD_REQUEST", {
				message: "That model is not served by a ChatGPT plan",
			});
		}
		if (before !== input.fallbackModel) {
			recordAuditFromRequest(context, {
				action: "org.chatgpt_plan.fallback_model_changed",
				category: "org",
				outcome: "success",
				severity: "warning",
				organizationId,
				resource: {
					type: "chatgpt_plan_org_policy",
					id: organizationId,
					name: null,
				},
				metadata: {
					before: { fallbackModel: before },
					after: { fallbackModel: input.fallbackModel },
				},
			});
		}
		return choicesFor(organizationId, true);
	});
