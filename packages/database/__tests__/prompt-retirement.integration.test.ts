/**
 * Real-Postgres proofs for SYSTEM prompt deletion and its retirement record
 * (Fizzy #2328 — R8, R9, R11, R14, R15).
 *
 * Four properties here are the SQL, not the TypeScript, so a mocked client
 * cannot say anything about them:
 *
 *   - the per-key advisory lock. Whether two concurrent deletions of the same
 *     prompt really serialize — one winner, one "already deleted", ONE record —
 *     depends on `pg_advisory_xact_lock`, not on a `vi.fn()` resolving twice;
 *   - the fork's parent reference. It survives with `forkedFromId` NULL because
 *     the foreign key is SET NULL. A double reproduces whatever its author
 *     believed the FK does, which is exactly the belief under test;
 *   - `retiredBy` carrying NO foreign key to `user`. Offboarding the
 *     administrator who retired a prompt must not delete the retirement and let
 *     the next catalogue seed resurrect it. Every other user reference in this
 *     schema is ON DELETE CASCADE, so this is a property of the DDL;
 *   - a binding written while the deletion transaction is in flight. Whether it
 *     lands before or after is the database's decision; what must hold either
 *     way is that nothing is removed without appearing in the reported figures.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/prompt-retirement.integration.test.ts
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import {
	createPrompt,
	deletePrompt,
	getPromptByKey,
	getRetiredPromptKeys,
} from "../prisma/queries/prompts";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN = `${Date.now()}-${process.pid}`;
const ORG = `pr-org-${RUN}`;
const ADMIN = `pr-admin-${RUN}`;

/** Every prompt key this suite retires, so `afterEach` can clear the records
 *  it wrote without touching a real retirement. */
const KEYS: string[] = [];
/** Every prompt row id created, so cleanup never deletes by pattern. */
const PROMPTS: string[] = [];

let seq = 0;
const nextId = (label: string) => `pr-${label}-${RUN}-${++seq}`;

async function insertUser(id: string): Promise<void> {
	const now = new Date();
	await db.$executeRaw(Prisma.sql`
		INSERT INTO "user" (id, name, email, "emailVerified", role,
			"onboardingComplete", "createdAt", "updatedAt")
		VALUES (${id}, ${id}, ${`${id}@example.com`}, true, 'admin',
			true, ${now}, ${now})`);
}

async function insertOrganization(id: string): Promise<void> {
	await db.$executeRaw(Prisma.sql`
		INSERT INTO "organization" (id, name, slug, "createdAt")
		VALUES (${id}, ${id}, ${id}, ${new Date()})`);
}

/** One prompt row plus two versions, so a binding can sit on the older one. */
async function insertPrompt(args: {
	key: string;
	scope: "SYSTEM" | "ORG" | "USER";
	organizationId?: string | null;
	forkedFromId?: string | null;
}): Promise<{ id: string; versionIds: [string, string] }> {
	const id = nextId("prompt");
	const now = new Date();
	const scope = Prisma.raw(`'${args.scope}'::"PromptScope"`);

	await db.$executeRaw(Prisma.sql`
		INSERT INTO "prompt" (id, key, name, scope, "organizationId",
			"forkedFromId", "createdBy", "createdAt", "updatedAt")
		VALUES (${id}, ${args.key}, ${`Prompt ${id}`}, ${scope},
			${args.organizationId ?? null}, ${args.forkedFromId ?? null},
			${ADMIN}, ${now}, ${now})`);

	PROMPTS.push(id);
	if (!KEYS.includes(args.key)) {
		KEYS.push(args.key);
	}

	const versionIds: string[] = [];
	for (const version of [1, 2]) {
		const versionId = `${id}-v${version}`;
		await db.$executeRaw(Prisma.sql`
			INSERT INTO "prompt_version" (id, "promptId", version, content,
				scope, "organizationId", "createdBy", "createdAt")
			VALUES (${versionId}, ${id}, ${version}, ${`body ${version}`},
				${scope}, ${args.organizationId ?? null}, ${ADMIN}, ${now})`);
		versionIds.push(versionId);
	}

	return { id, versionIds: [versionIds[0], versionIds[1]] };
}

async function insertBinding(args: {
	promptVersionId: string;
	organizationId?: string | null;
	userId?: string | null;
}): Promise<string> {
	const id = nextId("binding");
	const now = new Date();
	const scope = args.organizationId ? "ORG" : args.userId ? "USER" : "SYSTEM";

	await db.$executeRaw(Prisma.sql`
		INSERT INTO "prompt_binding" (id, "targetType", "targetKey",
			"documentType", scope, "userId", "organizationId",
			"promptVersionId", "isDefault", "createdAt", "updatedAt")
		VALUES (${id}, 'AGENT'::"PromptTargetType", ${id}, 'PRD',
			${Prisma.raw(`'${scope}'::"PromptScope"`)},
			${args.userId ?? null}, ${args.organizationId ?? null},
			${args.promptVersionId}, true, ${now}, ${now})`);

	return id;
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"system prompt deletion and retirement (real Postgres)",
	() => {
		afterEach(async () => {
			await db.retiredPromptKey.deleteMany({
				where: { key: { in: KEYS } },
			});
		});

		afterAll(async () => {
			await db.prompt.deleteMany({ where: { id: { in: PROMPTS } } });
			await db.organization.deleteMany({ where: { id: ORG } });
			await db.user.deleteMany({ where: { id: ADMIN } });
		});

		// The lock is the reason a creation cannot interleave with a deletion.
		// If it were absent, both transactions would re-read the row before
		// either deleted it, both would report success, and both would write a
		// retirement — the second failing on the unique key or, worse, quietly
		// telling two operators they each removed the prompt.
		it("lets exactly one of two concurrent deletions win, and records the key once", async () => {
			await insertUser(ADMIN).catch(() => undefined);
			const key = `pr_race_${RUN}`;
			const prompt = await insertPrompt({ key, scope: "SYSTEM" });
			await insertBinding({ promptVersionId: prompt.versionIds[0] });

			const results = await Promise.allSettled([
				deletePrompt({ id: prompt.id, deletedBy: ADMIN }),
				deletePrompt({ id: prompt.id, deletedBy: ADMIN }),
			]);

			const fulfilled = results.filter((r) => r.status === "fulfilled");
			const rejected = results.filter((r) => r.status === "rejected");

			expect(fulfilled).toHaveLength(1);
			expect(rejected).toHaveLength(1);
			// Already deleted, not an internal error (R11).
			expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject(
				{ code: "P2025" },
			);

			const records = await db.retiredPromptKey.findMany({
				where: { key },
			});
			expect(records).toHaveLength(1);
			expect(records[0].retiredBy).toBe(ADMIN);
			expect(await getPromptByKey({ key })).toBeNull();
		});

		// AE15, against the index that makes it possible: the unique constraint
		// spans two NULLable owner columns, and Postgres treats NULLs as
		// distinct — so two SYSTEM rows really can carry one key here.
		it("removes every SYSTEM row carrying the key and writes one record", async () => {
			const key = `pr_duplicate_${RUN}`;
			const selected = await insertPrompt({ key, scope: "SYSTEM" });
			const duplicate = await insertPrompt({ key, scope: "SYSTEM" });
			await insertBinding({
				promptVersionId: duplicate.versionIds[0],
				organizationId: ORG,
			}).catch(async () => {
				await insertOrganization(ORG);
				return insertBinding({
					promptVersionId: duplicate.versionIds[0],
					organizationId: ORG,
				});
			});

			const result = await deletePrompt({
				id: selected.id,
				deletedBy: ADMIN,
			});

			expect(result.promptRowCount).toBe(2);
			expect(result.bindingCount).toBe(1);
			expect(result.organizationCount).toBe(1);
			expect(
				await db.prompt.findMany({
					where: { id: { in: [selected.id, duplicate.id] } },
				}),
			).toHaveLength(0);
			expect(
				await db.retiredPromptKey.findMany({ where: { key } }),
			).toHaveLength(1);
			expect(await getPromptByKey({ key })).toBeNull();
			expect([...(await getRetiredPromptKeys([key]))]).toEqual([key]);
		});

		// AE7. The fork relationship is SET NULL, which is Prisma's default for
		// an optional relation — a comment in a later migration claims it is
		// restrict and is wrong. If it were CASCADE instead, retiring a platform
		// prompt would silently delete every organization's adaptation of it.
		it("leaves an organization's fork standing, with a null parent reference", async () => {
			await insertOrganization(ORG).catch(() => undefined);
			const key = `pr_forked_${RUN}`;
			const parent = await insertPrompt({ key, scope: "SYSTEM" });
			// A fork is created under a rewritten key, so it can never collide
			// with the retired one.
			const fork = await insertPrompt({
				key: `${key}_org`,
				scope: "ORG",
				organizationId: ORG,
				forkedFromId: parent.id,
			});
			const forkBinding = await insertBinding({
				promptVersionId: fork.versionIds[0],
				organizationId: ORG,
			});

			const result = await deletePrompt({
				id: parent.id,
				deletedBy: ADMIN,
			});

			expect(result.promptRowCount).toBe(1);

			const survivor = await db.prompt.findUnique({
				where: { id: fork.id },
			});
			expect(survivor).not.toBeNull();
			expect(survivor?.forkedFromId).toBeNull();
			expect(survivor?.organizationId).toBe(ORG);
			// Nothing belonging to that organization was removed.
			expect(
				await db.promptBinding.findUnique({
					where: { id: forkBinding },
				}),
			).not.toBeNull();
			expect(
				await db.promptVersion.findMany({
					where: { promptId: fork.id },
				}),
			).toHaveLength(2);
		});

		// AE17. Where the concurrent insert lands is the database's decision.
		// The invariant that must hold either way: every binding the deletion
		// removed appears in the figures it reports. A count taken before the
		// delete would break this the moment the insert won the race.
		it("never removes a binding written mid-transaction without reporting it", async () => {
			await insertOrganization(ORG).catch(() => undefined);
			const key = `pr_inflight_${RUN}`;
			const prompt = await insertPrompt({ key, scope: "SYSTEM" });
			await insertBinding({ promptVersionId: prompt.versionIds[0] });

			const [deletion, insertion] = await Promise.allSettled([
				deletePrompt({ id: prompt.id, deletedBy: ADMIN }),
				insertBinding({
					promptVersionId: prompt.versionIds[1],
					organizationId: ORG,
				}),
			]);

			expect(deletion.status).toBe("fulfilled");
			const reported = (
				deletion as PromiseFulfilledResult<{ bindingCount: number }>
			).value.bindingCount;

			// The insert either committed before the version delete (so the
			// deletion removed two) or failed on the vanished foreign key (so it
			// removed one). Nothing else is possible, and both are reported.
			expect(reported).toBe(insertion.status === "fulfilled" ? 2 : 1);
			expect(
				await db.promptBinding.count({
					where: { promptVersion: { promptId: prompt.id } },
				}),
			).toBe(0);
		});

		// The load-bearing half of the schema decision: `retiredBy` is a plain
		// String. Were it a relation, it would inherit this schema's prevailing
		// ON DELETE CASCADE, and offboarding the administrator who retired a
		// prompt would delete the retirement — after which the next catalogue
		// seed brings the prompt back with nobody having asked for it.
		it("keeps the record when the administrator who wrote it is deleted", async () => {
			const actor = nextId("offboarded");
			await insertUser(actor);
			const key = `pr_offboarded_${RUN}`;
			const prompt = await insertPrompt({ key, scope: "SYSTEM" });

			await deletePrompt({ id: prompt.id, deletedBy: actor });
			await db.user.deleteMany({ where: { id: actor } });

			const records = await db.retiredPromptKey.findMany({
				where: { key },
			});
			expect(records).toHaveLength(1);
			expect(records[0].retiredBy).toBe(actor);
		});

		it("writes no record for an organization's own prompt", async () => {
			await insertOrganization(ORG).catch(() => undefined);
			const key = `pr_org_only_${RUN}`;
			const prompt = await insertPrompt({
				key,
				scope: "ORG",
				organizationId: ORG,
			});

			const result = await deletePrompt({
				id: prompt.id,
				deletedBy: ADMIN,
			});

			expect(result.retirementRecorded).toBe(false);
			expect(
				await db.retiredPromptKey.findMany({ where: { key } }),
			).toEqual([]);
			expect(await getRetiredPromptKeys([key])).toEqual(new Set());
		});

		// AE14, and the other half of the lock. Everything above proves a
		// deletion cannot be interleaved by a second DELETION; these two prove
		// it cannot be interleaved by a CREATION, which is what a catalogue
		// seed and the create endpoint both are. Neither can be shown with a
		// double: what serializes the two transactions is
		// `pg_advisory_xact_lock`, and what makes the creation's decision
		// current is that its read happens inside the transaction the lock
		// belongs to.
		it("refuses a creation whose caller read the retirement state before it was written", async () => {
			await insertUser(ADMIN).catch(() => undefined);
			const key = `pr_stale_read_${RUN}`;
			const prompt = await insertPrompt({ key, scope: "SYSTEM" });

			// The caller's read: at this moment the key really is not retired,
			// and every decision it makes from here is made on this answer.
			expect(await getRetiredPromptKeys([key])).toEqual(new Set());

			await deletePrompt({ id: prompt.id, deletedBy: ADMIN });

			// The insert, made on that now-stale decision.
			await expect(
				createPrompt({
					key,
					name: `Prompt ${key}`,
					scope: "SYSTEM",
					createdBy: ADMIN,
					initialContent: "body",
				}),
			).rejects.toMatchObject({ code: "PROMPT_KEY_RETIRED" });

			expect(await getPromptByKey({ key })).toBeNull();
			expect(
				await db.prompt.findMany({ where: { key, scope: "SYSTEM" } }),
			).toHaveLength(0);
		});

		it("leaves no prompt behind when a creation and a deletion race for the key", async () => {
			await insertUser(ADMIN).catch(() => undefined);
			const key = `pr_create_race_${RUN}`;
			const prompt = await insertPrompt({ key, scope: "SYSTEM" });

			const [deletion, creation] = await Promise.allSettled([
				deletePrompt({ id: prompt.id, deletedBy: ADMIN }),
				createPrompt({
					key,
					name: `Prompt ${key}`,
					scope: "SYSTEM",
					createdBy: ADMIN,
					initialContent: "body",
				}),
			]);

			// Whichever transaction the lock granted first, the outcome is the
			// same one: the key is retired and nothing answers it. If the
			// creation won, its row was inside the deletion's key-scoped sweep;
			// if the deletion won, the creation re-read under the lock and
			// refused.
			if (creation.status === "fulfilled") {
				PROMPTS.push(creation.value.id);
			} else {
				expect(creation.reason).toMatchObject({
					code: "PROMPT_KEY_RETIRED",
				});
			}

			expect(deletion.status).toBe("fulfilled");
			expect(await getPromptByKey({ key })).toBeNull();
			expect([...(await getRetiredPromptKeys([key]))]).toEqual([key]);
		});

		// The guard is about the platform's catalogue key, not about the word.
		// An organization creating its own prompt under a name the platform has
		// retired is not undoing anything, and refusing it would make one
		// tenant's deletion a veto over everybody else's naming.
		it("still lets an organization create its own prompt under a retired key", async () => {
			await insertOrganization(ORG).catch(() => undefined);
			await insertUser(ADMIN).catch(() => undefined);
			const key = `pr_org_after_retire_${RUN}`;
			const platform = await insertPrompt({ key, scope: "SYSTEM" });

			await deletePrompt({ id: platform.id, deletedBy: ADMIN });

			const own = await createPrompt({
				key,
				name: `Our own ${key}`,
				scope: "ORG",
				organizationId: ORG,
				createdBy: ADMIN,
				initialContent: "body",
			});
			PROMPTS.push(own.id);

			expect(own.organizationId).toBe(ORG);
			expect(own.scope).toBe("ORG");
			// The platform row stays gone; only the organization's own remains.
			expect(
				await db.prompt.findMany({ where: { key, scope: "SYSTEM" } }),
			).toHaveLength(0);
		});
	},
);
