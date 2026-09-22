/**
 * In-memory `@repo/database` for the PM status-sync seam and round-trip tests
 * (Fizzy #2304, spec §6).
 *
 * The seam tests run the REAL chain — REST fetch → verdict → JSON boundary →
 * reconcile → leaf, and push → base stamp — so every query those modules
 * issue lands here. A mock answering with canned rows cannot tell a correct
 * `where` or `select` from a wrong one; this store evaluates both:
 *  - reads filter by `where`, order by `orderBy` and project to `select`; a
 *    selected field the fixture row lacks THROWS (pattern:
 *    `publishing-shared/__tests__/contributor-names.test.ts:60-174`);
 *  - writes apply `data` to exactly the rows `where` matches and throw on a
 *    column the fixture row lacks, so a compare-and-set with a mistyped field
 *    fails loudly instead of matching everything;
 *  - anything not modelled — an unseeded table, a raw query, a Prisma
 *    operator, an export — throws by name.
 * Every table call is recorded in `fakeStore.calls`, so a test can assert a
 * phase issued no write at all. `$transaction` is not atomic here: these
 * seams inject no mid-transaction failure (the DB-integration suite does).
 *
 * Imports nothing: `vi.mock("@repo/database")` loads this module from inside
 * its factory, so importing the real package here would recurse.
 */

export type Row = Record<string, unknown>;

interface FakeDbCall {
	table: string;
	method: string;
	args: Record<string, unknown>;
}

interface LastRunPatch {
	projectId: string;
	sessionAt: Date;
	patch: Record<string, unknown>;
}

export const fakeStore = {
	tables: new Map<string, Row[]>(),
	calls: [] as FakeDbCall[],
	audits: [] as Row[],
	lastRunPatches: [] as LastRunPatch[],
	nextId: 1,
};

export function resetFakeStore(seed: Record<string, Row[]>): void {
	fakeStore.tables = new Map(
		Object.entries(seed).map(([table, rows]) => [
			table,
			rows.map((row) => structuredClone(row)),
		]),
	);
	fakeStore.calls = [];
	fakeStore.audits = [];
	fakeStore.lastRunPatches = [];
	fakeStore.nextId = 1;
}

/** The live rows of a seeded table (mutating them mutates the store). */
export function tableRows(table: string): Row[] {
	const rows = fakeStore.tables.get(table);
	if (!rows) {
		throw new Error(`fake db: table "${table}" is not seeded`);
	}
	return rows;
}

function equals(value: unknown, operand: unknown): boolean {
	if (value instanceof Date && operand instanceof Date) {
		return value.getTime() === operand.getTime();
	}
	return value === operand;
}

function compare(a: unknown, b: unknown): number {
	const av = a instanceof Date ? a.getTime() : a;
	const bv = b instanceof Date ? b.getTime() : b;
	if (typeof av === "number" && typeof bv === "number") {
		return av - bv;
	}
	if (typeof av === "string" && typeof bv === "string") {
		return av < bv ? -1 : av > bv ? 1 : 0;
	}
	throw new Error(`fake db: cannot order ${String(a)} against ${String(b)}`);
}

function matchesCondition(value: unknown, condition: unknown): boolean {
	if (
		condition === null ||
		condition instanceof Date ||
		typeof condition === "string" ||
		typeof condition === "number" ||
		typeof condition === "boolean"
	) {
		// Prisma matches `{ field: null }` as IS NULL — so does this.
		return equals(value, condition);
	}
	if (typeof condition !== "object") {
		throw new Error(`fake db: unsupported condition ${String(condition)}`);
	}
	return Object.entries(condition as Record<string, unknown>).every(
		([operator, operand]) => {
			const present = value !== null && value !== undefined;
			switch (operator) {
				case "equals":
					return matchesCondition(value, operand);
				case "in":
					if (!Array.isArray(operand)) {
						throw new Error("fake db: `in` needs an array");
					}
					return operand.some((o) => equals(value, o));
				case "notIn":
					if (!Array.isArray(operand)) {
						throw new Error("fake db: `notIn` needs an array");
					}
					return !operand.some((o) => equals(value, o));
				case "not":
					return !matchesCondition(value, operand);
				case "gt":
					return present && compare(value, operand) > 0;
				case "gte":
					return present && compare(value, operand) >= 0;
				case "lt":
					return present && compare(value, operand) < 0;
				case "lte":
					return present && compare(value, operand) <= 0;
				default:
					throw new Error(
						`fake db: unsupported operator "${operator}"`,
					);
			}
		},
	);
}

function matchesWhere(row: Row, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, condition]) => {
		if (key === "OR" || key === "AND") {
			if (!Array.isArray(condition)) {
				throw new Error(`fake db: \`${key}\` needs an array`);
			}
			const clauses = condition as Array<Record<string, unknown>>;
			return key === "OR"
				? clauses.some((clause) => matchesWhere(row, clause))
				: clauses.every((clause) => matchesWhere(row, clause));
		}
		if (key === "NOT") {
			return !matchesWhere(row, condition as Record<string, unknown>);
		}
		// Prisma ignores an `undefined` condition, so the fake does too.
		if (condition === undefined) {
			return true;
		}
		if (!(key in row)) {
			throw new Error(`fake db: fixture row has no field "${key}"`);
		}
		return matchesCondition(row[key], condition);
	});
}

function applySelect(row: Row, select: unknown): Row {
	if (select === undefined) {
		return structuredClone(row);
	}
	const out: Row = {};
	for (const [key, wanted] of Object.entries(
		select as Record<string, unknown>,
	)) {
		if (wanted === false || wanted === undefined) {
			continue;
		}
		if (wanted !== true) {
			throw new Error(`fake db: nested select "${key}" is not modelled`);
		}
		if (!(key in row)) {
			throw new Error(`fake db: fixture row has no field "${key}"`);
		}
		out[key] = structuredClone(row[key]);
	}
	return out;
}

function orderRows(rows: Row[], orderBy: unknown): Row[] {
	if (orderBy === undefined) {
		return rows;
	}
	const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<
		Record<string, unknown>
	>;
	const keys = specs.flatMap((spec) =>
		Object.entries(spec).map(([field, dir]) => {
			if (dir === "asc" || dir === "desc") {
				// Postgres default: ASC → NULLS LAST, DESC → NULLS FIRST.
				return {
					field,
					desc: dir === "desc",
					nullsFirst: dir === "desc",
				};
			}
			if (dir !== null && typeof dir === "object" && "sort" in dir) {
				const d = dir as { sort: string; nulls?: string };
				const desc = d.sort === "desc";
				return {
					field,
					desc,
					nullsFirst: d.nulls ? d.nulls === "first" : desc,
				};
			}
			throw new Error(`fake db: unsupported orderBy for "${field}"`);
		}),
	);
	return [...rows].sort((a, b) => {
		for (const { field, desc, nullsFirst } of keys) {
			if (!(field in a) || !(field in b)) {
				throw new Error(`fake db: fixture row has no field "${field}"`);
			}
			const av = a[field];
			const bv = b[field];
			const aNull = av === null || av === undefined;
			const bNull = bv === null || bv === undefined;
			if (aNull && bNull) {
				continue;
			}
			if (aNull) {
				return nullsFirst ? -1 : 1;
			}
			if (bNull) {
				return nullsFirst ? 1 : -1;
			}
			const c = compare(av, bv);
			if (c !== 0) {
				return desc ? -c : c;
			}
		}
		return 0;
	});
}

function applyData(row: Row, data: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) {
			continue;
		}
		if (!(key in row)) {
			throw new Error(
				`fake db: fixture row has no field "${key}" (write)`,
			);
		}
		const current = row[key];
		if (
			value !== null &&
			typeof value === "object" &&
			!(value instanceof Date) &&
			!Array.isArray(value)
		) {
			const op = value as Record<string, unknown>;
			if ("set" in op) {
				row[key] = structuredClone(op.set);
				continue;
			}
			if (
				typeof op.increment === "number" &&
				typeof current === "number"
			) {
				row[key] = current + op.increment;
				continue;
			}
			if (
				typeof op.decrement === "number" &&
				typeof current === "number"
			) {
				row[key] = current - op.decrement;
				continue;
			}
		}
		// Plain values, and JSON column values (errorPayload,
		// pmStatusSyncLastRun), are stored as given.
		row[key] = structuredClone(value);
	}
}

function aggregateField(rows: Row[], field: string, pickMax: boolean): unknown {
	let best: unknown = null;
	for (const row of rows) {
		if (!(field in row)) {
			throw new Error(`fake db: fixture row has no field "${field}"`);
		}
		const v = row[field];
		if (v === null || v === undefined) {
			continue;
		}
		if (
			best === null ||
			(pickMax ? compare(v, best) > 0 : compare(v, best) < 0)
		) {
			best = v;
		}
	}
	return best;
}

function fakeTable(table: string) {
	const record = (method: string, args: Record<string, unknown>) => {
		fakeStore.calls.push({ table, method, args: structuredClone(args) });
	};
	const find = (args: Record<string, unknown>): Row[] => {
		const where = (args.where ?? {}) as Record<string, unknown>;
		const matched = tableRows(table).filter((row) =>
			matchesWhere(row, where),
		);
		const ordered = orderRows(matched, args.orderBy);
		const skip = typeof args.skip === "number" ? args.skip : 0;
		const take = typeof args.take === "number" ? args.take : undefined;
		return ordered.slice(
			skip,
			take === undefined ? undefined : skip + take,
		);
	};
	const matching = (args: Record<string, unknown>): Row[] =>
		tableRows(table).filter((row) =>
			matchesWhere(row, (args.where ?? {}) as Record<string, unknown>),
		);
	return {
		findUnique: async (args: Record<string, unknown>) => {
			record("findUnique", args);
			const [row] = find(args);
			return row ? applySelect(row, args.select) : null;
		},
		findFirst: async (args: Record<string, unknown> = {}) => {
			record("findFirst", args);
			const [row] = find(args);
			return row ? applySelect(row, args.select) : null;
		},
		findMany: async (args: Record<string, unknown> = {}) => {
			record("findMany", args);
			return find(args).map((row) => applySelect(row, args.select));
		},
		count: async (args: Record<string, unknown> = {}) => {
			record("count", args);
			return find(args).length;
		},
		aggregate: async (args: Record<string, unknown>) => {
			record("aggregate", args);
			const rows = find({ where: args.where });
			const out: Row = {};
			for (const agg of ["_max", "_min"] as const) {
				const fields = args[agg] as Record<string, unknown> | undefined;
				if (fields) {
					const r: Row = {};
					for (const field of Object.keys(fields)) {
						r[field] = aggregateField(rows, field, agg === "_max");
					}
					out[agg] = r;
				}
			}
			if (args._count === true) {
				out._count = rows.length;
			} else if (args._count !== undefined) {
				out._count = { _all: rows.length };
			}
			return out;
		},
		update: async (args: Record<string, unknown>) => {
			record("update", args);
			const rows = matching(args);
			if (rows.length !== 1) {
				throw new Error(
					`fake db: ${table}.update matched ${rows.length} rows (Prisma throws P2025 on 0)`,
				);
			}
			applyData(rows[0] as Row, args.data as Record<string, unknown>);
			return applySelect(rows[0] as Row, args.select);
		},
		updateMany: async (args: Record<string, unknown>) => {
			record("updateMany", args);
			const rows = matching(args);
			for (const row of rows) {
				applyData(row, args.data as Record<string, unknown>);
			}
			return { count: rows.length };
		},
		create: async (args: Record<string, unknown>) => {
			record("create", args);
			const row: Row = {
				id: `${table}-${fakeStore.nextId++}`,
				createdAt: new Date(),
				...structuredClone(args.data as Row),
			};
			tableRows(table).push(row);
			return applySelect(row, args.select);
		},
	};
}

const fakeDb: Record<string, unknown> = new Proxy(
	{} as Record<string, unknown>,
	{
		get(_target, prop) {
			if (typeof prop !== "string") {
				return undefined;
			}
			if (prop === "$transaction") {
				return async (arg: unknown) => {
					if (Array.isArray(arg)) {
						return Promise.all(arg);
					}
					if (typeof arg === "function") {
						return (arg as (tx: unknown) => Promise<unknown>)(
							fakeDb,
						);
					}
					throw new Error(
						"fake db: unsupported $transaction argument",
					);
				};
			}
			if (prop.startsWith("$")) {
				return () => {
					throw new Error(
						`fake db: ${prop} is not modelled — the seam fake covers Prisma model calls only`,
					);
				};
			}
			// Table existence is checked when a method runs, so a module that
			// merely reads `db.someTable` at load does not throw here.
			return fakeTable(prop);
		},
	},
);

/** Mirrors `packages/database/prisma/default-pm-tool-keys.ts:81-88`. */
const PM_SERVER_KEY_PREFIX = "key:";

function storyRowsByExternalId(projectId: string, externalId: string): Row[] {
	return tableRows("userStory").filter(
		(r) => r.projectId === projectId && r.externalId === externalId,
	);
}

function notOnThisSeam(name: string) {
	return () => {
		throw new Error(
			`fake db: ${name} is not expected on this seam — the fixture drifted into a path the fake does not model`,
		);
	};
}

/** The `@repo/database` module the seam tests mock in. */
export function fakeDatabaseModule(): Record<string, unknown> {
	return {
		db: fakeDb,
		Prisma: {},
		PmSyncStatus: {
			PENDING: "PENDING",
			SUCCESS: "SUCCESS",
			CONFLICT: "CONFLICT",
			FAILED: "FAILED",
		},
		// Copy of `prisma/queries/projects/fabric-url.ts:230-234`
		// (`buildStoryDescription` reads it; the real module needs a Prisma client).
		HTML_BACK_LINK_RE:
			/<p>\s*<a\s+[^>]{0,200}href=["']([^"']+)["'][^>]{0,200}>\s*View in Fabric\s*<\/a>\s*<\/p>/i,
		setAiUsageRecorder: () => undefined,
		isPmServerIdKeySentinel: (id: string) =>
			id.startsWith(PM_SERVER_KEY_PREFIX),
		readPmServerIdKeySentinel: (id: string) =>
			id.slice(PM_SERVER_KEY_PREFIX.length),
		// GitLab is not Fizzy: the real formatters return the input unchanged.
		formatBackLinkForProvider: (d: string | null | undefined) => d ?? "",
		normalizeBackLinkFromProvider: (d: string | null | undefined) =>
			d ?? "",
		isProjectReadOnly: async () => false,
		getStoryById: async (storyId: string, projectId: string) => {
			fakeStore.calls.push({
				table: "userStory",
				method: "getStoryById",
				args: { storyId, projectId },
			});
			const row = tableRows("userStory").find(
				(r) => r.id === storyId && r.projectId === projectId,
			);
			return row ? structuredClone(row) : null;
		},
		// Exactly the shape the real query returns (no ordering option exists:
		// the status-sync fetch rotates in pm-state-poll.ts).
		getLinkedExternalIds: async (projectId: string) =>
			tableRows("userStory")
				.filter(
					(r) => r.projectId === projectId && r.externalId !== null,
				)
				.map((r) => ({
					entityType: "STORY",
					entityId: r.id,
					externalId: r.externalId,
					draftingStage: r.draftingStage,
					pmAutoHidden: r.pmAutoHidden,
					lastSyncedPmHash: r.lastSyncedPmHash,
					lastPmSyncStatus: r.lastPmSyncStatus,
					externalMcpServerId: r.externalMcpServerId ?? null,
					externalUrl: r.externalUrl ?? null,
				})),
		findFabricItemByExternalId: async (
			projectId: string,
			externalId: string,
		) => {
			const [r] = storyRowsByExternalId(projectId, externalId);
			return r
				? {
						entityType: "STORY",
						entityId: r.id,
						draftingStage: r.draftingStage,
						lastSyncedPmHash: r.lastSyncedPmHash,
						lastPmSyncStatus: r.lastPmSyncStatus,
						pmAutoHidden: r.pmAutoHidden,
						pmTicketTerminal: r.pmTicketTerminal,
						pmTicketTerminalStatus: r.pmTicketTerminalStatus,
					}
				: null;
		},
		findFabricItemsByExternalId: async (
			projectId: string,
			externalId: string,
		) =>
			storyRowsByExternalId(projectId, externalId).map((r) => ({
				entityType: "STORY",
				entityId: r.id,
				draftingStage: r.draftingStage,
				externalMcpServerId: r.externalMcpServerId,
			})),
		recordAudit: (entry: Row) => {
			fakeStore.audits.push(structuredClone(entry));
		},
		createPmSyncLog: async (input: Row) => {
			const row: Row = {
				id: `pmSyncLog-${fakeStore.nextId++}`,
				createdAt: new Date(),
				errorPayload: null,
				...structuredClone(input),
			};
			tableRows("pmSyncLog").push(row);
			return { id: row.id };
		},
		// Pin 6: "a CONFLICT pull row with this key EXISTS" — any row, not the
		// latest one (the real query filters on the key; Task 4, Task 11).
		hasPmSyncConflictWithDedupeKey: async (args: {
			projectId: string;
			entityId: string;
			dedupeKey: string;
		}) =>
			tableRows("pmSyncLog").some(
				(r) =>
					r.projectId === args.projectId &&
					r.entityId === args.entityId &&
					r.direction === "pull" &&
					r.status === "CONFLICT" &&
					(
						r.errorPayload as
							| { dedupeKey?: unknown }
							| null
							| undefined
					)?.dedupeKey === args.dedupeKey,
			),
		mergePmStatusSyncLastRun: async (args: {
			projectId: string;
			sessionAt: Date;
			patch: Record<string, unknown>;
		}) => {
			fakeStore.lastRunPatches.push(structuredClone(args));
			const project = tableRows("project").find(
				(r) => r.id === args.projectId,
			);
			if (
				!project ||
				project.pmStatusSyncEnabled !== true ||
				!equals(project.pmStatusSyncSessionAt, new Date(args.sessionAt))
			) {
				return;
			}
			project.pmStatusSyncLastRun = {
				...((project.pmStatusSyncLastRun as Row | null) ?? {}),
				...(JSON.parse(JSON.stringify(args.patch)) as Row),
			};
		},
		upsertPendingChange: notOnThisSeam("upsertPendingChange"),
		clearPendingContentDrift: notOnThisSeam("clearPendingContentDrift"),
		applyTerminalClose: notOnThisSeam("applyTerminalClose"),
		applyTerminalUnhide: notOnThisSeam("applyTerminalUnhide"),
		createPmSyncConflictNotifications: notOnThisSeam(
			"createPmSyncConflictNotifications",
		),
		autoDismissReappearedFlagMissing: notOnThisSeam(
			"autoDismissReappearedFlagMissing",
		),
		incrementMissingStreak: notOnThisSeam("incrementMissingStreak"),
		pendingFlagMissingExists: notOnThisSeam("pendingFlagMissingExists"),
		resetMissingStreaks: notOnThisSeam("resetMissingStreaks"),
	};
}
