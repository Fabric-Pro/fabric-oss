/**
 * `aiUsageLimits.upsert` — create or update a single AiUsageLimit row.
 * +:
 * - Org context: `requireOrganizationAdmin` (owner | admin only).
 * - Personal context: any authenticated user can write their own.
 * - `maxValue` is accepted as a positive integer (UI uses dollars for
 * `SPEND_USD`); the handler converts dollars → micro-USD before
 * persisting so the BigInt arithmetic in the chokepoint stays exact.
 * - XOR enforced explicitly: `userId` and `organizationId` are set from
 * the resolved scope, never from the input — the input's
 * `organizationId` is only used to *select* scope, never to bypass it.
 * - P2002 on `ai_usage_limit_scope_live_uq` (the partial-unique index
 * from) → `CONFLICT` per. Any other duplicate of the
 * live `(tenant, provider, model, taskType, dimension, window)` shape
 * maps to the same friendly message.
 * - Audit log fired-and-forgotten via the `[AuditLog]` precedent at
 * `packages/api/modules/skills/procedures/create.ts:83`.
 * Per [`backend/api.md`] §"Procedure Structure", §"Authorization Pattern",
 * §"Returning Database Models Directly"; [`global/error-handling.md`]
 * §"ORPCError"; [`backend/queries.md`] §"Explicit `select`".
 */
import { ORPCError } from "@orpc/server";
import {
	AiUsageLimitDimension,
	AiUsageLimitEnforcement,
	AiUsageLimitWindow,
	db,
	Prisma,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	requireOrganizationAdmin,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { type AiUsageLimitDto, toAiUsageLimitDto } from "./dto";

// `AiTaskType` is re-exported as `type` only from `@repo/database/prisma`
// — every other procedure that needs it as a runtime value (see
// `get-ai-activity-estimate.ts:9`) inlines the enum as a `z.enum([..])`
// literal. Match that pattern here.
const taskTypeEnum = z.enum([
	"SIMPLE",
	"COMPLEX",
	"REASONING",
	"CHAT",
	"TOOL_CALLING",
	"EMBEDDING",
	"IMAGE",
	"AUDIO",
	"EVAL",
]);

const inputSchema = z.object({
	id: z.string().optional(),
	organizationId: z.string().nullable().optional(),
	// Optional project scope. NULL = workspace-global; non-NULL = applies
	// only to AI calls routed through this project. The handler verifies
	// project ownership before persisting.
	projectId: z.string().nullable().optional(),
	name: z.string().min(1).max(80).optional(),
	providerConfigId: z.string().nullable().optional(),
	modelCanonicalName: z.string().nullable().optional(),
	taskType: taskTypeEnum.nullable().optional(),
	dimension: z.nativeEnum(AiUsageLimitDimension),
	window: z.nativeEnum(AiUsageLimitWindow),
	// UI sends a positive integer in the dimension's natural unit:
	// tokens for TOKENS, dollars for SPEND_USD. We convert dollars →
	// micro-USD inside the handler so the BigInt path stays exact.
	maxValue: z.number().int().positive(),
	enforcement: z.nativeEnum(AiUsageLimitEnforcement),
	// Banner visibility threshold (1-99 inclusive). 100 would mean
	// "banner appears only when blocking" which duplicates the toast; 0
	// would mean "banner always on" which is noise. Default 90 on the
	// DB side; clients should send the user's chosen value.
	bannerThresholdPercent: z.number().int().min(1).max(99).optional(),
});

interface UpsertResult {
	limit: AiUsageLimitDto;
}

const SELECT_FIELDS = {
	id: true,
	name: true,
	organizationId: true,
	userId: true,
	projectId: true,
	providerConfigId: true,
	modelCanonicalName: true,
	taskType: true,
	dimension: true,
	window: true,
	maxValue: true,
	enforcement: true,
	bannerThresholdPercent: true,
	createdById: true,
	createdAt: true,
} as const;

/** Convert UI-supplied `maxValue` into the storage BigInt. SPEND_USD
 * ships in dollars; we multiply by 1e6 to mirror `AiUsageLog.costMicroUsd`. */
function toStorageMaxValue(
	dimension: AiUsageLimitDimension,
	value: number,
): bigint {
	if (dimension === AiUsageLimitDimension.SPEND_USD) {
		return BigInt(value) * BigInt(1_000_000);
	}
	return BigInt(value);
}

function isUniqueConstraintError(
	error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
	return (
		error instanceof Prisma.PrismaClientKnownRequestError &&
		error.code === "P2002"
	);
}

export const upsert = tenantProtectedProcedure
	.route({
		method: "POST",
		path: "/payments/ai-usage-limits/upsert",
		tags: ["Payments"],
		summary: "Create or update an AI usage limit",
		description:
			"Create a new AiUsageLimit row (no `id`) or update an existing one (`id` provided). Org context requires owner/admin; personal context allows any user.",
	})
	.input(inputSchema)
	.handler(
		async ({
			input,
			context: { user, session },
		}): Promise<UpsertResult> => {
			const organizationId = resolveOrganizationId(
				input.organizationId,
				session,
			);

			// — org writes are admin-only. Personal context: the
			// authenticated user owns their personal limits, no extra check.
			if (organizationId) {
				await requireOrganizationAdmin(organizationId, user.id).catch(
					() => {
						throw new ORPCError("FORBIDDEN", {
							message:
								"Only organization owners or admins can manage AI usage limits",
						});
					},
				);
			}

			// Project ownership check — if a projectId is provided, it MUST
			// belong to the same tenant scope as the limit (XOR-aligned).
			// Cross-tenant attempts (e.g., admin trying to scope a limit to a
			// project from another org) are rejected with NOT_FOUND, mirroring
			// the existing limit-id XOR check below — never leak whether the
			// project exists in a foreign tenant.
			if (input.projectId) {
				// Project.userId is non-nullable (the creator), Project.organizationId
				// is nullable. For an org-scoped limit, match projects with the same
				// organizationId regardless of creator. For a personal-scoped limit,
				// match projects owned by the caller with organizationId IS NULL.
				const project = await db.project.findFirst({
					where: {
						id: input.projectId,
						...(organizationId
							? { organizationId }
							: { userId: user.id, organizationId: null }),
					},
					select: { id: true },
				});

				if (!project) {
					throw new ORPCError("NOT_FOUND", {
						message:
							"Project not found in this workspace, or you do not have access to it",
					});
				}
			}

			const storageMaxValue = toStorageMaxValue(
				input.dimension,
				input.maxValue,
			);

			try {
				const action: "create" | "update" = input.id
					? "update"
					: "create";

				let saved: Prisma.AiUsageLimitGetPayload<{
					select: typeof SELECT_FIELDS;
				}>;

				if (input.id) {
					// XOR re-check — `where: { id,...scopeFilter }` rejects
					// cross-tenant attempts (org admin trying to update a
					// personal limit, or vice versa) by simply not matching
					// any row. We use `findFirst` here rather than `update`'s
					// `where` because Prisma rejects non-unique fields in the
					// `update` `where` clause; on miss we throw NOT_FOUND.
					const existing = await db.aiUsageLimit.findFirst({
						where: {
							id: input.id,
							...(organizationId
								? { organizationId, userId: null }
								: { userId: user.id, organizationId: null }),
						},
						select: { id: true },
					});

					if (!existing) {
						throw new ORPCError("NOT_FOUND", {
							message: "AI usage limit not found",
						});
					}

					saved = await db.aiUsageLimit.update({
						where: { id: input.id },
						data: {
							name: input.name ?? null,
							projectId: input.projectId ?? null,
							providerConfigId: input.providerConfigId ?? null,
							modelCanonicalName:
								input.modelCanonicalName ?? null,
							taskType: input.taskType ?? null,
							dimension: input.dimension,
							window: input.window,
							maxValue: storageMaxValue,
							enforcement: input.enforcement,
							...(input.bannerThresholdPercent !== undefined && {
								bannerThresholdPercent:
									input.bannerThresholdPercent,
							}),
						},
						select: SELECT_FIELDS,
					});
				} else {
					saved = await db.aiUsageLimit.create({
						data: {
							name: input.name ?? null,
							organizationId: organizationId ?? null,
							userId: organizationId ? null : user.id,
							projectId: input.projectId ?? null,
							providerConfigId: input.providerConfigId ?? null,
							modelCanonicalName:
								input.modelCanonicalName ?? null,
							taskType: input.taskType ?? null,
							dimension: input.dimension,
							window: input.window,
							maxValue: storageMaxValue,
							enforcement: input.enforcement,
							createdById: user.id,
							...(input.bannerThresholdPercent !== undefined && {
								bannerThresholdPercent:
									input.bannerThresholdPercent,
							}),
						},
						select: SELECT_FIELDS,
					});
				}

				// Audit log — fire-and-forget per, mirroring the
				// `[AuditLog]` precedent at
				// `packages/api/modules/skills/procedures/create.ts:83`.
				try {
					// `op` matches the wording (`"create" | "update"`)
					// so SRE log queries can filter without parsing the longer
					// `event` discriminator. `event` is kept for back-compat
					// with any existing dashboards that pivot on it.
					logger.info(
						{
							event: `aiUsageLimit.${action}`,
							op: action,
							limitId: saved.id,
							tenant: organizationId ?? user.id,
							organizationId: organizationId ?? null,
							userId: organizationId ? null : user.id,
							by: user.id,
							dimension: saved.dimension,
							window: saved.window,
							maxValue: saved.maxValue.toString(),
							enforcement: saved.enforcement,
						},
						`[AuditLog] AiUsageLimit ${action} id=${saved.id} tenant=${organizationId ?? user.id} by=${user.id}`,
					);
				} catch (error) {
					console.warn(
						"[AuditLog] Failed to log AI usage limit upsert:",
						error,
					);
				}

				return { limit: toAiUsageLimitDto(saved) };
			} catch (error) {
				// Map the partial-unique violation (`ai_usage_limit_scope_live_uq`
				// from 's schema) to a friendly CONFLICT — every other
				// P2002 from this table also represents a duplicate live scope,
				// so the same message applies.
				if (isUniqueConstraintError(error)) {
					throw new ORPCError("CONFLICT", {
						message:
							"A limit already exists for this scope. Edit the existing one or change the filter.",
					});
				}
				throw error;
			}
		},
	);
