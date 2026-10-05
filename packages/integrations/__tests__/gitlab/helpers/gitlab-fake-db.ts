/**
 * In-memory stand-in for the Prisma models the GitLab connection service
 * touches, applying `where` clauses the way Prisma does rather than returning
 * whatever a test pre-decided. Supported operators are the ones the service
 * and its callers use: scalar equality (including `null`), `{ in }`,
 * `{ not }`, `NOT`, and the two relation filters (`mcpServer`, `project`).
 * Anything else throws, so a query that grows a new operator fails loudly
 * instead of matching every row. A key whose value is `undefined` is ignored,
 * as in Prisma.
 *
 * `withLock` is a real FIFO mutex per key, so tests can run operations
 * concurrently and observe that the lifecycle lock serializes them. It is
 * also the transaction, as `withRefreshLock` is in production: when the
 * locked callback throws, every write it made is rolled back (rows keep their
 * identity, so a test holding a row sees the restored values). A write that
 * must survive a failure therefore has to be returned as a value, not thrown
 * past — which is what the tests can now prove.
 *
 * `workflowIntegration.create` enforces the partial unique index on personal
 * GitLab rows (`workflow_integration_personal_gitlab_key`: one row per
 * (userId, organizationId) over provider GITLAB, no workflow, name not
 * GITLAB_OAUTH_APP) and throws a Prisma-shaped `P2002` on a duplicate, so a
 * create that would violate it fails here as it does in Postgres.
 * `hooks.beforeCreate` runs just before each create, so a test can land a
 * competing insert exactly in the gap a lock-free writer would race through.
 */

type Row = Record<string, unknown> & { id: string };

type Tables = {
	workflowIntegration: Row[];
	mCPConfig: Row[];
	mCPServer: Row[];
	projectRepositoryIntegration: Row[];
	project: Row[];
	/** Only for callers above the service (the personal disconnect marks these). */
	dataConnection: Row[];
};

let idCounter = 0;

function matchesValue(actual: unknown, expected: unknown): boolean {
	if (expected === null || typeof expected !== "object") {
		return actual === expected;
	}
	if (expected instanceof Date) {
		return (
			actual instanceof Date && actual.getTime() === expected.getTime()
		);
	}
	const ops = expected as Record<string, unknown>;
	const keys = Object.keys(ops);
	if (keys.length === 1 && Array.isArray(ops.in)) {
		return (ops.in as unknown[]).includes(actual);
	}
	if (keys.length === 1 && "not" in ops) {
		return !matchesValue(actual, ops.not);
	}
	throw new Error(
		`gitlab-fake-db: unsupported operator ${JSON.stringify(expected)}`,
	);
}

/** Inside the partial unique index on personal GitLab connection rows. */
function isPersonalGitLabRow(row: Record<string, unknown>): boolean {
	return (
		row.provider === "GITLAB" &&
		(row.workflowId ?? null) === null &&
		row.name !== "GITLAB_OAUTH_APP"
	);
}

export function createGitLabFakeDb(seed: Partial<Tables> = {}) {
	const tables: Tables = {
		workflowIntegration: [],
		mCPConfig: [],
		mCPServer: [],
		projectRepositoryIntegration: [],
		project: [],
		dataConnection: [],
		...seed,
	};

	const relations: Record<
		string,
		Record<string, { table: keyof Tables; foreignKey: string }>
	> = {
		mCPConfig: {
			mcpServer: { table: "mCPServer", foreignKey: "mcpServerId" },
		},
		projectRepositoryIntegration: {
			project: { table: "project", foreignKey: "projectId" },
		},
	};

	function matches(
		model: keyof Tables,
		row: Row,
		where: Record<string, unknown> = {},
	): boolean {
		for (const [key, expected] of Object.entries(where)) {
			if (expected === undefined) {
				continue;
			}
			if (key === "NOT") {
				if (matches(model, row, expected as Record<string, unknown>)) {
					return false;
				}
				continue;
			}
			if (key === "OR" || key === "AND") {
				throw new Error(
					`gitlab-fake-db: unsupported combinator ${key}`,
				);
			}
			const relation = relations[model]?.[key];
			if (relation) {
				const related = tables[relation.table].find(
					(each) => each.id === row[relation.foreignKey],
				);
				if (
					!related ||
					!matches(
						relation.table,
						related,
						expected as Record<string, unknown>,
					)
				) {
					return false;
				}
				continue;
			}
			if (!matchesValue(row[key], expected)) {
				return false;
			}
		}
		return true;
	}

	function project(model: keyof Tables, row: Row): Row {
		const copy: Row = { ...row };
		for (const [name, relation] of Object.entries(relations[model] ?? {})) {
			const related = tables[relation.table].find(
				(each) => each.id === row[relation.foreignKey],
			);
			copy[name] = related ? { ...related } : null;
		}
		return copy;
	}

	function model(name: keyof Tables) {
		const rows = () => tables[name];
		return {
			findMany: async (args?: { where?: Record<string, unknown> }) =>
				rows()
					.filter((row) => matches(name, row, args?.where))
					.map((row) => project(name, row)),
			findFirst: async (args?: { where?: Record<string, unknown> }) => {
				const row = rows().find((each) =>
					matches(name, each, args?.where),
				);
				return row ? project(name, row) : null;
			},
			findUnique: async (args: { where: Record<string, unknown> }) => {
				const row = rows().find((each) =>
					matches(name, each, args.where),
				);
				return row ? project(name, row) : null;
			},
			create: async (args: { data: Record<string, unknown> }) => {
				await hooks.beforeCreate?.(name, args.data);
				if (
					name === "workflowIntegration" &&
					isPersonalGitLabRow(args.data) &&
					rows().some(
						(each) =>
							isPersonalGitLabRow(each) &&
							each.userId === args.data.userId &&
							(each.organizationId ?? null) ===
								(args.data.organizationId ?? null),
					)
				) {
					throw Object.assign(
						new Error(
							"Unique constraint failed on workflow_integration_personal_gitlab_key",
						),
						{ code: "P2002" },
					);
				}
				idCounter += 1;
				const now = new Date(Date.now() + idCounter);
				const row: Row = {
					id: `${name}-${idCounter}`,
					createdAt: now,
					updatedAt: now,
					workflowId: null,
					...args.data,
				};
				rows().push(row);
				return project(name, row);
			},
			update: async (args: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				const row = rows().find((each) =>
					matches(name, each, args.where),
				);
				if (!row) {
					throw new Error(
						`gitlab-fake-db: ${name}.update matched no row`,
					);
				}
				Object.assign(row, args.data, { updatedAt: new Date() });
				return project(name, row);
			},
			updateMany: async (args: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				const hits = rows().filter((each) =>
					matches(name, each, args.where),
				);
				for (const row of hits) {
					Object.assign(row, args.data, { updatedAt: new Date() });
				}
				return { count: hits.length };
			},
			delete: async (args: { where: Record<string, unknown> }) => {
				const index = rows().findIndex((each) =>
					matches(name, each, args.where),
				);
				if (index < 0) {
					throw new Error(
						`gitlab-fake-db: ${name}.delete matched no row`,
					);
				}
				const [removed] = rows().splice(index, 1);
				return removed;
			},
			deleteMany: async (args?: { where?: Record<string, unknown> }) => {
				const keep = rows().filter(
					(each) => !matches(name, each, args?.where),
				);
				const count = rows().length - keep.length;
				rows().splice(0, rows().length, ...keep);
				return { count };
			},
		};
	}

	const db = {
		workflowIntegration: model("workflowIntegration"),
		mCPConfig: model("mCPConfig"),
		mCPServer: model("mCPServer"),
		projectRepositoryIntegration: model("projectRepositoryIntegration"),
		project: model("project"),
		dataConnection: model("dataConnection"),
		$transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
	};

	type Snapshot = Array<[keyof Tables, Array<[Row, Row]>]>;
	let rollbacks = 0;

	/** Every row (by identity) with a deep copy of its values. */
	function snapshotTables(): Snapshot {
		return (Object.keys(tables) as Array<keyof Tables>).map((name) => [
			name,
			tables[name].map((row): [Row, Row] => [row, structuredClone(row)]),
		]);
	}

	/** Put each table back as it was: same row objects, old values. */
	function restoreTables(snapshot: Snapshot): void {
		for (const [name, rows] of snapshot) {
			for (const [row, values] of rows) {
				for (const key of Object.keys(row)) {
					delete row[key];
				}
				Object.assign(row, values);
			}
			tables[name].splice(
				0,
				tables[name].length,
				...rows.map(([row]) => row),
			);
		}
	}

	const queues = new Map<string, Promise<void>>();
	const acquired: string[][] = [];
	const committedElsewhere: Array<[keyof Tables, Row]> = [];

	/**
	 * Insert a row as a concurrent writer outside every lock would: it is
	 * visible at once and survives the rollback of any locked callback that
	 * was running when it landed.
	 */
	function insertCommitted(name: keyof Tables, row: Row): void {
		tables[name].push(row);
		committedElsewhere.push([name, row]);
	}
	const hooks: {
		/**
		 * Runs before every `create`, with the model and the data about to be
		 * inserted. Tests use it to insert a competing row first.
		 */
		beforeCreate?: (
			model: keyof Tables,
			data: Record<string, unknown>,
		) => Promise<void> | void;
		/**
		 * Runs once per lock request, BEFORE it queues — the moment a caller
		 * has read state outside the lock and is about to act on it. Tests use
		 * it to land a concurrent change exactly there.
		 */
		beforeAcquire?: (keys: readonly string[]) => Promise<void> | void;
		/** The `assertBudget` handed to the locked callback (no-op by default). */
		assertBudget?: (requiredMs: number) => void;
	} = {};

	/**
	 * FIFO mutex per key; keys are taken in the order given. Accepts one key
	 * or several, like `withRefreshLock`.
	 */
	async function withLock<T>(
		keyOrKeys: string | readonly string[],
		fn: (tx: typeof db, assertBudget: (ms: number) => void) => Promise<T>,
	): Promise<T> {
		const keys = typeof keyOrKeys === "string" ? [keyOrKeys] : keyOrKeys;
		const hook = hooks.beforeAcquire;
		if (hook) {
			await hook(keys);
		}
		const releases: Array<() => void> = [];
		for (const key of keys) {
			const previous = queues.get(key) ?? Promise.resolve();
			let release!: () => void;
			const next = new Promise<void>((resolve) => {
				release = resolve;
			});
			queues.set(
				key,
				previous.then(() => next),
			);
			await previous;
			releases.push(release);
		}
		acquired.push([...keys]);
		const snapshot = snapshotTables();
		try {
			return await fn(db, (requiredMs) =>
				hooks.assertBudget?.(requiredMs),
			);
		} catch (error) {
			restoreTables(snapshot);
			// A row another transaction committed meanwhile survives this
			// transaction's rollback, as it does in Postgres.
			for (const [name, row] of committedElsewhere) {
				if (!tables[name].includes(row)) {
					tables[name].push(row);
				}
			}
			rollbacks += 1;
			throw error;
		} finally {
			for (const release of releases.reverse()) {
				release();
			}
		}
	}

	return {
		db,
		tables,
		withLock,
		acquired,
		hooks,
		insertCommitted,
		/** How many locked callbacks threw and were rolled back. */
		rollbackCount: () => rollbacks,
	};
}

/** Prefix "encryption" so a test can tell ciphertext from plaintext. */
export const fakeEncrypt = (value: string) => `enc:${value}`;
export const fakeDecrypt = (value: string) => {
	if (!value.startsWith("enc:")) {
		throw new Error(`not fake ciphertext: ${value}`);
	}
	return value.slice(4);
};

export function encryptedCredential(value: Record<string, unknown>): string {
	return fakeEncrypt(JSON.stringify(value));
}

export function readCredential(row: { credentials: unknown }) {
	return JSON.parse(fakeDecrypt(String(row.credentials))) as Record<
		string,
		unknown
	> & {
		issuer?: Record<string, unknown>;
		connectionGeneration?: number;
	};
}
