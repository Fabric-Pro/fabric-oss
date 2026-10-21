import {
	FILES_COLLECTION,
	PAGE_BATCH_MAX,
	PAGE_LIST_DEFAULT,
	PAGE_LIST_MAX,
	RESERVED_PAGE_COLLECTIONS,
} from "@repo/utils/page-limits";
import { db, Prisma } from "../client";
import { advisoryObjectKey } from "./lib/refresh-lock-key";

/**
 * What a published page keeps between visits (`FramePageRecord`).
 *
 * Callers check that the viewer may open the page (`getAccessibleFrameById`)
 * before any function here. Every query still filters on `organizationId`,
 * and a write confirms the page belongs to that organization.
 */

export const PAGE_RECORD_LIMITS = {
	maxValueBytes: 16 * 1024,
	maxRecordsPerPage: 2000,
	maxBytesPerPage: 5 * 1024 * 1024,
	maxCollectionLength: 64,
	maxKeyLength: 128,
	maxBatch: PAGE_BATCH_MAX,
	defaultListLimit: PAGE_LIST_DEFAULT,
	maxListLimit: PAGE_LIST_MAX,
} as const;

/** A key that means "the person writing": one record per person. */
export const PAGE_RECORD_SELF_KEY = "@me";

const PAGE_RECORD_ADVISORY_CLASS = 0x50475263; // "PgRc"
const FORMER_MEMBER_NAME = "Former member";
const COLLECTION_PATTERN = /^\$?[A-Za-z0-9_.-]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: keys must not carry control characters
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export type PageRecordScope = "shared" | "mine";

export interface PageRecordUser {
	id: string;
	name: string;
}

export interface PageRecordView {
	key: string;
	value: Prisma.JsonValue;
	version: number;
	scope: PageRecordScope;
	createdBy: PageRecordUser;
	updatedBy: PageRecordUser;
	updatedAt: Date;
}

export interface PageRecordWrite {
	key: string;
	value: Prisma.InputJsonValue | null;
	/** Defaults to "shared". */
	scope?: PageRecordScope;
	/**
	 * The version the writer last saw. A different current version refuses the
	 * write; 0 means "only if no record has this key yet".
	 */
	expectedVersion?: number;
}

export type PageRecordLimit =
	| "value_bytes"
	| "records"
	| "page_bytes"
	| "batch_size";

export type PageRecordInputProblem =
	| "frame_not_found"
	| "collection"
	| "reserved_collection"
	| "key"
	| "value"
	| "duplicate_key"
	| "expected_version"
	| "user"
	| "cursor";

export class PageRecordVersionConflictError extends Error {
	readonly collection: string;
	readonly key: string;
	readonly scope: PageRecordScope;
	readonly expectedVersion: number;
	/** 0 when no record has the key. */
	readonly currentVersion: number;
	constructor(args: {
		collection: string;
		key: string;
		scope: PageRecordScope;
		expectedVersion: number;
		currentVersion: number;
	}) {
		super(
			`Record "${args.key}" in "${args.collection}" is at version ${args.currentVersion}, not ${args.expectedVersion}`,
		);
		this.name = "PageRecordVersionConflictError";
		this.collection = args.collection;
		this.key = args.key;
		this.scope = args.scope;
		this.expectedVersion = args.expectedVersion;
		this.currentVersion = args.currentVersion;
	}
}

export class PageRecordLimitError extends Error {
	readonly limit: PageRecordLimit;
	readonly max: number;
	constructor(limit: PageRecordLimit, max: number) {
		super(`Page record limit reached: ${limit} (max ${max})`);
		this.name = "PageRecordLimitError";
		this.limit = limit;
		this.max = max;
	}
}

export class PageRecordInputError extends Error {
	readonly problem: PageRecordInputProblem;
	constructor(problem: PageRecordInputProblem, message: string) {
		super(message);
		this.name = "PageRecordInputError";
		this.problem = problem;
	}
}

/**
 * The page is too busy to take a write now: writers to one page queue, and
 * this one waited out the limits below. Nothing was written; trying again is
 * safe.
 */
export class PageRecordBusyError extends Error {
	constructor() {
		super("The page is busy; try again");
		this.name = "PageRecordBusyError";
	}
}

/**
 * Writers to one page queue on its advisory lock, each holding a pooled
 * connection while it waits. Prisma's defaults (2 s to get a connection, 5 s to
 * finish) end a long queue with an opaque error; a write takes a few round
 * trips, so these let a few dozen racing writers each finish in turn and still
 * end a stuck one.
 */
export const PAGE_WRITE_TRANSACTION = {
	maxWait: 10_000,
	timeout: 10_000,
} as const;

function errorCode(error: unknown): unknown {
	return typeof error === "object" && error !== null && "code" in error
		? error.code
		: undefined;
}

/**
 * Turns what a write can still fail with under contention into the typed
 * errors callers handle. An expired or unstartable transaction (P2028) has
 * written nothing; a page deleted while its writer queued (P2003, the foreign
 * key) is a page that is no longer there.
 */
export function translatePageRecordWriteFailure(error: unknown): never {
	switch (errorCode(error)) {
		case "P2028":
			throw new PageRecordBusyError();
		case "P2003":
			throw new PageRecordInputError("frame_not_found", "Page not found");
		default:
			throw error;
	}
}

function isReservedCollection(collection: string): boolean {
	return (RESERVED_PAGE_COLLECTIONS as readonly string[]).includes(
		collection,
	);
}

function assertCollectionName(collection: string): void {
	if (
		collection.length === 0 ||
		collection.length > PAGE_RECORD_LIMITS.maxCollectionLength ||
		!COLLECTION_PATTERN.test(collection)
	) {
		throw new PageRecordInputError(
			"collection",
			`Collection names are 1 to ${PAGE_RECORD_LIMITS.maxCollectionLength} letters, digits, "_", "." or "-"`,
		);
	}
}

function assertWritableCollection(
	collection: string,
	allowReserved: boolean | undefined,
): void {
	assertCollectionName(collection);
	if (
		collection.startsWith("$") &&
		!(allowReserved && isReservedCollection(collection))
	) {
		throw new PageRecordInputError(
			"reserved_collection",
			'Collections starting with "$" belong to the host',
		);
	}
}

function assertUserId(userId: string): void {
	if (userId.length === 0) {
		throw new PageRecordInputError("user", "A user id is required");
	}
}

function resolveKey(key: string, userId: string): string {
	const resolved = key === PAGE_RECORD_SELF_KEY ? userId : key;
	if (
		resolved.length === 0 ||
		resolved.length > PAGE_RECORD_LIMITS.maxKeyLength ||
		CONTROL_CHARACTERS.test(resolved)
	) {
		throw new PageRecordInputError(
			"key",
			`Keys are 1 to ${PAGE_RECORD_LIMITS.maxKeyLength} characters without control characters`,
		);
	}
	return resolved;
}

function ownerFor(scope: PageRecordScope, userId: string): string {
	return scope === "mine" ? userId : "";
}

function serializedSize(value: Prisma.InputJsonValue | null): number {
	const json = JSON.stringify(value);
	if (json === undefined) {
		throw new PageRecordInputError("value", "The value must be JSON");
	}
	return Buffer.byteLength(json, "utf8");
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
	return Buffer.from(
		JSON.stringify({ c: row.createdAt.toISOString(), i: row.id }),
	).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
	try {
		const parsed: unknown = JSON.parse(
			Buffer.from(cursor, "base64url").toString("utf8"),
		);
		if (
			parsed &&
			typeof parsed === "object" &&
			"c" in parsed &&
			"i" in parsed &&
			typeof parsed.c === "string" &&
			typeof parsed.i === "string"
		) {
			const createdAt = new Date(parsed.c);
			if (!Number.isNaN(createdAt.getTime())) {
				return { createdAt, id: parsed.i };
			}
		}
	} catch {
		// falls through to the error below
	}
	throw new PageRecordInputError("cursor", "The cursor is not valid");
}

type UserReader = Pick<Prisma.TransactionClient, "user">;

async function viewsOf(
	client: UserReader,
	rows: Array<{
		key: string;
		value: Prisma.JsonValue;
		version: number;
		ownerUserId: string;
		createdBy: string;
		updatedBy: string;
		updatedAt: Date;
	}>,
): Promise<PageRecordView[]> {
	const ids = [...new Set(rows.flatMap((r) => [r.createdBy, r.updatedBy]))];
	const users =
		ids.length === 0
			? []
			: await client.user.findMany({
					where: { id: { in: ids } },
					select: { id: true, name: true },
				});
	const names = new Map(users.map((u) => [u.id, u.name]));
	const userOf = (id: string): PageRecordUser => ({
		id,
		name: names.get(id) ?? FORMER_MEMBER_NAME,
	});
	return rows.map((r) => ({
		key: r.key,
		value: r.value,
		version: r.version,
		scope: r.ownerUserId === "" ? "shared" : "mine",
		createdBy: userOf(r.createdBy),
		updatedBy: userOf(r.updatedBy),
		updatedAt: r.updatedAt,
	}));
}

export async function listPageRecords(input: {
	frameId: string;
	organizationId: string;
	viewerUserId: string;
	collection: string;
	scope: PageRecordScope;
	/** Only records changed after this moment. */
	since?: Date | string;
	cursor?: string;
	limit: number;
}): Promise<{ records: PageRecordView[]; nextCursor?: string }> {
	assertCollectionName(input.collection);
	assertUserId(input.viewerUserId);
	const limit = Math.min(
		Math.max(
			Math.trunc(input.limit) || PAGE_RECORD_LIMITS.defaultListLimit,
			1,
		),
		PAGE_RECORD_LIMITS.maxListLimit,
	);
	const since = input.since === undefined ? undefined : new Date(input.since);
	if (since && Number.isNaN(since.getTime())) {
		throw new PageRecordInputError("cursor", "since is not a valid time");
	}
	const after = input.cursor ? decodeCursor(input.cursor) : undefined;

	const rows = await db.framePageRecord.findMany({
		where: {
			frameId: input.frameId,
			organizationId: input.organizationId,
			collection: input.collection,
			ownerUserId: ownerFor(input.scope, input.viewerUserId),
			...(since ? { updatedAt: { gt: since } } : {}),
			...(after
				? {
						OR: [
							{ createdAt: { gt: after.createdAt } },
							{
								createdAt: after.createdAt,
								id: { gt: after.id },
							},
						],
					}
				: {}),
		},
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		take: limit + 1,
	});
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		records: await viewsOf(db, page),
		...(rows.length > limit && last
			? { nextCursor: encodeCursor(last) }
			: {}),
	};
}

export interface GetPageRecordInput {
	frameId: string;
	organizationId: string;
	viewerUserId: string;
	collection: string;
	key: string;
	scope: PageRecordScope;
}

export async function getPageRecord(input: GetPageRecordInput) {
	return getPageRecordWithin(db, input);
}

export async function getPageRecordWithin(
	client: Pick<Prisma.TransactionClient, "framePageRecord" | "user">,
	input: GetPageRecordInput,
): Promise<PageRecordView | null> {
	assertCollectionName(input.collection);
	assertUserId(input.viewerUserId);
	const row = await client.framePageRecord.findFirst({
		where: {
			frameId: input.frameId,
			organizationId: input.organizationId,
			collection: input.collection,
			ownerUserId: ownerFor(input.scope, input.viewerUserId),
			key: resolveKey(input.key, input.viewerUserId),
		},
	});
	if (!row) {
		return null;
	}
	const [view] = await viewsOf(client, [row]);
	return view ?? null;
}

/**
 * Writes up to 25 records to one collection, all or none. Writers to one page
 * queue on an advisory lock, so the limits hold and an `expectedVersion` is
 * checked against the row the write replaces.
 */
export interface SetPageRecordsInput {
	frameId: string;
	organizationId: string;
	actorUserId: string;
	collection: string;
	records: PageRecordWrite[];
	/** Only the host's own tools pass this, for `$files` and `$comments`. */
	allowReserved?: boolean;
}

export async function setPageRecords(input: SetPageRecordsInput) {
	return db
		.$transaction(
			(tx) => setPageRecordsWithin(tx, input),
			PAGE_WRITE_TRANSACTION,
		)
		.catch(translatePageRecordWriteFailure);
}

export async function setPageRecordsWithin(
	tx: Prisma.TransactionClient,
	input: SetPageRecordsInput,
): Promise<{ records: PageRecordView[] }> {
	assertWritableCollection(input.collection, input.allowReserved);
	assertUserId(input.actorUserId);
	if (input.records.length === 0) {
		return { records: [] };
	}
	if (input.records.length > PAGE_RECORD_LIMITS.maxBatch) {
		throw new PageRecordLimitError(
			"batch_size",
			PAGE_RECORD_LIMITS.maxBatch,
		);
	}

	const seen = new Set<string>();
	const writes = input.records.map((record) => {
		const scope = record.scope ?? "shared";
		const key = resolveKey(record.key, input.actorUserId);
		const size = serializedSize(record.value);
		if (size > PAGE_RECORD_LIMITS.maxValueBytes) {
			throw new PageRecordLimitError(
				"value_bytes",
				PAGE_RECORD_LIMITS.maxValueBytes,
			);
		}
		if (
			record.expectedVersion !== undefined &&
			(!Number.isInteger(record.expectedVersion) ||
				record.expectedVersion < 0)
		) {
			throw new PageRecordInputError(
				"expected_version",
				"expectedVersion is a whole number from 0",
			);
		}
		const identity = `${ownerFor(scope, input.actorUserId)}\u0000${key}`;
		if (seen.has(identity)) {
			throw new PageRecordInputError(
				"duplicate_key",
				`"${key}" appears twice in one write`,
			);
		}
		seen.add(identity);
		return {
			key,
			scope,
			ownerUserId: ownerFor(scope, input.actorUserId),
			size,
			value: record.value ?? Prisma.JsonNull,
			expectedVersion: record.expectedVersion,
		};
	});

	await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PAGE_RECORD_ADVISORY_CLASS}::int, ${advisoryObjectKey(`page:${input.frameId}`)}::int)`;

	const frame = await tx.agentWorkspaceFile.findFirst({
		where: {
			id: input.frameId,
			organizationId: input.organizationId,
		},
		select: { id: true },
	});
	if (!frame) {
		throw new PageRecordInputError("frame_not_found", "Page not found");
	}

	const existing = await tx.framePageRecord.findMany({
		where: {
			frameId: input.frameId,
			organizationId: input.organizationId,
			collection: input.collection,
			OR: writes.map((w) => ({
				ownerUserId: w.ownerUserId,
				key: w.key,
			})),
		},
		select: {
			id: true,
			key: true,
			ownerUserId: true,
			version: true,
			size: true,
		},
	});
	const existingBy = new Map(
		existing.map((row) => [`${row.ownerUserId}\u0000${row.key}`, row]),
	);

	let addedRecords = 0;
	let addedBytes = 0;
	for (const write of writes) {
		const current = existingBy.get(
			`${write.ownerUserId}\u0000${write.key}`,
		);
		if (
			write.expectedVersion !== undefined &&
			write.expectedVersion !== (current?.version ?? 0)
		) {
			throw new PageRecordVersionConflictError({
				collection: input.collection,
				key: write.key,
				scope: write.scope,
				expectedVersion: write.expectedVersion,
				currentVersion: current?.version ?? 0,
			});
		}
		addedRecords += current ? 0 : 1;
		addedBytes += write.size - (current?.size ?? 0);
	}

	if (addedRecords > 0 || addedBytes > 0) {
		const usage = await pageUsage(tx, input);
		if (
			addedRecords > 0 &&
			usage.records + addedRecords > PAGE_RECORD_LIMITS.maxRecordsPerPage
		) {
			throw new PageRecordLimitError(
				"records",
				PAGE_RECORD_LIMITS.maxRecordsPerPage,
			);
		}
		if (
			addedBytes > 0 &&
			usage.bytes + addedBytes > PAGE_RECORD_LIMITS.maxBytesPerPage
		) {
			throw new PageRecordLimitError(
				"page_bytes",
				PAGE_RECORD_LIMITS.maxBytesPerPage,
			);
		}
	}

	const saved = [];
	for (const write of writes) {
		const current = existingBy.get(
			`${write.ownerUserId}\u0000${write.key}`,
		);
		saved.push(
			current
				? await tx.framePageRecord.update({
						where: { id: current.id },
						data: {
							value: write.value,
							size: write.size,
							version: { increment: 1 },
							updatedBy: input.actorUserId,
						},
					})
				: await tx.framePageRecord.create({
						data: {
							frameId: input.frameId,
							organizationId: input.organizationId,
							collection: input.collection,
							key: write.key,
							ownerUserId: write.ownerUserId,
							value: write.value,
							size: write.size,
							createdBy: input.actorUserId,
							updatedBy: input.actorUserId,
						},
					}),
		);
	}
	return { records: await viewsOf(tx, saved) };
}

/**
 * Deletes records by key. A person deletes their own records; the page's owner
 * also deletes any shared record. Another person's private ("mine") records are
 * never deleted here, not even by the owner. A key that names no record is
 * skipped.
 */
export async function deletePageRecords(input: {
	frameId: string;
	organizationId: string;
	actorUserId: string;
	isPageOwner: boolean;
	collection: string;
	keys: string[];
	allowReserved?: boolean;
}): Promise<{ deleted: number }> {
	assertWritableCollection(input.collection, input.allowReserved);
	assertUserId(input.actorUserId);
	if (input.keys.length === 0) {
		return { deleted: 0 };
	}
	if (input.keys.length > PAGE_RECORD_LIMITS.maxBatch) {
		throw new PageRecordLimitError(
			"batch_size",
			PAGE_RECORD_LIMITS.maxBatch,
		);
	}
	const keys = input.keys.map((key) => resolveKey(key, input.actorUserId));
	const result = await db.framePageRecord.deleteMany({
		where: {
			frameId: input.frameId,
			organizationId: input.organizationId,
			collection: input.collection,
			key: { in: keys },
			OR: [
				{ ownerUserId: input.actorUserId },
				input.isPageOwner
					? { ownerUserId: "" }
					: { ownerUserId: "", createdBy: input.actorUserId },
			],
		},
	});
	return { deleted: result.count };
}

async function pageUsage(
	client: Pick<Prisma.TransactionClient, "framePageRecord">,
	input: { frameId: string; organizationId: string },
): Promise<{ records: number; bytes: number }> {
	const usage = await client.framePageRecord.aggregate({
		where: { frameId: input.frameId, organizationId: input.organizationId },
		_count: { _all: true },
		_sum: { size: true },
	});
	return { records: usage._count._all, bytes: usage._sum.size ?? 0 };
}

/** How many records one collection of a page holds, whoever owns them. */
export async function countPageRecords(input: {
	frameId: string;
	organizationId: string;
	collection: string;
}): Promise<number> {
	assertCollectionName(input.collection);
	return db.framePageRecord.count({
		where: {
			frameId: input.frameId,
			organizationId: input.organizationId,
			collection: input.collection,
		},
	});
}

/**
 * How many files a page holds and how many bytes they come to, summed by the
 * database from the `size` each file's record in `$files` carries. This is the
 * file quota's measure: the record's own `size` column is the bytes of its
 * JSON, a few hundred for a file of any size.
 */
export async function pageFilesUsage(input: {
	frameId: string;
	organizationId: string;
}): Promise<{ files: number; bytes: number }> {
	const [usage] = await db.$queryRaw<Array<{ files: number; bytes: bigint }>>`
		SELECT COUNT(*)::int AS files,
			COALESCE(SUM(CASE WHEN jsonb_typeof("value" -> 'size') = 'number' THEN ("value" ->> 'size')::bigint END), 0)::bigint AS bytes
		FROM "frame_page_record"
		WHERE "frameId" = ${input.frameId}
			AND "organizationId" = ${input.organizationId}
			AND "collection" = ${FILES_COLLECTION}`;
	return { files: usage?.files ?? 0, bytes: Number(usage?.bytes ?? 0) };
}
