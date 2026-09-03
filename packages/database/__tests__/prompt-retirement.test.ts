/**
 * Deleting a prompt, and recording the retirement that keeps it deleted
 * (Fizzy #2328 — R9, R11, R14, R15, KTD4, KTD5).
 *
 * Two seed scripts recreate a missing SYSTEM prompt from its key. So a deletion
 * that removes the row but not the key's retirement record is not a deletion at
 * all — it is a prompt that comes back under the name in the seed array rather
 * than the retirement-prefixed name somebody deliberately gave it. These tests
 * are the specification of the four properties that make the deletion stick:
 *
 *   - a SYSTEM deletion records the KEY, once, whatever number of rows carry it;
 *   - the record and the rows commit together or not at all;
 *   - a deletion of something already gone says so, rather than reporting a
 *     cheerful success (the multi-row path removes zero rows SILENTLY, which is
 *     the whole reason the in-transaction recheck exists);
 *   - the figures reported are what the deletion removed, not what a pre-flight
 *     snapshot predicted — a binding written in between is IN them, and ALL
 *     FOUR of them describe that same set of rows: a straggler swept up after
 *     the first delete brings its organization, its person and its document
 *     type with it, not just a +1 on the total;
 *   - a SYSTEM deletion that cannot record its retirement is refused rather
 *     than performed, because rows removed without a record are precisely the
 *     resurrectable prompt the record exists to prevent.
 *
 * The Prisma double below is a small in-memory database rather than a stub: it
 * cascades a version delete into its bindings, and its `$transaction` rolls the
 * store back when the callback throws. That is what lets "the prompt is still
 * there after the record write failed" be an assertion rather than a hope. Its
 * transaction client is a SEPARATE object from the top-level one, so "every
 * write happened inside the transaction" is checkable directly.
 *
 * The two things a double cannot prove — that the advisory lock really
 * serializes two racing deletions, and that a fork's parent reference really
 * goes null rather than cascading — live in
 * `prompt-retirement.integration.test.ts`, against a real Postgres.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/prompt-retirement.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type PromptRow = {
	id: string;
	key: string;
	scope: string;
	organizationId: string | null;
	userId: string | null;
	forkedFromId: string | null;
};
type VersionRow = { id: string; promptId: string; version: number };
type BindingRow = {
	id: string;
	promptVersionId: string;
	documentType: string;
	organizationId: string | null;
	userId: string | null;
};
type RetirementRow = { key: string; retiredBy: string; retiredAt: Date };

const h = vi.hoisted(() => {
	type Store = {
		prompts: PromptRow[];
		versions: VersionRow[];
		bindings: BindingRow[];
		retirements: RetirementRow[];
	};

	const store: Store = {
		prompts: [],
		versions: [],
		bindings: [],
		retirements: [],
	};

	const hooks: {
		/** Fires immediately after the binding DELETE, so a test can simulate a
		 *  row committed by another session between the delete and the check. */
		afterBindingDelete?: () => void;
		/** Fires when the retirement record is written, so a test can make it
		 *  fail the way a constraint or a dead connection would. */
		onRetirementWrite?: () => void;
	} = {};

	const control = {
		/** False makes the `to_regclass` probe report `retired_prompt_key`
		 *  absent, as it is on a database that predates the migration. */
		retirementTablePresent: true,
	};

	const seen: {
		executeRaw: string[];
		queryRaw: string[];
		transactionOptions: unknown;
	} = { executeRaw: [], queryRaw: [], transactionOptions: undefined };

	const versionsOf = (promptIds: string[]) =>
		store.versions.filter((v) => promptIds.includes(v.promptId));

	const bindingsOf = (promptIds: string[]) =>
		store.bindings.filter((b) => {
			const version = store.versions.find(
				(v) => v.id === b.promptVersionId,
			);
			return !!version && promptIds.includes(version.promptId);
		});

	function makeClient() {
		return {
			prompt: {
				findUnique: vi.fn(
					async ({ where }: any) =>
						store.prompts.find((p) => p.id === where.id) ?? null,
				),
				findFirst: vi.fn(async ({ where }: any) => {
					const row = store.prompts.find(
						(p) =>
							p.key === where.key &&
							p.scope === where.scope &&
							(where.organizationId === undefined ||
								p.organizationId === where.organizationId) &&
							(where.userId === undefined ||
								p.userId === where.userId),
					);
					if (!row) {
						return null;
					}
					return {
						...row,
						versions: store.versions
							.filter((v) => v.promptId === row.id)
							.sort((a, b) => b.version - a.version)
							.slice(0, 1),
					};
				}),
				findMany: vi.fn(async ({ where }: any) =>
					store.prompts
						.filter(
							(p) =>
								p.key === where.key && p.scope === where.scope,
						)
						.map((p) => ({ id: p.id })),
				),
				deleteMany: vi.fn(async ({ where }: any) => {
					const ids: string[] = where.id.in;
					const before = store.prompts.length;
					store.prompts = store.prompts.filter(
						(p) => !ids.includes(p.id),
					);
					return { count: before - store.prompts.length };
				}),
			},
			promptVersion: {
				deleteMany: vi.fn(async ({ where }: any) => {
					const ids: string[] = where.promptId.in;
					const going = versionsOf(ids);
					const goingIds = new Set(going.map((v) => v.id));
					store.versions = store.versions.filter(
						(v) => !goingIds.has(v.id),
					);
					// The FK is ON DELETE CASCADE: a binding on a removed
					// version disappears with it, whether or not anybody counted
					// it first. That is the failure mode the straggler check
					// exists for, so the double has to reproduce it.
					store.bindings = store.bindings.filter(
						(b) => !goingIds.has(b.promptVersionId),
					);
					return { count: going.length };
				}),
			},
			promptBinding: {
				count: vi.fn(
					async ({ where }: any) =>
						bindingsOf(where.promptVersion.promptId.in).length,
				),
				findMany: vi.fn(async ({ where }: any) =>
					bindingsOf(where.promptVersion.promptId.in).map((b) => ({
						documentType: b.documentType,
						organizationId: b.organizationId,
						userId: b.userId,
					})),
				),
			},
			retiredPromptKey: {
				upsert: vi.fn(async ({ where, create, update }: any) => {
					hooks.onRetirementWrite?.();
					const existing = store.retirements.find(
						(r) => r.key === where.key,
					);
					if (existing) {
						Object.assign(existing, update);
						return existing;
					}
					const row: RetirementRow = {
						key: create.key,
						retiredBy: create.retiredBy,
						retiredAt: new Date(),
					};
					store.retirements.push(row);
					return row;
				}),
				findMany: vi.fn(async ({ where }: any = {}) => {
					const keys: string[] | undefined = where?.key?.in;
					return store.retirements
						.filter((r) => !keys || keys.includes(r.key))
						.map((r) => ({ key: r.key }));
				}),
			},
			$executeRaw: vi.fn(
				async (
					strings: TemplateStringsArray,
					..._values: unknown[]
				) => {
					seen.executeRaw.push(strings.join("?"));
					return 1;
				},
			),
			$queryRaw: vi.fn(
				async (strings: TemplateStringsArray, ...values: unknown[]) => {
					const sql = strings.join("?");
					seen.queryRaw.push(sql);
					// The retirement table's existence probe. A database
					// that predates the migration answers "absent", and a
					// SYSTEM deletion must then refuse rather than remove
					// rows whose retirement it cannot record.
					if (sql.includes("to_regclass")) {
						return [{ present: control.retirementTablePresent }];
					}
					if (!sql.includes('DELETE FROM "prompt_binding"')) {
						return [];
					}
					const join = values.find(
						(v) =>
							!!v &&
							typeof v === "object" &&
							"__join" in (v as any),
					) as { __join: string[] };
					const going = bindingsOf(join.__join);
					const goingIds = new Set(going.map((b) => b.id));
					store.bindings = store.bindings.filter(
						(b) => !goingIds.has(b.id),
					);
					hooks.afterBindingDelete?.();
					return going.map((b) => ({
						documentType: b.documentType,
						organizationId: b.organizationId,
						userId: b.userId,
					}));
				},
			),
		};
	}

	const tx = makeClient();
	const db = {
		...makeClient(),
		$transaction: vi.fn(
			async (fn: (c: unknown) => unknown, options: unknown) => {
				seen.transactionOptions = options;
				// A real transaction rolls back on a throw. Without that here,
				// "the record write failed and the prompt survived" would be
				// unassertable, which is the one property the record exists for.
				const snapshot = JSON.parse(JSON.stringify(store));
				try {
					return await fn(tx);
				} catch (error) {
					store.prompts = snapshot.prompts;
					store.versions = snapshot.versions;
					store.bindings = snapshot.bindings;
					store.retirements = snapshot.retirements.map((r: any) => ({
						...r,
						retiredAt: new Date(r.retiredAt),
					}));
					throw error;
				}
			},
		),
	};

	class PrismaClientKnownRequestError extends Error {
		code: string;
		constructor(message: string, options: { code: string }) {
			super(message);
			this.code = options.code;
		}
	}

	const Prisma = {
		join: (values: string[]) => ({ __join: values }),
		PrismaClientKnownRequestError,
	};

	const warn = vi.fn();

	return { store, hooks, control, seen, tx, db, Prisma, warn, makeClient };
});

vi.mock("../prisma/client", () => ({ db: h.db, Prisma: h.Prisma }));
vi.mock("@repo/logs", () => ({ logger: { warn: h.warn, error: vi.fn() } }));

import {
	deletePrompt,
	getPlatformWidePromptDeletionImpact,
	getPromptByKey,
	getRetiredPromptKeys,
	PromptRetirementUnavailableError,
} from "../prisma/queries/prompts";

const ADMIN = "user-operator";

function seedPrompt(over: Partial<PromptRow> & { id: string; key: string }) {
	const row: PromptRow = {
		scope: "SYSTEM",
		organizationId: null,
		userId: null,
		forkedFromId: null,
		...over,
	};
	h.store.prompts.push(row);
	h.store.versions.push(
		{ id: `${row.id}-v1`, promptId: row.id, version: 1 },
		{ id: `${row.id}-v2`, promptId: row.id, version: 2 },
	);
	return row;
}

let bindingSeq = 0;
function seedBinding(
	over: Partial<BindingRow> & { promptVersionId: string },
): BindingRow {
	const row: BindingRow = {
		id: `b-${++bindingSeq}`,
		documentType: "PRD",
		organizationId: null,
		userId: null,
		...over,
	};
	h.store.bindings.push(row);
	return row;
}

beforeEach(() => {
	h.store.prompts = [];
	h.store.versions = [];
	h.store.bindings = [];
	h.store.retirements = [];
	h.hooks.afterBindingDelete = undefined;
	h.hooks.onRetirementWrite = undefined;
	h.control.retirementTablePresent = true;
	h.seen.executeRaw = [];
	h.seen.queryRaw = [];
	h.seen.transactionOptions = undefined;
	bindingSeq = 0;
	vi.clearAllMocks();
});

describe("deletePrompt — the retirement record", () => {
	it("records the key and the acting user when a SYSTEM prompt is deleted", async () => {
		seedPrompt({ id: "p-sys", key: "prd_writer" });

		const result = await deletePrompt({ id: "p-sys", deletedBy: ADMIN });

		expect(result.retirementRecorded).toBe(true);
		expect(result.promptKey).toBe("prd_writer");
		expect(h.store.retirements).toEqual([
			{
				key: "prd_writer",
				retiredBy: ADMIN,
				retiredAt: expect.any(Date),
			},
		]);
		expect(h.store.prompts).toHaveLength(0);
	});

	it("records nothing when the prompt is an organization's own", async () => {
		seedPrompt({
			id: "p-org",
			key: "prd_writer",
			scope: "ORG",
			organizationId: "org-1",
		});

		const result = await deletePrompt({ id: "p-org", deletedBy: ADMIN });

		expect(result.retirementRecorded).toBe(false);
		expect(result.promptRowCount).toBe(1);
		expect(h.store.retirements).toEqual([]);
		expect(h.tx.retiredPromptKey.upsert).not.toHaveBeenCalled();
	});

	it("records nothing when the prompt is one person's own", async () => {
		seedPrompt({
			id: "p-user",
			key: "prd_writer",
			scope: "USER",
			userId: "user-7",
		});

		const result = await deletePrompt({ id: "p-user", deletedBy: ADMIN });

		expect(result.retirementRecorded).toBe(false);
		expect(h.store.retirements).toEqual([]);
		expect(h.tx.retiredPromptKey.upsert).not.toHaveBeenCalled();
	});

	// A retirement is a KEY-level veto. A key can be retired, re-seeded by an
	// operator restoring it, and retired again — and the second retirement must
	// refresh the record rather than hit the unique index and abort a deletion
	// that had already removed the rows.
	it("refreshes an existing record instead of failing on the unique key", async () => {
		h.store.retirements.push({
			key: "prd_writer",
			retiredBy: "user-someone-else",
			retiredAt: new Date("2020-01-01T00:00:00.000Z"),
		});
		seedPrompt({ id: "p-sys", key: "prd_writer" });

		await expect(
			deletePrompt({ id: "p-sys", deletedBy: ADMIN }),
		).resolves.toMatchObject({ retirementRecorded: true });

		expect(h.store.retirements).toHaveLength(1);
		expect(h.store.retirements[0].retiredBy).toBe(ADMIN);
		expect(h.store.retirements[0].retiredAt.getFullYear()).toBeGreaterThan(
			2020,
		);
		// An upsert, not a create — this is the statement shape the property
		// depends on, so it is asserted rather than inferred from the outcome.
		expect(h.tx.retiredPromptKey.upsert).toHaveBeenCalledWith(
			expect.objectContaining({ where: { key: "prd_writer" } }),
		);
	});

	// The record and the rows are one decision. A record that commits without
	// its deletion vetoes a live prompt; a deletion that commits without its
	// record is silently resurrectable by the next catalogue seed.
	it("leaves the prompt in place when the record cannot be written", async () => {
		seedPrompt({ id: "p-sys", key: "prd_writer" });
		seedBinding({ promptVersionId: "p-sys-v1", organizationId: "org-1" });
		h.hooks.onRetirementWrite = () => {
			throw new Error("retirement write failed");
		};

		await expect(
			deletePrompt({ id: "p-sys", deletedBy: ADMIN }),
		).rejects.toThrow("retirement write failed");

		expect(h.store.prompts.map((p) => p.id)).toEqual(["p-sys"]);
		expect(h.store.bindings).toHaveLength(1);
		expect(h.store.retirements).toEqual([]);
	});

	it("writes every statement through the transaction client, never beside it", async () => {
		seedPrompt({ id: "p-sys", key: "prd_writer" });

		await deletePrompt({ id: "p-sys", deletedBy: ADMIN });

		expect(h.db.$transaction).toHaveBeenCalledTimes(1);
		// An explicit timeout, because the cascade can span every tenant on the
		// platform and the default is not sized for that.
		expect(h.seen.transactionOptions).toEqual(
			expect.objectContaining({ timeout: expect.any(Number) }),
		);
		expect(h.db.prompt.deleteMany).not.toHaveBeenCalled();
		expect(h.db.promptVersion.deleteMany).not.toHaveBeenCalled();
		expect(h.db.retiredPromptKey.upsert).not.toHaveBeenCalled();
		expect(h.db.$queryRaw).not.toHaveBeenCalled();
		expect(h.tx.prompt.deleteMany).toHaveBeenCalled();
		expect(h.tx.retiredPromptKey.upsert).toHaveBeenCalled();
	});
});

describe("deletePrompt — a prompt that has already gone", () => {
	// The multi-row SYSTEM path deletes BY KEY. A `deleteMany` matching nothing
	// removes zero rows and raises nothing, so without a recheck this would
	// report a successful deletion of a prompt somebody else removed a moment
	// earlier — and would write a retirement record for it (R11).
	it("reports P2025 rather than a silent success", async () => {
		await expect(
			deletePrompt({ id: "p-gone", deletedBy: ADMIN }),
		).rejects.toMatchObject({ code: "P2025" });

		expect(h.store.retirements).toEqual([]);
	});

	it("reports P2025 when the row disappears after the lock is taken", async () => {
		seedPrompt({ id: "p-sys", key: "prd_writer" });
		// The row is there for the pre-transaction read that addresses the lock,
		// and gone by the time the transaction re-reads it — exactly the window
		// the recheck exists to close.
		h.tx.prompt.findUnique.mockResolvedValueOnce(null);

		await expect(
			deletePrompt({ id: "p-sys", deletedBy: ADMIN }),
		).rejects.toMatchObject({ code: "P2025" });

		expect(h.tx.prompt.deleteMany).not.toHaveBeenCalled();
		expect(h.store.retirements).toEqual([]);
	});
});

describe("deletePrompt — the advisory lock", () => {
	it("takes the per-key lock before it reads anything inside the transaction", async () => {
		seedPrompt({ id: "p-sys", key: "prd_writer" });

		await deletePrompt({ id: "p-sys", deletedBy: ADMIN });

		expect(h.seen.executeRaw.join("\n")).toContain("pg_advisory_xact_lock");
		expect(h.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
			h.tx.prompt.findUnique.mock.invocationCallOrder[0],
		);
	});
});

describe("deletePrompt — how many rows a key names", () => {
	// AE15. Duplicate SYSTEM keys are legal: the unique index spans two nullable
	// owner columns and Postgres treats NULLs as distinct. Resolution takes the
	// first match, so removing only the selected row leaves a survivor still
	// answering the key while the UI reports success and every seed skips it —
	// a deletion that is reported, recorded and ineffective.
	it("removes every SYSTEM row carrying the key and records it once", async () => {
		seedPrompt({ id: "p-selected", key: "prd_writer" });
		seedPrompt({ id: "p-duplicate", key: "prd_writer" });
		seedBinding({
			promptVersionId: "p-duplicate-v1",
			organizationId: "org-1",
		});

		const result = await deletePrompt({
			id: "p-selected",
			deletedBy: ADMIN,
		});

		expect(result.promptRowCount).toBe(2);
		expect(result.bindingCount).toBe(1);
		expect(h.store.prompts).toHaveLength(0);
		expect(h.store.retirements).toHaveLength(1);
		// And the key resolves to nothing afterwards, through the real
		// resolver rather than by reading the fixture back.
		await expect(getPromptByKey({ key: "prd_writer" })).resolves.toBeNull();
	});

	it("leaves a prompt at another scope that happens to share the key", async () => {
		seedPrompt({ id: "p-sys", key: "prd_writer" });
		const orgTwin = seedPrompt({
			id: "p-org",
			key: "prd_writer",
			scope: "ORG",
			organizationId: "org-1",
		});
		const userTwin = seedPrompt({
			id: "p-user",
			key: "prd_writer",
			scope: "USER",
			userId: "user-7",
		});
		const orgBinding = seedBinding({
			promptVersionId: "p-org-v1",
			organizationId: "org-1",
		});

		const result = await deletePrompt({ id: "p-sys", deletedBy: ADMIN });

		expect(result.promptRowCount).toBe(1);
		expect(result.bindingCount).toBe(0);
		expect(h.store.prompts).toEqual([orgTwin, userTwin]);
		expect(h.store.bindings).toEqual([orgBinding]);
	});

	// AE7. A fork is a prompt in its own right — the parent reference is
	// SET NULL, not CASCADE — so an organization that adapted a platform prompt
	// keeps its own copy when the platform retires the original.
	it("does not touch an organization's fork of the deleted prompt", async () => {
		seedPrompt({ id: "p-sys", key: "prd_writer" });
		const fork = seedPrompt({
			id: "p-fork",
			key: "prd_writer_org_1",
			scope: "ORG",
			organizationId: "org-1",
			forkedFromId: "p-sys",
		});
		const forkBinding = seedBinding({
			promptVersionId: "p-fork-v1",
			organizationId: "org-1",
		});

		const result = await deletePrompt({ id: "p-sys", deletedBy: ADMIN });

		expect(result.promptRowCount).toBe(1);
		expect(h.store.prompts).toEqual([fork]);
		expect(h.store.bindings).toEqual([forkBinding]);
		// Whether the reference actually goes NULL rather than cascading is a
		// property of the foreign key, so it is asserted against a real
		// database in `prompt-retirement.integration.test.ts`.
	});
});

describe("deletePrompt — the figures it reports", () => {
	it("separates affected organizations from personal overrides, and names neither", async () => {
		seedPrompt({ id: "p-sys", key: "prd_writer" });
		seedBinding({ promptVersionId: "p-sys-v2", organizationId: "org-1" });
		seedBinding({ promptVersionId: "p-sys-v2", organizationId: "org-2" });
		seedBinding({
			promptVersionId: "p-sys-v1",
			userId: "user-1",
			documentType: "ADR",
		});
		// The platform's own SYSTEM-tier binding: no organization and no user.
		// It counts in the total and is nobody's personal override.
		seedBinding({ promptVersionId: "p-sys-v1" });

		const result = await deletePrompt({ id: "p-sys", deletedBy: ADMIN });

		expect(result).toMatchObject({
			promptRowCount: 1,
			bindingCount: 4,
			organizationCount: 2,
			personalOverrideUserCount: 1,
			documentTypeLabels: ["Architecture Decision Record", "PRD"],
		});

		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("org-1");
		expect(serialized).not.toContain("org-2");
		expect(serialized).not.toContain("user-1");
	});

	// AE16. The dialog's figures are a snapshot taken before a human decision.
	// The completion report has to be an account of what happened instead, or
	// a binding written during that window is removed and never mentioned.
	it("counts a binding written after the pre-flight impact was read", async () => {
		seedPrompt({ id: "p-sys", key: "prd_writer" });
		seedBinding({ promptVersionId: "p-sys-v1", organizationId: "org-1" });

		const snapshot = await getPlatformWidePromptDeletionImpact({
			promptId: "p-sys",
		});
		expect(snapshot?.bindingCount).toBe(1);

		// Somebody in another tenant sets a default while the operator reads
		// the confirmation.
		seedBinding({ promptVersionId: "p-sys-v2", organizationId: "org-2" });

		const result = await deletePrompt({ id: "p-sys", deletedBy: ADMIN });

		expect(result.bindingCount).toBe(2);
		expect(result.organizationCount).toBe(2);
		expect(result.bindingCount).not.toBe(snapshot?.bindingCount);
	});

	// AE17. A row committed after the explicit binding delete would be
	// cascaded away by the version delete. Counting only what RETURNING saw
	// would remove it and never say so.
	//
	// And COUNTING it is not enough either: the straggler's organization and
	// document type are asserted here because a bare count of the second batch
	// raises `bindingCount` alone, leaving the other three figures describing
	// the first batch — a report that contradicts itself about one deletion.
	it("includes a straggler the cascade would otherwise remove unreported", async () => {
		seedPrompt({ id: "p-sys", key: "prd_writer" });
		seedBinding({ promptVersionId: "p-sys-v1", organizationId: "org-1" });
		h.hooks.afterBindingDelete = () => {
			h.hooks.afterBindingDelete = undefined;
			seedBinding({
				promptVersionId: "p-sys-v2",
				organizationId: "org-3",
				documentType: "ADR",
			});
		};

		const result = await deletePrompt({ id: "p-sys", deletedBy: ADMIN });

		expect(result).toMatchObject({
			bindingCount: 2,
			organizationCount: 2,
			documentTypeLabels: ["Architecture Decision Record", "PRD"],
		});
		expect(h.store.bindings).toHaveLength(0);
	});

	// The reviewer's trace, exactly: a SYSTEM prompt with NO bindings when the
	// transaction opens, so the first delete returns nothing and the tally is
	// empty. Another session commits an organization's default; the straggler
	// sweep removes it. "Removed 1 binding, affecting 0 organizations" is the
	// report a count produces here — for a deletion that has just taken an
	// organization's default away.
	it("describes a straggler that is the only binding there was", async () => {
		seedPrompt({ id: "p-sys", key: "prd_writer" });
		h.hooks.afterBindingDelete = () => {
			h.hooks.afterBindingDelete = undefined;
			seedBinding({
				promptVersionId: "p-sys-v2",
				organizationId: "org-9",
			});
		};

		const result = await deletePrompt({ id: "p-sys", deletedBy: ADMIN });

		expect(result).toMatchObject({
			bindingCount: 1,
			organizationCount: 1,
			personalOverrideUserCount: 0,
			documentTypeLabels: ["PRD"],
		});
	});

	// Same hazard on the other figure. A person's own override is the one a
	// completion message is most likely to be read about — "0 people holding
	// personal overrides" while somebody's override was removed is a false
	// statement about the person reading it.
	it("counts a person whose override arrived as a straggler", async () => {
		seedPrompt({ id: "p-sys", key: "prd_writer" });
		h.hooks.afterBindingDelete = () => {
			h.hooks.afterBindingDelete = undefined;
			seedBinding({
				promptVersionId: "p-sys-v2",
				userId: "user-42",
				documentType: "ADR",
			});
		};

		const result = await deletePrompt({ id: "p-sys", deletedBy: ADMIN });

		expect(result).toMatchObject({
			bindingCount: 1,
			organizationCount: 0,
			personalOverrideUserCount: 1,
			documentTypeLabels: ["Architecture Decision Record"],
		});
		// Counted, never named.
		expect(JSON.stringify(result)).not.toContain("user-42");
	});
});

describe("deletePrompt — the window a straggler comes through", () => {
	// Inserting a prompt_binding takes FOR KEY SHARE on the prompt_version row
	// its foreign key names, and FOR KEY SHARE conflicts with FOR UPDATE. So
	// locking the versions first is what stops another session COMMITTING a
	// binding against a version this transaction is about to delete — a row
	// the version delete would then cascade away with nothing left to report
	// it. The mechanism is the SQL, so the SQL is what is asserted.
	it("locks the versions before it deletes any binding", async () => {
		seedPrompt({ id: "p-sys", key: "prd_writer" });

		await deletePrompt({ id: "p-sys", deletedBy: ADMIN });

		const lock = h.seen.queryRaw.findIndex(
			(sql) =>
				sql.includes('FROM "prompt_version"') &&
				sql.includes("FOR UPDATE"),
		);
		const firstDelete = h.seen.queryRaw.findIndex((sql) =>
			sql.includes('DELETE FROM "prompt_binding"'),
		);

		expect(lock).toBeGreaterThanOrEqual(0);
		expect(firstDelete).toBeGreaterThanOrEqual(0);
		expect(lock).toBeLessThan(firstDelete);
	});

	// The straggler sweep has to be a DELETE ... RETURNING for the figures to
	// hold together: a count has no documentType, no organizationId and no
	// userId to tally.
	it("sweeps with a second delete that returns rows, never a count", async () => {
		seedPrompt({ id: "p-sys", key: "prd_writer" });

		await deletePrompt({ id: "p-sys", deletedBy: ADMIN });

		expect(
			h.seen.queryRaw.filter((sql) =>
				sql.includes('DELETE FROM "prompt_binding"'),
			),
		).toHaveLength(2);
		expect(h.tx.promptBinding.count).not.toHaveBeenCalled();
	});
});

describe("deletePrompt — a database that cannot record the retirement", () => {
	// The read paths degrade to "nothing is retired" when the table is absent,
	// and that is right for them. A deletion cannot: removing the rows without
	// the record produces exactly the state the record exists to prevent, a
	// prompt the next catalogue seed puts back under its seed name.
	//
	// Refused through a PROBE, not a try/catch — querying a missing relation
	// aborts the transaction, so a catch block would hold something that can no
	// longer write.
	it("refuses a SYSTEM deletion, with a code, and removes nothing", async () => {
		h.control.retirementTablePresent = false;
		seedPrompt({ id: "p-sys", key: "prd_writer" });
		seedBinding({ promptVersionId: "p-sys-v1", organizationId: "org-1" });

		const error = await deletePrompt({
			id: "p-sys",
			deletedBy: ADMIN,
		}).catch((e) => e);

		expect(error).toBeInstanceOf(PromptRetirementUnavailableError);
		// The procedure duck-types on the code, exactly as it does for P2025,
		// so the code is part of the contract rather than an internal detail.
		expect(error).toMatchObject({
			code: "PROMPT_RETIREMENT_UNAVAILABLE",
			promptKey: "prd_writer",
		});
		expect(h.store.prompts.map((p) => p.id)).toEqual(["p-sys"]);
		expect(h.store.bindings).toHaveLength(1);
		// Refused BEFORE the cascade rather than rolled back after it: the
		// transaction never touches a row it cannot see through.
		expect(h.tx.prompt.deleteMany).not.toHaveBeenCalled();
		expect(h.tx.promptVersion.deleteMany).not.toHaveBeenCalled();
	});

	// A retirement is a statement about the platform's own catalogue key. A
	// tenant's prompt writes no record, so it has nothing to be unable to
	// write, and the missing table must not block it.
	it("still deletes an organization's own prompt", async () => {
		h.control.retirementTablePresent = false;
		seedPrompt({
			id: "p-org",
			key: "prd_writer",
			scope: "ORG",
			organizationId: "org-1",
		});

		await expect(
			deletePrompt({ id: "p-org", deletedBy: ADMIN }),
		).resolves.toMatchObject({
			promptRowCount: 1,
			retirementRecorded: false,
		});
		expect(h.store.prompts).toEqual([]);
	});
});

describe("getRetiredPromptKeys", () => {
	beforeEach(() => {
		h.store.retirements.push(
			{ key: "prd_writer", retiredBy: ADMIN, retiredAt: new Date() },
			{ key: "adr_writer", retiredBy: ADMIN, retiredAt: new Date() },
		);
	});

	// Both seeds walk arrays of dozens of entries. One query for the whole set
	// is the difference between one round trip per deploy and dozens.
	it("answers for a whole batch of keys in one query", async () => {
		const retired = await getRetiredPromptKeys([
			"prd_writer",
			"story_drafter",
			"adr_writer",
		]);

		expect([...retired].sort()).toEqual(["adr_writer", "prd_writer"]);
		expect(h.db.retiredPromptKey.findMany).toHaveBeenCalledTimes(1);
	});

	it("asks nothing at all for an empty batch", async () => {
		expect(await getRetiredPromptKeys([])).toEqual(new Set());
		expect(h.db.retiredPromptKey.findMany).not.toHaveBeenCalled();
	});

	// The ordered seed runner takes every later entry down when one fails, so a
	// database that predates the migration must degrade to "nothing is retired"
	// — the behaviour before this change — rather than abort the catalogue.
	it("warns and reports nothing retired when the table does not exist yet", async () => {
		h.db.retiredPromptKey.findMany.mockRejectedValueOnce(
			Object.assign(new Error("table does not exist"), { code: "P2021" }),
		);

		expect(await getRetiredPromptKeys(["prd_writer"])).toEqual(new Set());
		expect(h.warn).toHaveBeenCalledTimes(1);
		expect(h.warn.mock.calls[0][0]).toContain("retired_prompt_key");
	});

	it("still throws for a failure that is not a missing table", async () => {
		h.db.retiredPromptKey.findMany.mockRejectedValueOnce(
			Object.assign(new Error("connection refused"), { code: "P1001" }),
		);

		await expect(getRetiredPromptKeys(["prd_writer"])).rejects.toThrow(
			"connection refused",
		);
		expect(h.warn).not.toHaveBeenCalled();
	});
});
