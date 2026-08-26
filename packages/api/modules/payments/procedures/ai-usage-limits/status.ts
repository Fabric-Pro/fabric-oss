/**
 * `aiUsageLimits.status` — read every active limit row + its current
 * counter value. Powers the live progress bars on the "Usage limits"
 * card and the recharts `ReferenceLine` overlay.
 * b:
 * - Same auth gate as `list`: org members below admin get an empty
 * `statuses` array; non-members → `FORBIDDEN`.
 * - Counter reads use the hybrid path (`readCounter` — Redis
 * fast path, Postgres fallback). The chokepoint already calls this
 * helper on the hot path; the status endpoint reuses it so the read
 * number matches what the limit-blocker sees.
 * - `windowStart` is computed once per call from the tenant's TZ via
 * `loadApplicableLimits` (which precomputes `currentWindowStart` for
 * each row) — we still need the timezone string for the UI's
 * "this month (PT)" label, so we pull it explicitly.
 * `percent` is BigInt-safe: `Number((current * 100n) / max)`. Capped at
 * 999 to handle the case (limit lowered mid-window) so the UI doesn't
 * have to clamp a runaway value.
 * Per [`backend/api.md`] §"Procedure Structure" + §"Authorization
 * Pattern" and [`backend/queries.md`] §"Explicit `select`".
 */
import { ORPCError } from "@orpc/server";
import { db, getOrganizationMembership } from "@repo/database";
import { getTenantTimezone, readCounter, windowStartFor } from "@repo/payments";
import { z } from "zod";
import {
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { type AiUsageLimitDto, toAiUsageLimitDto } from "./dto";

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
});

interface AiUsageLimitStatus {
	limit: AiUsageLimitDto;
	/** Decimal string — BigInt-safe. */
	currentValue: string;
	/** Whole-number percent of `maxValue`, capped at 999. */
	percent: number;
	/** ISO-8601 UTC instant — start of the active calendar window. */
	windowStart: string;
	/** ISO-8601 UTC instant — end of the active calendar window (exclusive). */
	windowEnd: string;
	/** IANA TZ name used to compute `windowStart` / `windowEnd`. */
	timezone: string;
}

interface StatusResult {
	statuses: AiUsageLimitStatus[];
}

function canManageLimits(role: string | undefined): boolean {
	return role === "owner" || role === "admin";
}

const SECONDS_PER_HOUR_MS = 60 * 60 * 1000;
const SECONDS_PER_DAY_MS = 24 * SECONDS_PER_HOUR_MS;
const SECONDS_PER_WEEK_MS = 7 * SECONDS_PER_DAY_MS;
/** Conservative monthly window-end estimate (31 days). The active window
 * always covers the current calendar month; this only over-approximates
 * the *display* end-instant. The chokepoint always recomputes the next
 * start from the calendar — so this value is purely for UI labelling. */
const SECONDS_PER_MONTH_MS = 31 * SECONDS_PER_DAY_MS;

function windowLengthMs(window: AiUsageLimitDto["window"]): number {
	switch (window) {
		case "HOURLY":
			return SECONDS_PER_HOUR_MS;
		case "DAILY":
			return SECONDS_PER_DAY_MS;
		case "WEEKLY":
			return SECONDS_PER_WEEK_MS;
		case "MONTHLY":
			return SECONDS_PER_MONTH_MS;
		default: {
			// Exhaustiveness — added enum variants will fail the compile.
			const _exhaustive: never = window;
			throw new Error(
				`Unhandled AiUsageLimitWindow variant: ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Compute `Math.floor((current * 100) / max)` in BigInt and clamp the
 * result to `[0, 999]`. The cap protects the UI from a malformed row or
 * the mid-window-lowering case where used > max.
 */
function computePercent(current: bigint, max: bigint): number {
	if (max <= BigInt(0)) {
		return 0;
	}
	const raw = Number((current * BigInt(100)) / max);
	if (raw < 0) {
		return 0;
	}
	if (raw > 999) {
		return 999;
	}
	return raw;
}

export const status = tenantProtectedProcedure
	.route({
		method: "GET",
		path: "/payments/ai-usage-limits/status",
		tags: ["Payments"],
		summary: "Get AI usage limit statuses",
		description:
			"Returns each active AiUsageLimit's current counter value, percent of max, and active calendar window. Powers the progress bars on the Usage limits card.",
	})
	.input(inputSchema)
	.handler(
		async ({
			input,
			context: { user, session },
		}): Promise<StatusResult> => {
			const organizationId = resolveOrganizationId(
				input.organizationId,
				session,
			);

			if (organizationId) {
				const membership = await getOrganizationMembership(
					organizationId,
					user.id,
				);

				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}

				if (!canManageLimits(membership.role)) {
					return { statuses: [] };
				}
			}

			// Single TZ lookup — every row's window-start uses the same TZ.
			const timezone = await getTenantTimezone({
				userId: user.id,
				organizationId: organizationId ?? null,
			});

			const tenantScope = organizationId
				? { organizationId, userId: null }
				: { userId: user.id, organizationId: null };

			const rows = await db.aiUsageLimit.findMany({
				where: {
					...tenantScope,
					archivedAt: null,
				},
				select: {
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
				},
				orderBy: { createdAt: "asc" },
			});

			if (rows.length === 0) {
				return { statuses: [] };
			}

			const now = new Date();
			const statuses: AiUsageLimitStatus[] = await Promise.all(
				rows.map(async (row) => {
					const windowStart = windowStartFor(
						row.window,
						timezone,
						now,
					);
					const windowEnd = new Date(
						windowStart.getTime() + windowLengthMs(row.window),
					);

					const counter = await readCounter({
						limitId: row.id,
						windowStart,
					});

					const current =
						row.dimension === "TOKENS"
							? counter.usedTokens
							: counter.usedMicroUsd;

					return {
						limit: toAiUsageLimitDto(row),
						currentValue: current.toString(),
						percent: computePercent(current, row.maxValue),
						windowStart: windowStart.toISOString(),
						windowEnd: windowEnd.toISOString(),
						timezone,
					};
				}),
			);

			return { statuses };
		},
	);
