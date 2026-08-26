/**
 * Behaviour of the project role-confirmation query layer against a REAL
 * Postgres (Fizzy #2264, spec §5.2 / §5.4 / §5.7 / §5.8).
 *
 * The mocked writer tests in
 * `prisma/queries/projects/__tests__/function-tags-writers.test.ts` pin the
 * PAYLOADS these functions compose. They cannot pin what the database then
 * does with them: the `BEFORE UPDATE` trigger that corrects a forgetful
 * writer, the row lock that decides who reads a committed value, the unique
 * index that refuses a second create, and the RLS policy that decides who can
 * see the row at all. Every case below needs a server.
 *
 * Self-skips unless a REACHABLE Postgres is configured; `hasReachableDatabaseUrl()`
 * rejects both an unset DATABASE_URL and the CI placeholder the unit-tests
 * workflow exports. Runs for real in `db-integration.yml` (path-filtered on
 * packages/database/**) and locally with:
 *   DATABASE_URL=<real> corepack pnpm --filter @repo/database test \
 *     __tests__/project-user-function-tag-confirmation.test.ts
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, type FunctionTag } from "../prisma/client";
import {
	applyGlobalDefaultFunctionTags,
	confirmProjectUserFunctionTags,
	getMyProjectFunctionTagStatus,
	upsertProjectUserFunctionTags,
} from "../prisma/queries/projects/function-tags";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";
import { asRlsRole, ensureRlsTestRole } from "./_helpers/rls-role";

const RUN_ID = process.env.VITEST_WORKER_ID ?? "0";
const OWNER_ID = `test-tag-confirm-owner-${RUN_ID}`;
const MEMBER_ID = `test-tag-confirm-member-${RUN_ID}`;
const ORG_A_ID = `test-tag-confirm-org-a-${RUN_ID}`;
const ORG_B_ID = `test-tag-confirm-org-b-${RUN_ID}`;

/**
 * Poll until `done(probe())`, or fail loudly. Copied in shape from
 * `publishing-reconcile-contention.test.ts:243` — the same problem: a case
 * that merely sequences two statements proves nothing about contention, and a
 * fixed sleep is a race with a nicer name.
 */
async function until<T>(
	label: string,
	probe: () => Promise<T> | T,
	done: (value: T) => boolean,
	budgetMs = 10_000,
): Promise<T> {
	const deadline = Date.now() + budgetMs;
	let last = await probe();
	while (!done(last) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		last = await probe();
	}
	if (!done(last)) {
		throw new Error(
			`Timed out waiting for ${label}; last saw ${String(last)}`,
		);
	}
	return last;
}

/**
 * Backends parked on a ROW lock, read from a THIRD connection.
 *
 * `wait_event = 'transactionid'` and not merely `wait_event_type = 'Lock'`: a
 * backend waiting on a relation lock behind a DDL statement is also a Lock
 * wait. Same probe as `publishing-reconcile-contention.test.ts:272`.
 *
 * DELIBERATELY UNSCOPED, and the direction of the resulting error matters. It
 * counts ANY backend in this database parked on a row lock, so a parallel
 * worker blocked on something unrelated could satisfy the barrier early. That
 * can only ever release the barrier BEFORE the admin path has parked, which
 * makes the interleaving case pass when it should have failed — a false GREEN
 * under the no-lock mutation, never a false red. So if this case ever goes red
 * in CI, it is reporting a real regression: do not chase it as flake.
 * (Postgres exposes no per-relation view of who is waiting on whom without
 * joining `pg_locks` to itself on the blocking transaction, which is a great
 * deal of machinery for a barrier whose failure mode is one-directional.)
 */
async function backendsWaitingOnRowLocks(): Promise<number> {
	const [{ n }] = (await db.$queryRawUnsafe(
		`SELECT count(*)::int AS n
		   FROM pg_stat_activity
		  WHERE "datname" = current_database()
		    AND "state" = 'active'
		    AND "wait_event_type" = 'Lock'
		    AND "wait_event" = 'transactionid'
		    AND "pid" <> pg_backend_pid()`,
	)) as Array<{ n: number }>;
	return n;
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"project role confirmation query layer (real Postgres)",
	() => {
		/** Personal project (organizationId null), created by OWNER_ID. */
		let projectId: string;
		/** Organization-owned project, used only by the RLS case. */
		let orgProjectId: string;

		beforeAll(async () => {
			await ensureRlsTestRole();

			const now = new Date();
			for (const [id, name] of [
				[OWNER_ID, "Tag Confirmation Owner"],
				[MEMBER_ID, "Tag Confirmation Member"],
			] as const) {
				await db.user.upsert({
					where: { id },
					update: {},
					create: {
						id,
						name,
						email: `${id}@example.com`,
						emailVerified: true,
						createdAt: now,
						updatedAt: now,
					},
				});
			}

			for (const [id, slug] of [
				[ORG_A_ID, `tag-confirm-org-a-${RUN_ID}`],
				[ORG_B_ID, `tag-confirm-org-b-${RUN_ID}`],
			] as const) {
				await db.organization.upsert({
					where: { id },
					update: {},
					create: { id, name: id, slug, createdAt: now },
				});
			}

			const project = await db.project.create({
				data: { name: "Tag Confirmation Project", userId: OWNER_ID },
			});
			projectId = project.id;

			const orgProject = await db.project.create({
				data: {
					name: "Tag Confirmation Org Project",
					userId: OWNER_ID,
					organizationId: ORG_A_ID,
				},
			});
			orgProjectId = orgProject.id;
		});

		afterAll(async () => {
			await db.projectUserFunctionTag.deleteMany({
				where: { userId: { in: [OWNER_ID, MEMBER_ID] } },
			});
			await db.project.deleteMany({ where: { userId: OWNER_ID } });
			await db.organization.deleteMany({
				where: { id: { in: [ORG_A_ID, ORG_B_ID] } },
			});
			await db.user.deleteMany({
				where: { id: { in: [OWNER_ID, MEMBER_ID] } },
			});
		});

		/**
		 * Seed the row at a KNOWN (tags, confirmedAt, confirmationVersion=0).
		 *
		 * An INSERT, deliberately: the version trigger is BEFORE UPDATE only,
		 * so a seed that set `confirmedAt` with an UPDATE would land the row at
		 * version 1 and every "version is now 1" assertion below would be
		 * satisfied by the seed rather than by the code under test.
		 */
		async function freshRow(opts: {
			tags: FunctionTag[];
			confirmedAt: Date | null;
			projectId?: string;
			organizationId?: string | null;
		}) {
			const target = opts.projectId ?? projectId;
			await db.projectUserFunctionTag.deleteMany({
				where: { projectId: target, userId: MEMBER_ID },
			});
			return db.projectUserFunctionTag.create({
				data: {
					projectId: target,
					userId: MEMBER_ID,
					organizationId: opts.organizationId ?? null,
					tags: opts.tags,
					confirmedAt: opts.confirmedAt,
				},
			});
		}

		function readRow(target = projectId) {
			return db.projectUserFunctionTag.findUnique({
				where: {
					projectId_userId: { projectId: target, userId: MEMBER_ID },
				},
			});
		}

		async function setMemberDefault(tags: FunctionTag[]) {
			await db.user.update({
				where: { id: MEMBER_ID },
				data: { defaultFunctionTags: tags },
			});
		}

		it("a confirmation sets confirmedAt, and a CHANGING admin save clears it", async () => {
			await freshRow({ tags: ["DEVELOPER"], confirmedAt: null });

			const confirmed = await confirmProjectUserFunctionTags({
				projectId,
				userId: MEMBER_ID,
				organizationId: null,
				tags: ["DEVELOPER"],
				expectedVersion: 0,
			});
			expect(confirmed).toMatchObject({
				outcome: "confirmed",
				version: 1,
				previousTags: ["DEVELOPER"],
			});

			const afterConfirm = await readRow();
			expect(afterConfirm?.confirmedAt).not.toBeNull();
			expect(afterConfirm?.confirmationVersion).toBe(1);

			await upsertProjectUserFunctionTags({
				projectId,
				userId: MEMBER_ID,
				organizationId: null,
				tags: ["ARCHITECT"],
			});

			const afterAdmin = await readRow();
			expect(afterAdmin?.tags).toEqual(["ARCHITECT"]);
			expect(afterAdmin?.confirmedAt).toBeNull();
			expect(afterAdmin?.confirmationVersion).toBe(2);
		});

		it("a NO-OP admin save (same set, reordered, duplicated) leaves confirmedAt AND the version untouched", async () => {
			const seeded = await freshRow({
				tags: ["DEVELOPER", "SME"],
				confirmedAt: new Date(),
			});

			await upsertProjectUserFunctionTags({
				projectId,
				userId: MEMBER_ID,
				organizationId: null,
				tags: ["SME", "DEVELOPER", "DEVELOPER"],
			});

			const after = await readRow();
			// The version matters as much as confirmedAt: a write of identical
			// values would leave confirmedAt alone but still burn the CAS
			// token, turning an open prompt into a spurious conflict.
			expect(after?.confirmationVersion).toBe(0);
			expect(after?.confirmedAt).toEqual(seeded.confirmedAt);
			expect(after?.tags).toEqual(["DEVELOPER", "SME"]);
		});

		it("clearing all tags clears confirmedAt — the same rule, not a special case", async () => {
			await freshRow({ tags: ["DEVELOPER"], confirmedAt: new Date() });

			await upsertProjectUserFunctionTags({
				projectId,
				userId: MEMBER_ID,
				organizationId: null,
				tags: [],
			});

			const after = await readRow();
			expect(after?.tags).toEqual([]);
			expect(after?.confirmedAt).toBeNull();
			expect(after?.confirmationVersion).toBe(1);
		});

		it("the admin path CREATES a first row unconfirmed, at version 0", async () => {
			// No test anywhere else has the admin path create a row from
			// nothing — every other case seeds one first. That left the
			// `create` branch of the upsert entirely unpinned against the
			// database: adding `confirmedAt: new Date()` to it marks a member
			// as having already confirmed tags they have never seen, and
			// because `confirmedAt` is set they are never prompted. Nothing
			// corrects it either — the trigger is BEFORE UPDATE only, so an
			// INSERT carries whatever the writer put in it.
			await db.projectUserFunctionTag.deleteMany({
				where: { projectId, userId: MEMBER_ID },
			});

			const result = await upsertProjectUserFunctionTags({
				projectId,
				userId: MEMBER_ID,
				organizationId: null,
				tags: ["DEVELOPER"],
			});
			expect(result).toEqual({ changed: true });

			const created = await readRow();
			expect(created?.tags).toEqual(["DEVELOPER"]);
			expect(created?.confirmedAt).toBeNull();
			expect(created?.confirmationVersion).toBe(0);
		});

		it("an organizationId-only re-home still clears confirmedAt — the one shape the trigger cannot cover for us", async () => {
			// EVERY other real-Postgres case here is blind to a writer that
			// forgot `confirmedAt: null`, because the trigger's invariant 1
			// clears it whenever `tags` MOVE and the writer did not. That is
			// the trigger doing its job, but it means those cases cannot tell
			// the application rule from the database's correction.
			//
			// This is the shape where they diverge: the tag SET is unchanged,
			// so invariant 1 does not fire and nothing corrects a forgetful
			// writer — the confirmation would survive a re-home. Deleting
			// `confirmedAt: null` from the admin path reddens THIS case and no
			// other in this file.
			await freshRow({
				tags: ["DEVELOPER"],
				confirmedAt: new Date(),
				projectId: orgProjectId,
				organizationId: null,
			});

			await upsertProjectUserFunctionTags({
				projectId: orgProjectId,
				userId: MEMBER_ID,
				organizationId: ORG_A_ID,
				tags: ["DEVELOPER"],
			});

			const after = await readRow(orgProjectId);
			expect(after?.organizationId).toBe(ORG_A_ID);
			expect(after?.tags).toEqual(["DEVELOPER"]);
			expect(after?.confirmedAt).toBeNull();
			expect(after?.confirmationVersion).toBe(1);
		});

		it("applyGlobalDefaultFunctionTags clears confirmedAt on the HAS-DEFAULTS branch", async () => {
			await setMemberDefault(["SME"]);
			await freshRow({ tags: ["DEVELOPER"], confirmedAt: new Date() });

			await db.$transaction((tx) =>
				applyGlobalDefaultFunctionTags(tx, {
					projectId,
					userId: MEMBER_ID,
				}),
			);

			const after = await readRow();
			expect(after?.tags).toEqual(["SME"]);
			expect(after?.confirmedAt).toBeNull();
			expect(after?.confirmationVersion).toBe(1);
		});

		it("applyGlobalDefaultFunctionTags clears confirmedAt on the EMPTY-DEFAULTS branch", async () => {
			// The branch a "there is one upsert" reading misses. Asserted
			// apart from the has-defaults case above precisely so a partial
			// fix that routes only the upsert through the choke point fails
			// HERE and nowhere else.
			await setMemberDefault([]);
			await freshRow({ tags: ["DEVELOPER"], confirmedAt: new Date() });

			await db.$transaction((tx) =>
				applyGlobalDefaultFunctionTags(tx, {
					projectId,
					userId: MEMBER_ID,
				}),
			);

			const after = await readRow();
			expect(after?.tags).toEqual([]);
			expect(after?.confirmedAt).toBeNull();
			expect(after?.confirmationVersion).toBe(1);
		});

		it("a matching expectedVersion writes and increments; a STALE one writes nothing and leaves the admin's tags in place", async () => {
			await freshRow({ tags: ["DEVELOPER"], confirmedAt: null });

			const first = await confirmProjectUserFunctionTags({
				projectId,
				userId: MEMBER_ID,
				organizationId: null,
				tags: ["DEVELOPER"],
				expectedVersion: 0,
			});
			expect(first.outcome).toBe("confirmed");

			// The admin moves the row while a second prompt is still holding
			// version 1.
			await upsertProjectUserFunctionTags({
				projectId,
				userId: MEMBER_ID,
				organizationId: null,
				tags: ["ARCHITECT"],
			});

			const stale = await confirmProjectUserFunctionTags({
				projectId,
				userId: MEMBER_ID,
				organizationId: null,
				tags: ["DEVELOPER"],
				expectedVersion: 1,
			});

			expect(stale).toEqual({ outcome: "conflict" });
			const after = await readRow();
			// The admin's assignment survives, unconfirmed.
			expect(after?.tags).toEqual(["ARCHITECT"]);
			expect(after?.confirmedAt).toBeNull();
			expect(after?.confirmationVersion).toBe(2);
		});

		it("two concurrent confirmations from the SAME expectedVersion: exactly one wins", async () => {
			await freshRow({ tags: ["DEVELOPER"], confirmedAt: null });

			const results = await Promise.all([
				confirmProjectUserFunctionTags({
					projectId,
					userId: MEMBER_ID,
					organizationId: null,
					tags: ["DEVELOPER"],
					expectedVersion: 0,
				}),
				confirmProjectUserFunctionTags({
					projectId,
					userId: MEMBER_ID,
					organizationId: null,
					tags: ["ARCHITECT"],
					expectedVersion: 0,
				}),
			]);

			const outcomes = results.map((r) => r.outcome).sort();
			expect(outcomes).toEqual(["confirmed", "conflict"]);
			const after = await readRow();
			// One increment, not two: the loser wrote nothing at all.
			expect(after?.confirmationVersion).toBe(1);
			expect(after?.confirmedAt).not.toBeNull();
		});

		it("expectedVersion null against a row that NOW exists is a conflict, and the row is untouched", async () => {
			const seeded = await freshRow({
				tags: ["DEVELOPER"],
				confirmedAt: null,
			});

			const result = await confirmProjectUserFunctionTags({
				projectId,
				userId: MEMBER_ID,
				organizationId: null,
				tags: ["SME"],
				expectedVersion: null,
			});

			expect(result).toEqual({ outcome: "conflict" });
			const after = await readRow();
			// Not a silent overwrite: the row that appeared in the prompt's
			// window keeps every column it had.
			expect(after?.id).toBe(seeded.id);
			expect(after?.tags).toEqual(["DEVELOPER"]);
			expect(after?.confirmedAt).toBeNull();
			expect(after?.confirmationVersion).toBe(0);
		});

		it("two concurrent expectedVersion-null confirmations: exactly one wins, refused by the unique index", async () => {
			// A DIFFERENT mechanism from the row-lock race below: there is no
			// row to lock, so `SELECT … FOR UPDATE` would protect nothing and
			// the (projectId, userId) unique index is the whole guarantee.
			await db.projectUserFunctionTag.deleteMany({
				where: { projectId, userId: MEMBER_ID },
			});

			const results = await Promise.all([
				confirmProjectUserFunctionTags({
					projectId,
					userId: MEMBER_ID,
					organizationId: null,
					tags: ["DEVELOPER"],
					expectedVersion: null,
				}),
				confirmProjectUserFunctionTags({
					projectId,
					userId: MEMBER_ID,
					organizationId: null,
					tags: ["ARCHITECT"],
					expectedVersion: null,
				}),
			]);

			expect(results.map((r) => r.outcome).sort()).toEqual([
				"confirmed",
				"conflict",
			]);
			const rows = await db.projectUserFunctionTag.findMany({
				where: { projectId, userId: MEMBER_ID },
			});
			expect(rows).toHaveLength(1);
			expect(rows[0].confirmedAt).not.toBeNull();
			expect(rows[0].confirmationVersion).toBe(0);
		});

		it("the admin path holds a row lock a second session cannot take", async () => {
			// Two real connections. Session A opens a transaction and takes
			// the same lock `upsertProjectUserFunctionTags` takes. Session B
			// then asks for it with a short `lock_timeout`, so the outcome is
			// a deterministic error rather than a race:
			//   lock held  -> 55P03 lock_not_available
			//   no lock    -> the statement returns immediately
			// This test reads whether a lock on this row BLOCKS. It is NOT
			// the negative control for deleting `FOR UPDATE` from the
			// production path — the unit test
			// ("takes the row lock BEFORE reading") is what pins that the
			// production path issues it.
			//
			// Raw `pg` (already a direct dependency of @repo/database), NOT a
			// second PrismaClient: `prisma/client.ts` constructs the client
			// WITH a PrismaPg driver adapter and does not export the class, so
			// `new PrismaClient()` has no datasource and will not construct.
			// `pg` also surfaces the SQLSTATE directly, which matters below.
			await freshRow({ tags: ["DEVELOPER"], confirmedAt: null });

			const other = new Client({
				connectionString: process.env.DATABASE_URL,
			});
			await other.connect();
			try {
				let releaseA: () => void = () => {};
				const aDone = new Promise<void>((r) => {
					releaseA = r;
				});
				let signalHeld: () => void = () => {};
				const aHoldsLock = new Promise<void>((r) => {
					signalHeld = r;
				});
				// CAPTURED, not floated: the transaction must be awaited
				// before this test returns, or it outlives the case.
				const aInFlight = db.$transaction(
					async (tx) => {
						await tx.$queryRaw`SELECT id FROM "project_user_function_tag" WHERE "projectId" = ${projectId} AND "userId" = ${MEMBER_ID} FOR UPDATE`;
						signalHeld(); // the lock is HELD from here
						await aDone; // …until this resolves
					},
					{ timeout: 60_000, maxWait: 60_000 },
				);
				await aHoldsLock;

				// Assert the SQLSTATE, never a regex. `/timeout/i` would also
				// match Prisma's own interactive-transaction expiry (P2028,
				// "The timeout for this transaction was 5000 ms") — so a run
				// in which session A never took the lock and session B merely
				// outlived its window would PASS. A false pass on the one test
				// rewritten for determinism.
				const blocked = await lockAttempt(other, projectId, MEMBER_ID);
				expect(blocked?.code).toBe("55P03");

				// POSITIVE CONTROL, in the test rather than in a one-off run:
				// the SAME statement with the SAME lock_timeout against a key
				// that has NO row returns immediately. `SELECT … FOR UPDATE`
				// locks nothing when the row does not exist, so without this a
				// green 55P03 could not be told from a lock_timeout that fires
				// on everything.
				const unblocked = await lockAttempt(
					other,
					projectId,
					`${MEMBER_ID}-absent`,
				);
				expect(unblocked).toBeNull();

				releaseA();
				await aInFlight;
			} finally {
				await other.end();
			}
		});

		it("an admin NO-OP racing a member confirmation cannot destroy the confirmation", async () => {
			// The falsifiable form of the interleaving. NOT "the final triple
			// is self-consistent": every writer here sets `tags` and
			// `confirmedAt` in the SAME statement, so the last committed
			// writer always sets both and that assertion is green with the
			// lock deleted, with the transaction deleted, and with the whole
			// function rewritten as a bare upsert.
			//
			//   seed        tags=[DEVELOPER], confirmedAt=null, v=0
			//   session X   takes the row lock and HOLDS it
			//   admin       upsert([ARCHITECT]) — parks
			//   session X   commits a member confirmation of [ARCHITECT]
			//   admin       unparks
			//
			// WITH the lock the admin parks BEFORE its read, then reads the
			// committed [ARCHITECT], classifies its own save as a no-op and
			// skips — the confirmation survives. WITHOUT it the admin's plain
			// SELECT does not block at all (MVCC readers never do), so it has
			// already read the stale [DEVELOPER] and parks one statement later
			// on the upsert; when it unparks it writes confirmedAt: null.
			await freshRow({ tags: ["DEVELOPER"], confirmedAt: null });

			const holder = new Client({
				connectionString: process.env.DATABASE_URL,
			});
			await holder.connect();
			try {
				await holder.query("BEGIN");
				await holder.query(
					'SELECT id FROM "project_user_function_tag" WHERE "projectId" = $1 AND "userId" = $2 FOR UPDATE',
					[projectId, MEMBER_ID],
				);

				const admin = upsertProjectUserFunctionTags({
					projectId,
					userId: MEMBER_ID,
					organizationId: null,
					tags: ["ARCHITECT"],
				});

				// The admin is REALLY parked, observed from a third
				// connection, not assumed after a sleep. This probe fires in
				// BOTH configurations — with `FOR UPDATE` the admin parks at
				// the lock, without it one statement later at the upsert — so
				// the barrier is not itself what makes the case pass.
				const blocked = await until(
					"the admin path to park on the row lock",
					backendsWaitingOnRowLocks,
					(n) => n > 0,
				);
				expect(blocked).toBeGreaterThan(0);

				// The member's half, staged as raw SQL on the connection that
				// HOLDS the barrier: `confirmProjectUserFunctionTags` opens
				// its own `db` transaction and would park on this very lock.
				// The statement mirrors the payload the unit tests pin —
				// tags, confirmedAt and the version advance together.
				const confirmedAt = new Date();
				const written = await holder.query(
					`UPDATE "project_user_function_tag"
					    SET "tags" = ARRAY['ARCHITECT']::"FunctionTag"[],
					        "confirmedAt" = $1,
					        "updatedAt" = $1,
					        "confirmationVersion" = "confirmationVersion" + 1
					  WHERE "projectId" = $2 AND "userId" = $3
					    AND "confirmationVersion" = 0`,
					[confirmedAt, projectId, MEMBER_ID],
				);
				expect(written.rowCount).toBe(1);
				await holder.query("COMMIT");

				await admin;

				const after = await readRow();
				// THE assertion: a PRESERVED confirmation, not a consistent
				// pair.
				expect(after?.confirmedAt).not.toBeNull();
				expect(after?.tags).toEqual(["ARCHITECT"]);
				// And the admin wrote nothing, so the CAS token did not move
				// past the member's own confirmation.
				expect(after?.confirmationVersion).toBe(1);
			} finally {
				await holder.end();
			}
		});

		it("getMyProjectFunctionTagStatus reports version null and confirmed false when NO row exists", async () => {
			await setMemberDefault(["SME"]);
			await db.projectUserFunctionTag.deleteMany({
				where: { projectId, userId: MEMBER_ID },
			});

			const status = await getMyProjectFunctionTagStatus(
				projectId,
				MEMBER_ID,
			);

			expect(status).toEqual({
				confirmed: false,
				tags: [],
				defaultTags: ["SME"],
				// `null`, NOT 0 — 0 is a real version an existing untouched
				// row holds, and the confirm path branches on the difference.
				version: null,
			});
		});

		it("getMyProjectFunctionTagStatus reports a REAL 0 for an untouched row", async () => {
			await setMemberDefault(["SME"]);
			await freshRow({ tags: ["DEVELOPER"], confirmedAt: null });

			const status = await getMyProjectFunctionTagStatus(
				projectId,
				MEMBER_ID,
			);

			expect(status).toEqual({
				confirmed: false,
				tags: ["DEVELOPER"],
				defaultTags: ["SME"],
				version: 0,
			});
		});

		it("an org-owned row is invisible under ANOTHER organization's RLS context", async () => {
			// The two new columns change nothing about tenant isolation —
			// policies are per-table, not per-column — so this case's job is
			// to prove that rather than to assume it. Read through the
			// NOBYPASSRLS `fabric_rls_test` role; the base `db` client
			// connects as a BYPASSRLS role, so the same assertions written
			// against `db` would pass with the policy dropped.
			const row = await freshRow({
				tags: ["DEVELOPER"],
				confirmedAt: new Date(),
				projectId: orgProjectId,
				organizationId: ORG_A_ID,
			});

			const fromOtherOrg = await asRlsRole(
				{ type: "organization", tenantId: ORG_B_ID },
				(tx) =>
					tx.projectUserFunctionTag.findMany({
						where: { id: row.id },
					}),
			);
			expect(fromOtherOrg).toEqual([]);

			// POSITIVE CONTROL: the same read from the owning org's context
			// finds it, with both new columns intact. Without this, "invisible"
			// is indistinguishable from "the row was never written".
			const fromOwnOrg = await asRlsRole(
				{ type: "organization", tenantId: ORG_A_ID },
				(tx) =>
					tx.projectUserFunctionTag.findMany({
						where: { id: row.id },
					}),
			);
			expect(fromOwnOrg).toHaveLength(1);
			expect(fromOwnOrg[0].confirmedAt).not.toBeNull();
			expect(fromOwnOrg[0].confirmationVersion).toBe(0);
		});
	},
);

/**
 * One `SELECT … FOR UPDATE` attempt under a short `lock_timeout`, in its own
 * transaction so a failed attempt leaves the connection usable.
 * Returns the error when the lock was refused, `null` when it was granted.
 */
async function lockAttempt(
	client: Client,
	targetProjectId: string,
	targetUserId: string,
): Promise<{ code?: string } | null> {
	await client.query("BEGIN");
	await client.query("SET LOCAL lock_timeout = '250ms'");
	const error = await client
		.query(
			'SELECT id FROM "project_user_function_tag" WHERE "projectId" = $1 AND "userId" = $2 FOR UPDATE',
			[targetProjectId, targetUserId],
		)
		.then(() => null)
		.catch((e) => e as { code?: string });
	await client.query("ROLLBACK");
	return error;
}
