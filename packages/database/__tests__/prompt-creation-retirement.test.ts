/**
 * `createPrompt` honours a recorded retirement (Fizzy #2328 — R9, KTD5).
 *
 * The product's create endpoint calls `createPrompt` for a global admin, so
 * guarding only the two seeds would leave the requirement false while its
 * acceptance example still passed: an administrator could delete a system
 * prompt and then create it again under the same key through the UI, with no
 * audit trail saying a retirement had been overridden.
 *
 * The properties specified here:
 *
 *   - a SYSTEM insert for a recorded key is REFUSED, and writes nothing;
 *   - the refusal carries a stable `code`, because that is what the procedure
 *     duck-types on (see the `P2025` handling in the delete procedure);
 *   - the check and the insert are ONE transaction, taken under the per-key
 *     advisory lock BEFORE anything is read — a read followed by an insert
 *     would let a deletion committing in between recreate the prompt on a
 *     decision that is already stale;
 *   - ORG and USER scopes are untouched. A retirement is a statement about the
 *     platform's catalogue key; a tenant's own prompt sharing that key is
 *     nobody else's business, and the deletion leaves it alone for the same
 *     reason;
 *   - a database that predates the retirement table creates as it did before.
 *
 * The real-Postgres half — that the lock genuinely serializes a creation
 * against a deletion — is in `prompt-retirement.integration.test.ts`.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/prompt-creation-retirement.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const RETIRED_KEY = "prd_writer";

const h = vi.hoisted(() => {
	const store = {
		prompts: [] as { id: string; key: string; scope: string }[],
		versions: [] as { id: string; promptId: string; content: string }[],
		retired: new Set<string>(),
		/** Visible only to the in-transaction re-check: a deletion that
		 *  committed after a caller read "not retired". */
		retiredMidRun: new Set<string>(),
	};

	const control = {
		/** False makes the `to_regclass` probe report the table absent, as it
		 *  is on a database that predates the migration. */
		tablePresent: true,
	};

	/** The ORDER of statements matters — the lock must come first — so it is
	 *  recorded rather than inferred from which mocks were called. */
	const seen: string[] = [];

	/** Every value bound into a `set_config('lock_timeout', ...)` call. */
	const lockTimeoutValues: unknown[] = [];

	let seq = 0;

	const tx = {
		prompt: {
			create: vi.fn(async ({ data }: any) => {
				seen.push("prompt.create");
				const row = {
					id: `p-${++seq}`,
					key: data.key,
					scope: data.scope,
				};
				store.prompts.push(row);
				return row;
			}),
		},
		promptVersion: {
			create: vi.fn(async ({ data }: any) => {
				seen.push("version.create");
				const row = {
					id: `v-${++seq}`,
					promptId: data.promptId,
					content: data.content,
				};
				store.versions.push(row);
				return row;
			}),
		},
		retiredPromptKey: {
			findUnique: vi.fn(async ({ where }: any) => {
				seen.push("retirement.read");
				return store.retired.has(where.key) ||
					store.retiredMidRun.has(where.key)
					? { key: where.key }
					: null;
			}),
		},
		$executeRaw: vi.fn(
			async (strings: TemplateStringsArray, ...values: unknown[]) => {
				const sql = strings.join("?");
				if (sql.includes("pg_advisory_xact_lock")) {
					seen.push("lock");
				}
				// `set_config(..., true)` IS `SET LOCAL`, in the form that
				// takes a bind parameter. The bound value is recorded, not
				// just the fact of the statement: a ceiling of "0" would be
				// no ceiling at all and would still push this string.
				if (sql.includes("set_config")) {
					seen.push("lock.timeout");
					lockTimeoutValues.push(values[0]);
				}
				return 1;
			},
		),
		$queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
			if (strings.join("?").includes("to_regclass")) {
				seen.push("catalog.probe");
				return [{ present: control.tablePresent }];
			}
			return [];
		}),
	};

	const db = {
		prompt: {
			create: vi.fn(async ({ data }: any) => {
				seen.push("db.prompt.create");
				const row = {
					id: `p-${++seq}`,
					key: data.key,
					scope: data.scope,
				};
				store.prompts.push(row);
				return row;
			}),
		},
		promptVersion: {
			create: vi.fn(async ({ data }: any) => {
				seen.push("db.version.create");
				const row = {
					id: `v-${++seq}`,
					promptId: data.promptId,
					content: data.content,
				};
				store.versions.push(row);
				return row;
			}),
		},
		retiredPromptKey: { findMany: vi.fn(async () => []) },
		$transaction: vi.fn(
			async (fn: (c: unknown) => unknown, options: unknown) => {
				seen.push("transaction");
				transactionOptions = options;
				return fn(tx);
			},
		),
	};

	let transactionOptions: unknown;

	const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

	return {
		store,
		control,
		seen,
		lockTimeoutValues,
		tx,
		db,
		logger,
		options: () => transactionOptions,
	};
});

vi.mock("../prisma/client", () => ({ db: h.db, Prisma: {} }));
vi.mock("@repo/logs", () => ({ logger: h.logger }));

import { createPrompt, PromptKeyRetiredError } from "../prisma/queries/prompts";

beforeEach(() => {
	h.store.prompts = [];
	h.store.versions = [];
	h.store.retired = new Set();
	h.store.retiredMidRun = new Set();
	h.control.tablePresent = true;
	h.seen.length = 0;
	h.lockTimeoutValues.length = 0;
	vi.clearAllMocks();
});

describe("createPrompt — a SYSTEM key that has been retired", () => {
	it("refuses, and writes nothing", async () => {
		h.store.retired.add(RETIRED_KEY);

		await expect(
			createPrompt({
				key: RETIRED_KEY,
				name: "PRD Writer",
				scope: "SYSTEM",
				createdBy: "user-operator",
				initialContent: "body",
			}),
		).rejects.toBeInstanceOf(PromptKeyRetiredError);

		expect(h.store.prompts).toEqual([]);
		expect(h.store.versions).toEqual([]);
		expect(h.tx.prompt.create).not.toHaveBeenCalled();
	});

	// The procedure classifies this by code, exactly as it classifies Prisma's
	// P2025 — so the code is part of the contract, not an implementation
	// detail, and a mocked module boundary cannot break the classification.
	it("carries the code and the key the refusal is about", async () => {
		h.store.retired.add(RETIRED_KEY);

		const error = await createPrompt({
			key: RETIRED_KEY,
			name: "PRD Writer",
			scope: "SYSTEM",
			createdBy: "user-operator",
		}).catch((e) => e);

		expect(error).toMatchObject({
			code: "PROMPT_KEY_RETIRED",
			promptKey: RETIRED_KEY,
			name: "PromptKeyRetiredError",
		});
		expect(String(error.message)).toContain(RETIRED_KEY);
	});

	// AE14 in miniature. The caller's own read said "not retired"; the record
	// landed before the insert. Only a check INSIDE the transaction can catch
	// that, which is why the two share one.
	it("is refused by the in-transaction re-check when the record lands mid-flight", async () => {
		h.store.retiredMidRun.add(RETIRED_KEY);

		await expect(
			createPrompt({
				key: RETIRED_KEY,
				name: "PRD Writer",
				scope: "SYSTEM",
				createdBy: "user-operator",
			}),
		).rejects.toBeInstanceOf(PromptKeyRetiredError);

		expect(h.store.prompts).toEqual([]);
	});
});

describe("createPrompt — a SYSTEM key with no record", () => {
	it("creates the prompt and its first version inside one transaction", async () => {
		const prompt = await createPrompt({
			key: RETIRED_KEY,
			name: "PRD Writer",
			scope: "SYSTEM",
			createdBy: "user-operator",
			initialContent: "body",
		});

		expect(prompt.key).toBe(RETIRED_KEY);
		expect(h.store.prompts).toHaveLength(1);
		expect(h.store.versions).toHaveLength(1);
		// Through the transaction client, never beside it: a version written
		// outside would survive a rolled-back prompt insert.
		expect(h.db.prompt.create).not.toHaveBeenCalled();
		expect(h.db.promptVersion.create).not.toHaveBeenCalled();
	});

	// A retirement committing between the read and the insert is the failure
	// this ordering exists to prevent, and only the lock closes that window.
	it("takes the per-key lock before it reads the retirement state", async () => {
		await createPrompt({
			key: RETIRED_KEY,
			name: "PRD Writer",
			scope: "SYSTEM",
			createdBy: "user-operator",
		});

		expect(h.seen).toEqual([
			"transaction",
			"lock.timeout",
			"lock",
			"catalog.probe",
			"retirement.read",
			"prompt.create",
		]);
		expect(h.options()).toMatchObject({
			timeout: expect.any(Number),
			maxWait: expect.any(Number),
		});
	});

	// A deletion may hold this key's lock for up to its own cascade budget, and
	// Prisma's `maxWait` does not bound a statement INSIDE the transaction — it
	// is spent by the time the callback runs. Without a ceiling set here, every
	// creation queued behind a deletion pins a pool connection for the whole
	// cascade, and the connection stays pinned to Postgres even once the client
	// has given up. The bound is what turns that into a prompt 55P03 failure
	// whose retry gets the real answer.
	it("bounds the wait for the key lock, before asking for the lock", async () => {
		await createPrompt({
			key: RETIRED_KEY,
			name: "PRD Writer",
			scope: "SYSTEM",
			createdBy: "user-operator",
		});

		expect(h.seen.indexOf("lock.timeout")).toBeGreaterThanOrEqual(0);
		expect(h.seen.indexOf("lock.timeout")).toBeLessThan(
			h.seen.indexOf("lock"),
		);
		// A real ceiling, not "0" (which Postgres reads as no ceiling at all),
		// and inside the transaction budget so it can actually fire first.
		expect(h.lockTimeoutValues).toHaveLength(1);
		const bound = String(h.lockTimeoutValues[0]);
		expect(bound).toMatch(/^\d+ms$/);
		const ms = Number.parseInt(bound, 10);
		expect(ms).toBeGreaterThan(0);
		expect(ms).toBeLessThan(
			(h.options() as { timeout: number }).timeout ?? 0,
		);
	});

	// The ordered seed runner and the create endpoint both reach this path on a
	// database that predates the migration. Querying a table that does not
	// exist would abort the transaction and take the insert with it, so the
	// probe comes first and a missing table degrades to "nothing is retired".
	it("warns and creates as before when the table does not exist yet", async () => {
		h.control.tablePresent = false;

		const prompt = await createPrompt({
			key: RETIRED_KEY,
			name: "PRD Writer",
			scope: "SYSTEM",
			createdBy: "user-operator",
		});

		expect(prompt.key).toBe(RETIRED_KEY);
		expect(h.tx.retiredPromptKey.findUnique).not.toHaveBeenCalled();
		expect(
			h.logger.warn.mock.calls.some((call) =>
				String(call[0]).includes("retired_prompt_key is missing"),
			),
		).toBe(true);
	});
});

describe("createPrompt — the tenant scopes are untouched", () => {
	it.each(["ORG", "USER"] as const)(
		"creates a %s prompt even when the same key is recorded",
		async (scope) => {
			h.store.retired.add(RETIRED_KEY);

			const prompt = await createPrompt({
				key: RETIRED_KEY,
				name: "Our own PRD writer",
				scope,
				userId: scope === "USER" ? "user-7" : undefined,
				organizationId: scope === "ORG" ? "org-1" : undefined,
				createdBy: "user-operator",
				initialContent: "body",
			});

			expect(prompt.scope).toBe(scope);
			expect(h.store.prompts).toHaveLength(1);
			expect(h.store.versions).toHaveLength(1);
			// No transaction, no lock, no retirement read: byte-for-byte the
			// path these scopes took before the guard existed.
			expect(h.db.$transaction).not.toHaveBeenCalled();
			expect(h.seen).toEqual(["db.prompt.create", "db.version.create"]);
		},
	);
});
