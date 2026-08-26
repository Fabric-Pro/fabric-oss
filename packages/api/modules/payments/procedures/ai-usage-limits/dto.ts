/**
 * Shared DTO + serialiser for the `aiUsageLimits` sub-namespace.
 * The Prisma model surfaces `maxValue` as a native `BigInt`; oRPC's wire
 * format JSON.stringifies the response which throws on raw BigInts. We
 * convert to a decimal string here so every consumer (the card, the
 * status hook, the edit Sheet, the recharts overlay) handles the same
 * shape. Per `[backend/api.md]` §"Returning Database Models Directly"
 * the procedure layer is the right place for this serialisation step.
 * this is the single source of truth for the
 * "AiUsageLimitDto" referenced in the tasks list — every procedure that
 * returns a limit row goes through {@link toAiUsageLimitDto}.
 */
import type {
	AiTaskType,
	AiUsageLimitDimension,
	AiUsageLimitEnforcement,
	AiUsageLimitWindow,
} from "@repo/database";

/**
 * Exactly the columns selected by `list` / `upsert` / `delete`. Keep the
 * `select` block in those procedures in sync with this shape.
 */
export interface AiUsageLimitRow {
	id: string;
	organizationId: string | null;
	userId: string | null;
	projectId: string | null;
	name: string | null;
	providerConfigId: string | null;
	modelCanonicalName: string | null;
	taskType: AiTaskType | null;
	dimension: AiUsageLimitDimension;
	window: AiUsageLimitWindow;
	maxValue: bigint;
	enforcement: AiUsageLimitEnforcement;
	bannerThresholdPercent: number;
	createdById: string;
	createdAt: Date;
}

/**
 * Wire-safe shape returned by every `aiUsageLimits.*` procedure that
 * surfaces a limit row. `maxValue` is decimal-string (BigInt-safe);
 * `createdAt` is an ISO-8601 instant.
 */
export interface AiUsageLimitDto {
	id: string;
	organizationId: string | null;
	userId: string | null;
	/**
	 * Project scope — NULL = workspace-global (applies to every AI call in
	 * the tenant); non-NULL = applies only to AI calls scoped to this
	 * project. Surfaced as the "scope" radio in the edit Sheet.
	 */
	projectId: string | null;
	name: string | null;
	providerConfigId: string | null;
	modelCanonicalName: string | null;
	taskType: AiTaskType | null;
	dimension: AiUsageLimitDimension;
	window: AiUsageLimitWindow;
	/** Decimal string of the BigInt max — JSON-safe, exact. */
	maxValue: string;
	enforcement: AiUsageLimitEnforcement;
	/**
	 * Percent (1-99) at which the in-app warning banner appears for this
	 * limit. Default 90. Independent of the fixed 80% / 100% notification
	 * fan-out thresholds.
	 */
	bannerThresholdPercent: number;
	createdById: string;
	/** ISO-8601 UTC. */
	createdAt: string;
}

/**
 * Convert a raw `AiUsageLimit` row (with native `BigInt` and `Date`) into
 * the JSON-safe DTO shape consumed by the frontend.
 */
export function toAiUsageLimitDto(row: AiUsageLimitRow): AiUsageLimitDto {
	return {
		id: row.id,
		organizationId: row.organizationId,
		userId: row.userId,
		projectId: row.projectId,
		name: row.name,
		providerConfigId: row.providerConfigId,
		modelCanonicalName: row.modelCanonicalName,
		taskType: row.taskType,
		dimension: row.dimension,
		window: row.window,
		maxValue: row.maxValue.toString(),
		enforcement: row.enforcement,
		bannerThresholdPercent: row.bannerThresholdPercent,
		createdById: row.createdById,
		createdAt: row.createdAt.toISOString(),
	};
}
