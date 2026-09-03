/**
 * Neither catalogue seed brings back a prompt whose key is recorded as retired
 * (Fizzy #2328 — R9, KTD4, KTD5).
 *
 * Two seed scripts create SYSTEM prompts from a key, and both did it by looking
 * the key up and calling `db.prompt.create` when the row was missing. That is
 * why deleting a "DO NOT USE - " prompt used to be undone by the next deploy:
 * the row came back under the name in the array rather than the retirement
 * prefixed name somebody deliberately gave it. These tests are the
 * specification of what each loop does now:
 *
 *   - a key with a retirement record is SKIPPED, loudly, and nothing is written;
 *   - a key with no record is created exactly as before;
 *   - an EXISTING row is left alone either way — a retirement vetoes creating a
 *     prompt, it does not delete one somebody has since put back;
 *   - the batched lookup is ONE query per run, not one per catalogue entry;
 *   - a retirement that commits DURING the run is caught by the in-transaction
 *     re-check, not by the batched pre-filter (the pre-filter is an
 *     optimization, never the decision);
 *   - a database that predates the retirement table logs a warning and seeds
 *     exactly as it did before, because the ordered seed runner takes every
 *     later entry down with it when one aborts.
 *
 * The Prisma double is a small in-memory database rather than a stub, so "no
 * prompt row was written for that key" is an assertion about the store rather
 * than about which mock happened to be called. Both seed modules export their
 * loop and run themselves only when invoked directly (`isDirectRun`), which is
 * what lets this suite import them at all.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/seed-prompts/retired-key-skipped.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** A key that really is in `seed-prompts-only.ts`'s array. */
const PROMPTS_ONLY_KEY = "feature_placeholder";
/** A key that really is in `seed.ts`'s array. */
const SEED_KEY = "document_generator_default";

type PromptRow = { id: string; key: string; scope: string };
type VersionRow = {
	id: string;
	promptId: string;
	version: number;
	content: string;
};

const h = vi.hoisted(() => {
	const store = {
		prompts: [] as PromptRow[],
		versions: [] as VersionRow[],
		bindings: [] as { id: string; promptVersionId: string }[],
		/** Retirements the batched pre-filter can see. */
		retired: new Set<string>(),
		/** Retirements that appear only to the in-transaction re-check — a
		 *  deletion that committed after the pre-filter ran. */
		retiredMidRun: new Set<string>(),
	};

	const control = {
		/** Set to make the batched lookup fail the way a missing table does. */
		lookupError: undefined as unknown,
		/** False makes the in-transaction `to_regclass` probe report the table
		 *  absent, as it is on a database that predates the migration. */
		tablePresent: true,
	};

	const seen = { locks: 0, batchedLookups: 0 };

	let seq = 0;
	const nextId = () => `row-${++seq}`;

	const client = {
		prompt: {
			findFirst: vi.fn(
				async ({ where }: any) =>
					store.prompts.find(
						(p) => p.key === where.key && p.scope === where.scope,
					) ?? null,
			),
			create: vi.fn(async ({ data }: any) => {
				const row = {
					id: nextId(),
					key: data.key,
					scope: data.scope,
				};
				store.prompts.push(row);
				return row;
			}),
		},
		promptVersion: {
			findFirst: vi.fn(async ({ where }: any) => {
				const rows = store.versions
					.filter((v) => v.promptId === where.promptId)
					.sort((a, b) => b.version - a.version);
				return rows[0] ?? null;
			}),
			create: vi.fn(async ({ data }: any) => {
				const row = {
					id: nextId(),
					promptId: data.promptId,
					version: data.version,
					content: data.content,
				};
				store.versions.push(row);
				return row;
			}),
		},
		promptBinding: {
			findFirst: vi.fn(async () => null),
			findMany: vi.fn(async () => []),
			update: vi.fn(async () => ({})),
			create: vi.fn(async ({ data }: any) => {
				const row = {
					id: nextId(),
					promptVersionId: data.promptVersionId,
				};
				store.bindings.push(row);
				return row;
			}),
		},
		retiredPromptKey: {
			// The batched pre-filter, read through the top-level client.
			findMany: vi.fn(async ({ where }: any = {}) => {
				seen.batchedLookups++;
				if (control.lookupError) {
					throw control.lookupError;
				}
				const keys: string[] | undefined = where?.key?.in;
				return [...store.retired]
					.filter((key) => !keys || keys.includes(key))
					.map((key) => ({ key }));
			}),
			// The decision that binds, read under the per-key lock.
			findUnique: vi.fn(async ({ where }: any) =>
				store.retired.has(where.key) ||
				store.retiredMidRun.has(where.key)
					? { key: where.key }
					: null,
			),
		},
		$executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
			if (strings.join("?").includes("pg_advisory_xact_lock")) {
				seen.locks++;
			}
			return 1;
		}),
		$queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
			if (strings.join("?").includes("to_regclass")) {
				return [{ present: control.tablePresent }];
			}
			return [];
		}),
	};

	const db = {
		...client,
		$transaction: vi.fn(async (fn: (c: unknown) => unknown) => fn(client)),
	};

	const logger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		success: vi.fn(),
	};

	return { store, control, seen, client, db, logger };
});

vi.mock("../../prisma/client", () => ({ db: h.db, Prisma: {} }));
vi.mock("@repo/logs", () => ({ logger: h.logger }));

import { seedSystemPrompts as seedFullCatalogue } from "../../prisma/seed";
import { seedSystemPrompts as seedPromptsOnly } from "../../prisma/seed-prompts-only";

/** Prisma's own "the table does not exist in the current database". */
const missingTable = Object.assign(
	new Error("The table `public.retired_prompt_key` does not exist"),
	{ code: "P2021" },
);

const rowsFor = (key: string) => h.store.prompts.filter((p) => p.key === key);

const warnedAbout = (key: string) =>
	h.logger.warn.mock.calls.some((call) => String(call[0]).includes(key));

beforeEach(() => {
	h.store.prompts = [];
	h.store.versions = [];
	h.store.bindings = [];
	h.store.retired = new Set();
	h.store.retiredMidRun = new Set();
	h.control.lookupError = undefined;
	h.control.tablePresent = true;
	h.seen.locks = 0;
	h.seen.batchedLookups = 0;
	vi.clearAllMocks();
});

// Both loops are the same shape and must hold the same properties, so they are
// specified together rather than in two suites that can drift apart. A third
// seed creating SYSTEM prompts would be caught by
// `system-prompt-creation-guarded.test.ts`, which reads the source rather than
// running it.
const SEEDS = [
	{
		name: "seed-prompts-only.ts",
		key: PROMPTS_ONLY_KEY,
		run: seedPromptsOnly,
	},
	{ name: "seed.ts", key: SEED_KEY, run: seedFullCatalogue },
] as const;

describe.each(SEEDS)("$name — a key recorded as retired", ({ key, run }) => {
	it("is skipped, and no prompt row is written for it", async () => {
		h.store.retired.add(key);

		await run();

		expect(rowsFor(key)).toHaveLength(0);
		expect(
			h.client.prompt.create.mock.calls.some(
				(call) => call[0]?.data?.key === key,
			),
		).toBe(false);
		// The operator running the seed has to be able to see why.
		expect(warnedAbout(key)).toBe(true);
	});

	it("does not stop the rest of the catalogue from seeding", async () => {
		h.store.retired.add(key);

		await run();

		expect(h.store.prompts.length).toBeGreaterThan(1);
		expect(h.store.versions.length).toBe(h.store.prompts.length);
	});

	it("is created as before when nothing is recorded", async () => {
		await run();

		expect(rowsFor(key)).toHaveLength(1);
		expect(warnedAbout(key)).toBe(false);
	});

	// The guard gates the INSERT and nothing else. A row somebody put back
	// deliberately is not deleted by a stale record, and no second row is
	// created beside it.
	it("leaves an existing row alone whether or not a record exists", async () => {
		h.store.prompts.push({ id: "existing", key, scope: "SYSTEM" });
		h.store.versions.push({
			id: "existing-v1",
			promptId: "existing",
			version: 1,
			content: "whatever an administrator edited it to",
		});
		h.store.retired.add(key);

		await run();

		expect(rowsFor(key)).toHaveLength(1);
		expect(rowsFor(key)[0].id).toBe("existing");
	});

	// A per-entry lookup would turn one round trip into dozens on every deploy.
	it("asks for the whole catalogue's retirements in one query", async () => {
		await run();

		expect(h.seen.batchedLookups).toBe(1);
	});

	// The pre-filter saw nothing; the deletion committed while the loop was
	// running. Only the in-transaction re-check can catch that, which is the
	// whole reason the check and the insert share a transaction.
	it("is refused by the in-transaction re-check when the record lands mid-run", async () => {
		h.store.retiredMidRun.add(key);

		await run();

		expect(rowsFor(key)).toHaveLength(0);
		expect(warnedAbout(key)).toBe(true);
		// The lock is what makes that re-check meaningful — it is taken for
		// every guarded insert, including the ones that go on to succeed.
		expect(h.seen.locks).toBeGreaterThan(0);
	});

	// The ordered seed runner aborts every later entry when one fails, so a
	// database that predates the migration must degrade rather than throw.
	it("warns and seeds exactly as before when the table does not exist yet", async () => {
		h.control.lookupError = missingTable;
		h.control.tablePresent = false;

		await expect(run()).resolves.toBeUndefined();

		expect(rowsFor(key)).toHaveLength(1);
		expect(h.store.prompts.length).toBeGreaterThan(1);
		expect(
			h.logger.warn.mock.calls.some((call) =>
				String(call[0]).includes("retired_prompt_key is missing"),
			),
		).toBe(true);
	});
});

// The insert-only contract belongs to `seed-prompts-only.ts` alone —
// `seed.ts`'s older loop still version-cascades a changed body, which this
// change deliberately does not touch. Asserted here so the retirement guard
// cannot be read as having relaxed it.
describe("seed-prompts-only.ts — the insert-only contract still holds", () => {
	it("does not add a version to an existing prompt, retired or not", async () => {
		h.store.prompts.push({
			id: "existing",
			key: PROMPTS_ONLY_KEY,
			scope: "SYSTEM",
		});
		h.store.versions.push({
			id: "existing-v1",
			promptId: "existing",
			version: 1,
			content: "whatever an administrator edited it to",
		});
		h.store.retired.add(PROMPTS_ONLY_KEY);

		await seedPromptsOnly();

		expect(
			h.store.versions.filter((v) => v.promptId === "existing"),
		).toHaveLength(1);
		expect(h.store.versions[0].content).toBe(
			"whatever an administrator edited it to",
		);
	});
});
