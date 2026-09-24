/**
 * A stateful stand-in for the tables the instructions subject's store
 * writes (Decision 54): `project_instruction_repository_sync`, its run
 * table, and the audit rows `recordAuditTx` would add. It is not a SQL
 * engine. It evaluates exactly the statements the store sends, with real
 * conditional-update semantics, and throws on anything else, so a statement
 * it cannot evaluate fails the test instead of passing silently.
 *
 * - `root` stands for `db`. `$transaction` hands its callback a DIFFERENT
 *   client. While a transaction is open a call on `root` throws, and a
 *   transaction client throws once its transaction has closed, so code that
 *   uses `db` where the caller's `tx` is required fails.
 * - A transaction whose callback throws restores every table.
 * - `now()` is the database clock that `clock_timestamp()` reads. Only
 *   `advance` and `reset` move it; nothing here reads the host clock.
 *
 * One shared instance, `instructionSyncRowStore`, so a `vi.mock` factory can
 * import it and hand out `root` as `db`. Call `reset()` in `beforeEach`.
 */
import type { Prisma } from "../../prisma/client";

type SyncRow = {
	id: string;
	projectId: string;
	organizationId: string;
	userId: string;
	repositoryIntegrationId: string;
	ref: string;
	generation: number;
	automatic: boolean;
	automaticPausedReason: string | null;
	automaticPausedAt: Date | null;
	/** Null while paused: nothing is scheduled. */
	nextCheckAt: Date | null;
	failureCount: number;
	lastEvaluatedCommitSha: string | null;
	lastEvaluatedGeneration: number | null;
	suppressedCommitSha: string | null;
	suppressedGeneration: number | null;
	updatedAt: Date;
	/** The row's integration's status, which the claim's join reads. */
	integrationStatus: "ACTIVE" | "TOKEN_EXPIRED";
};

type RunRow = { id: string } & Record<string, unknown>;

type Statement = { text: string; values: readonly unknown[] };

type RowStoreRoot = Prisma.TransactionClient & {
	$transaction<T>(
		fn: (tx: Prisma.TransactionClient) => Promise<T>,
	): Promise<T>;
};

const START = new Date("2026-09-23T12:00:00.000Z");
const TABLE = '"project_instruction_repository_sync"';
/** Only the claim carries this; the store models it from its parameters. */
const CLAIM_MARK = "FOR UPDATE OF s2 SKIP LOCKED";

const ROW_DEFAULTS: Omit<SyncRow, "id" | "nextCheckAt" | "updatedAt"> = {
	projectId: "proj_1",
	organizationId: "org_1",
	userId: "user_1",
	repositoryIntegrationId: "int_1",
	ref: "main",
	generation: 3,
	automatic: true,
	automaticPausedReason: null,
	automaticPausedAt: null,
	failureCount: 1,
	lastEvaluatedCommitSha: null,
	lastEvaluatedGeneration: null,
	suppressedCommitSha: null,
	suppressedGeneration: null,
	integrationStatus: "ACTIVE",
};

function squash(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** A tagged template or a `Prisma.sql` object, as one numbered statement. */
function statementOf(args: readonly unknown[]): Statement {
	const [first, ...rest] = args;
	if (Array.isArray(first)) {
		const text = (first as readonly string[])
			.map((part, i) => (i === 0 ? part : `$${i}${part}`))
			.join("");
		return { text: squash(text), values: rest };
	}
	const sql = first as { text?: unknown; values?: unknown } | undefined;
	if (typeof sql?.text !== "string" || !Array.isArray(sql.values)) {
		throw new Error(
			"the row store understands tagged templates and Prisma.sql only",
		);
	}
	return { text: squash(sql.text), values: sql.values };
}

function same(a: unknown, b: unknown): boolean {
	return a instanceof Date && b instanceof Date
		? a.getTime() === b.getTime()
		: a === b;
}

function copyRow(row: SyncRow): SyncRow {
	return {
		...row,
		nextCheckAt: row.nextCheckAt && new Date(row.nextCheckAt),
		updatedAt: new Date(row.updatedAt),
		automaticPausedAt:
			row.automaticPausedAt && new Date(row.automaticPausedAt),
	};
}

/** A column the fence or a `SET` names; anything else is a statement the store does not know. */
function column(row: SyncRow, name: string | undefined): keyof SyncRow {
	if (name === undefined || !(name in row) || name === "integrationStatus") {
		throw new Error(`the row store has no column "${name}"`);
	}
	return name as keyof SyncRow;
}

function createInstructionSyncRowStore() {
	let clock = START.getTime();
	let rows = new Map<string, SyncRow>();
	let runs = new Map<string, RunRow>();
	let audits: unknown[] = [];
	let openTx: object | null = null;
	let auditFailure: Error | null = null;

	const now = (): Date => new Date(clock);

	/** One predicate of a `WHERE`, against one row. */
	function holds(
		row: SyncRow,
		predicate: string,
		values: readonly unknown[],
	): boolean {
		const param = /^"(\w+)" = \$(\d+)$/.exec(predicate);
		if (param) {
			return same(
				row[column(row, param[1])],
				values[Number(param[2]) - 1],
			);
		}
		const ahead =
			/^"(\w+)" > \(clock_timestamp\(\) AT TIME ZONE 'UTC'\)$/.exec(
				predicate,
			);
		if (ahead) {
			const value = row[column(row, ahead[1])];
			return value instanceof Date && value.getTime() > clock;
		}
		const isTrue = /^"(\w+)" = true$/.exec(predicate);
		if (isTrue) {
			return row[column(row, isTrue[1])] === true;
		}
		const isNull = /^"(\w+)" IS NULL$/.exec(predicate);
		if (isNull) {
			return row[column(row, isNull[1])] === null;
		}
		throw new Error(`the row store cannot evaluate: ${predicate}`);
	}

	function matches(
		row: SyncRow,
		where: string,
		values: readonly unknown[],
	): boolean {
		return where
			.split(" AND ")
			.every((predicate) => holds(row, predicate, values));
	}

	/** One `SET` assignment, applied to one row. */
	function assign(
		row: SyncRow,
		assignment: string,
		values: readonly unknown[],
	): void {
		const target = row as Record<string, unknown>;
		const param = /^"(\w+)" = \$(\d+)(?:::"\w+")?$/.exec(assignment);
		if (param) {
			const value = values[Number(param[2]) - 1];
			target[column(row, param[1])] =
				value instanceof Date ? new Date(value) : value;
			return;
		}
		const fromClock =
			/^"(\w+)" = \(clock_timestamp\(\) AT TIME ZONE 'UTC'\)$/.exec(
				assignment,
			);
		if (fromClock) {
			target[column(row, fromClock[1])] = now();
			return;
		}
		throw new Error(`the row store cannot apply: ${assignment}`);
	}

	/** Task 2's claim, from its three parameters: the lease, `now` and the limit. */
	function claim(values: readonly unknown[]): unknown[] {
		const [leaseUntil, at, limit] = values as [Date, Date, number];
		return [...rows.values()]
			.filter(
				(row) =>
					row.automatic &&
					row.automaticPausedReason === null &&
					row.integrationStatus === "ACTIVE" &&
					row.nextCheckAt !== null &&
					row.nextCheckAt.getTime() <= at.getTime(),
			)
			.sort(
				(a, b) =>
					(a.nextCheckAt?.getTime() ?? 0) -
						(b.nextCheckAt?.getTime() ?? 0) ||
					a.id.localeCompare(b.id),
			)
			.slice(0, limit)
			.map((row) => {
				row.nextCheckAt = new Date(leaseUntil);
				return {
					id: row.id,
					projectId: row.projectId,
					organizationId: row.organizationId,
					userId: row.userId,
					generation: row.generation,
					repositoryIntegrationId: row.repositoryIntegrationId,
					ref: row.ref,
					lastEvaluatedCommitSha: row.lastEvaluatedCommitSha,
					lastEvaluatedGeneration: row.lastEvaluatedGeneration,
					suppressedCommitSha: row.suppressedCommitSha,
					suppressedGeneration: row.suppressedGeneration,
					failureCount: row.failureCount,
					leaseUntil: new Date(row.nextCheckAt),
				};
			});
	}

	function query({ text, values }: Statement): unknown[] {
		if (text.includes(CLAIM_MARK)) {
			return claim(values);
		}
		const select = new RegExp(
			`^SELECT "id" FROM ${TABLE} WHERE (.+)$`,
		).exec(text);
		if (!select) {
			throw new Error(`the row store cannot run: ${text}`);
		}
		const where = select[1] ?? "";
		return [...rows.values()]
			.filter((row) => matches(row, where, values))
			.map((row) => ({ id: row.id }));
	}

	function execute({ text, values }: Statement): number {
		const update = new RegExp(`^UPDATE ${TABLE} SET (.+) WHERE (.+)$`).exec(
			text,
		);
		if (!update) {
			throw new Error(`the row store cannot run: ${text}`);
		}
		const assignments = (update[1] ?? "").split(/, (?=")/);
		const where = update[2] ?? "";
		let count = 0;
		for (const row of rows.values()) {
			if (matches(row, where, values)) {
				for (const assignment of assignments) {
					assign(row, assignment, values);
				}
				count++;
			}
		}
		return count;
	}

	function client(usable: () => void): Prisma.TransactionClient {
		const api = {
			$queryRaw: async (...args: unknown[]) => {
				usable();
				return query(statementOf(args));
			},
			$executeRaw: async (...args: unknown[]) => {
				usable();
				return execute(statementOf(args));
			},
			projectInstructionRepositorySyncRun: {
				createMany: async (input: {
					data: RunRow[];
					skipDuplicates?: boolean;
				}) => {
					usable();
					let count = 0;
					for (const run of input.data) {
						if (runs.has(run.id)) {
							if (!input.skipDuplicates) {
								throw new Error(`duplicate run id ${run.id}`);
							}
							continue;
						}
						runs.set(run.id, { ...run });
						count++;
					}
					return { count };
				},
			},
		};
		return api as unknown as Prisma.TransactionClient;
	}

	const root = Object.assign(
		client(() => {
			if (openTx !== null) {
				throw new Error(
					"db was used while a transaction was open: pass the transaction client",
				);
			}
		}),
		{
			async $transaction<T>(
				fn: (tx: Prisma.TransactionClient) => Promise<T>,
			): Promise<T> {
				if (openTx !== null) {
					throw new Error("the row store does not nest transactions");
				}
				const saved = {
					rows: new Map(
						[...rows].map(
							([id, row]) => [id, copyRow(row)] as const,
						),
					),
					runs: new Map(runs),
					audits: [...audits],
				};
				let open = true;
				const tx = client(() => {
					if (!open) {
						throw new Error(
							"a transaction client was used after its transaction closed",
						);
					}
				});
				openTx = tx;
				try {
					return await fn(tx);
				} catch (error) {
					rows = saved.rows;
					runs = saved.runs;
					audits = saved.audits;
					throw error;
				} finally {
					open = false;
					openTx = null;
				}
			},
		},
	) as RowStoreRoot;

	return {
		root,
		/** What the `recordAuditTx` mock calls: only on the open transaction's client. */
		async recordAudit(tx: unknown, entry: unknown): Promise<void> {
			if (openTx === null || tx !== openTx) {
				throw new Error(
					"recordAuditTx must be given the open transaction's client",
				);
			}
			if (auditFailure !== null) {
				const failure = auditFailure;
				auditFailure = null;
				throw failure;
			}
			audits.push(entry);
		},
		/** The next audit write throws `error`, as a failed insert would. */
		failNextAuditWith(error: Error): void {
			auditFailure = error;
		},
		/** Stores a row. Unnamed columns take the defaults, and `nextCheckAt` the clock. */
		put(row: Partial<SyncRow> & { id: string }): void {
			rows.set(row.id, {
				...ROW_DEFAULTS,
				nextCheckAt: now(),
				updatedAt: now(),
				...row,
			});
		},
		/** What another writer did to a row, applied directly. */
		update(id: string, changes: Partial<SyncRow>): void {
			const row = rows.get(id);
			if (!row) {
				throw new Error(`the row store has no row ${id}`);
			}
			Object.assign(row, changes);
		},
		remove(id: string): void {
			rows.delete(id);
		},
		row(id: string): SyncRow | undefined {
			const row = rows.get(id);
			return row && copyRow(row);
		},
		runs: (): RunRow[] => [...runs.values()],
		audits: (): unknown[] => [...audits],
		now,
		advance(ms: number): void {
			clock += ms;
		},
		reset(at: Date = START): void {
			clock = at.getTime();
			rows = new Map();
			runs = new Map();
			audits = [];
			openTx = null;
			auditFailure = null;
		},
	};
}

export const instructionSyncRowStore = createInstructionSyncRowStore();
