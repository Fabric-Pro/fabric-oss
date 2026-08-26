import { ORPCError } from "@orpc/client";
import { hasProjectAccess, listPmSyncLog } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Sync History tab data. Paginated, filtered, newest-first list of
 * `PmSyncLog` rows for a project.
 *
 * Gated on `PROJECT_READ` — the same permission as
 * `backlog.history.audit.list` — because the sync log is now the second tab of
 * the roadmap's change-history window. This REVERSES the original
 * spec §11.1 decision to restrict the log to OWNER / PROJECT_ADMIN / EDITOR;
 * that restriction predates the move, when the log was a Settings tab of its own.
 *
 * The two endpoints are NOT fully equivalent, and the difference is deliberate:
 * this handler additionally calls `hasProjectAccess`, which `audit.list` does
 * not, so an org-role member with no accepted `ProjectMember` row can read the
 * change log but not the sync log. Narrowing rather than widening, and left in
 * place because removing an access check is a product decision, not a cleanup.
 * Do not describe the two gates as identical without deleting that call.
 *
 * Reads are unaudited (D-Q11): no audit row, no `PmSyncLog` row written. All
 * DB access is delegated to `@repo/database` (`listPmSyncLog`); no business
 * logic lives in the procedure.
 */
const PmSyncLogStatusSchema = z.enum(["SUCCESS", "FAILURE", "CONFLICT"]);

/** Longest failure/conflict reason worth putting in a tooltip. */
const STATUS_DETAIL_MAX = 500;

/**
 * Reduce a row's stored `errorPayload` to the one human-readable line the Sync
 * History tab shows, and return ONLY that.
 *
 * The stored payload is whatever the sync path threw — PM API response bodies,
 * request context, stack text. Now that this endpoint is `PROJECT_READ`, every
 * project member can read the response, so the raw object must not be on the
 * wire: the tab only ever rendered these three fields.
 *
 * Failures carry `errorMessage` (the thrown error); conflicts carry a `reason`
 * (e.g. "push-time-hash-drift"); `phase` is the last-resort label. SUCCESS rows
 * store SQL NULL and yield null, so the client renders a plain badge.
 */
function toStatusDetail(errorPayload: unknown): string | null {
	if (!errorPayload || typeof errorPayload !== "object") {
		return null;
	}
	const payload = errorPayload as Record<string, unknown>;
	for (const key of ["errorMessage", "reason", "phase"]) {
		const value = payload[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim().slice(0, STATUS_DETAIL_MAX);
		}
	}
	return null;
}

const PmSyncLogRowSchema = z.object({
	id: z.string(),
	createdAt: z.date(),
	direction: z.string(),
	entityType: z.string(),
	entityId: z.string(),
	title: z.string(),
	pmTool: z.string(),
	status: PmSyncLogStatusSchema,
	statusDetail: z.string().nullable(),
	batchId: z.string().nullable(),
	actorUserId: z.string().nullable(),
	correlationId: z.string().nullable(),
	durationMs: z.number().nullable(),
	externalId: z.string().nullable(),
	externalUrl: z.string().nullable(),
});

export const listPmSyncLogProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/pm-sync-log",
		tags: ["Projects", "PM Sync"],
		summary: "List PM sync log entries",
		description:
			"Paginated, filtered, newest-first list of PM sync audit-log rows for the Sync History tab. Read-only; not itself audited.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			pmTool: z.string().optional(),
			entityId: z.string().optional(),
			status: PmSyncLogStatusSchema.optional(),
			dateFrom: z.coerce.date().optional(),
			dateTo: z.coerce.date().optional(),
			limit: z.number().int().min(1).max(100).optional().default(50),
			offset: z.number().int().min(0).optional().default(0),
		}),
	)
	.output(
		z.object({
			rows: z.array(PmSyncLogRowSchema),
			total: z.number().int(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const tenant = organizationId
			? { organizationId }
			: { userId: user.id };

		const { rows, total } = await listPmSyncLog({
			...tenant,
			projectId: input.projectId,
			pmTool: input.pmTool,
			entityId: input.entityId,
			status: input.status,
			dateFrom: input.dateFrom,
			dateTo: input.dateTo,
			limit: input.limit,
			offset: input.offset,
		});

		// Shape for the wire here rather than in the query: `listPmSyncLog` is
		// the DB contract and returns the stored row, while what may cross an
		// API boundary is this layer's call. `errorPayload` holds raw thrown
		// text from the sync path, so only the one derived line the tab renders
		// leaves the server.
		return {
			total,
			rows: rows.map(({ errorPayload, ...row }) => ({
				...row,
				statusDetail: toStatusDetail(errorPayload),
			})),
		};
	});
