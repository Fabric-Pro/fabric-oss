import { db, type Prisma } from "../client";
import type { PmSyncLogStatus } from "../generated/client";

/**
 * Tenant XOR for `PmSyncLog`.
 *
 * The log is per-project (Sync History tab + Review Center). `projectId`
 * is always the primary scope; `organizationId`/`userId` provide the
 * org-vs-personal isolation and are mutually exclusive (XOR), never
 * OR-filtered.
 */
type CreatePmSyncLogTenant =
	| { organizationId: string; userId?: null }
	| { organizationId?: null; userId: string };

/**
 * Single typed input for {@link createPmSyncLog}. Encapsulates every
 * `PmSyncLog` column the write path supplies (>3 params → one model).
 *
 * `entityType` and `direction` are literal unions, not `string`: the schema
 * column is a plain `String`, but at the query boundary we forbid any value
 * outside `EPIC | FEATURE | STORY | TEST_CASE` and `push | pull` at compile
 * time. There is no `TASK` value anywhere.
 */
export type CreatePmSyncLogInput = CreatePmSyncLogTenant & {
	direction: "push" | "pull";
	entityType: "EPIC" | "FEATURE" | "STORY" | "TEST_CASE";
	entityId: string;
	/** Snapshot of the entity title at attempt time. */
	title: string;
	pmTool: string;
	status: PmSyncLogStatus;
	/** Populated for failures / conflict context. */
	errorPayload?: Prisma.InputJsonValue | null;
	/** Groups all rows from one Temporal workflow run. */
	batchId?: string | null;
	/** Null for system / poll-driven runs; set for user-triggered pushes. */
	actorUserId?: string | null;
	/** Temporal workflow runId — joins log rows to traces. */
	correlationId?: string | null;
	durationMs?: number | null;
	/** Snapshot of the PM-tool work-item id. */
	externalId?: string | null;
	/** Snapshot of the deep-link URL. */
	externalUrl?: string | null;
	projectId?: string | null;
};

/**
 * Insert exactly one `PmSyncLog` row at a sync-outcome boundary.
 *
 * The tenant fields are applied exactly as provided — the caller is
 * responsible for supplying the org-XOR-personal shape (the input type
 * enforces that one of `organizationId` / `userId` is set). This function
 * does not re-derive or OR-filter tenancy.
 */
export async function createPmSyncLog(
	input: CreatePmSyncLogInput,
): Promise<{ id: string }> {
	const data: Prisma.PmSyncLogUncheckedCreateInput = {
		direction: input.direction,
		entityType: input.entityType,
		entityId: input.entityId,
		title: input.title,
		pmTool: input.pmTool,
		status: input.status,
		batchId: input.batchId ?? null,
		actorUserId: input.actorUserId ?? null,
		correlationId: input.correlationId ?? null,
		durationMs: input.durationMs ?? null,
		externalId: input.externalId ?? null,
		externalUrl: input.externalUrl ?? null,
		organizationId: input.organizationId ?? null,
		userId: input.userId ?? null,
		projectId: input.projectId ?? null,
	};

	// Only set `errorPayload` when an error/conflict context is supplied. The
	// column is `Json?`; omitting the key writes SQL NULL (so `errorPayload IS
	// NULL` matches SUCCESS rows) rather than a JSON `null` literal, mirroring
	// how `audit-log.ts` handles its nullable `metadata` column.
	if (input.errorPayload != null) {
		data.errorPayload = input.errorPayload;
	}

	return db.pmSyncLog.create({ data, select: { id: true } });
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

/**
 * Columns surfaced by the Sync History tab. Selecting explicitly (rather than
 * returning the whole row) keeps the read narrow and stable.
 */
const PM_SYNC_LOG_LIST_SELECT = {
	id: true,
	createdAt: true,
	direction: true,
	entityType: true,
	entityId: true,
	title: true,
	pmTool: true,
	status: true,
	errorPayload: true,
	batchId: true,
	actorUserId: true,
	correlationId: true,
	durationMs: true,
	externalId: true,
	externalUrl: true,
} satisfies Prisma.PmSyncLogSelect;

export type PmSyncLogListRow = Prisma.PmSyncLogGetPayload<{
	select: typeof PM_SYNC_LOG_LIST_SELECT;
}>;

/**
 * Tenant scope for {@link listPmSyncLog}. `projectId` is the primary filter;
 * `organizationId`/`userId` provide org-vs-personal XOR (never both, never OR).
 */
type ListPmSyncLogTenant =
	| { organizationId: string; userId?: null }
	| { organizationId?: null; userId: string };

export type ListPmSyncLogInput = ListPmSyncLogTenant & {
	projectId: string;
	/** Filters compose with AND semantics; all optional. */
	pmTool?: string;
	entityId?: string;
	status?: PmSyncLogStatus;
	dateFrom?: Date;
	dateTo?: Date;
	/** Page size; defaults to 50, clamped to a max of 100. */
	limit?: number;
	/** Offset pagination. */
	offset?: number;
};

export interface ListPmSyncLogResult {
	rows: PmSyncLogListRow[];
	total: number;
}

/**
 * Paginated, filtered, newest-first list of `PmSyncLog` rows for one project.
 *
 * Backs the Sync History tab. Served by the `(projectId, createdAt desc)`
 * index. Filters (`pmTool`, `entityId`, `status`, `dateFrom`, `dateTo`)
 * compose with AND semantics. Returns the visible page plus the unpaginated
 * `total` for the matching filter set, fetched in a single transaction.
 */
export async function listPmSyncLog(
	input: ListPmSyncLogInput,
): Promise<ListPmSyncLogResult> {
	const limit = Math.min(
		Math.max(1, input.limit ?? DEFAULT_LIST_LIMIT),
		MAX_LIST_LIMIT,
	);
	const offset = Math.max(0, input.offset ?? 0);

	const where: Prisma.PmSyncLogWhereInput = {
		projectId: input.projectId,
		// Tenant XOR — apply exactly the scope provided, never OR.
		organizationId: input.organizationId ?? null,
	};
	if (input.organizationId == null) {
		where.userId = input.userId;
	}
	if (input.pmTool) {
		where.pmTool = input.pmTool;
	}
	if (input.entityId) {
		where.entityId = input.entityId;
	}
	if (input.status) {
		where.status = input.status;
	}
	if (input.dateFrom || input.dateTo) {
		where.createdAt = {};
		if (input.dateFrom) {
			where.createdAt.gte = input.dateFrom;
		}
		if (input.dateTo) {
			where.createdAt.lte = input.dateTo;
		}
	}

	const [rows, total] = await db.$transaction([
		db.pmSyncLog.findMany({
			where,
			orderBy: { createdAt: "desc" },
			select: PM_SYNC_LOG_LIST_SELECT,
			take: limit,
			skip: offset,
		}),
		db.pmSyncLog.count({ where }),
	]);

	return { rows, total };
}
