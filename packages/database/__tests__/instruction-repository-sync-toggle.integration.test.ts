/**
 * Real-Postgres tests for a Coding Instructions configure that leaves what is
 * synced alone (Fizzy #2744): the "Automatic sync" toggle and "Re-enable"
 * call `upsertInstructionRepositorySync` with the stored repository, branch
 * and folder, and that must keep the configuration's generation.
 *
 * The contract is the SQL and the fences that read the row, so a mocked
 * client cannot hold it: the configuration row lock and its clock, the
 * publish fence (`repositorySyncPublishRefusal`), the completion's
 * `(syncId, generation)` fence, `begin`'s receipt generation, the poll's
 * lease fence, and the completion's permission read for a stale
 * PERMISSION_REVOKED pause.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 *
 * Run with:
 *   pnpm --filter @repo/database exec dotenv -c -e ../../.env.local -- vitest run __tests__/instruction-repository-sync-toggle.integration.test.ts
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import {
	canCreateProjectInstructions,
	completeInstructionRepositorySyncRun,
	db,
	insertInstructionRepositorySyncRun,
	instructionSyncLeaseHeld,
	repositorySyncPublishRefusal,
	upsertInstructionRepositorySync,
	writeBackInstructionSync,
} from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `sync-toggle-org-${RUN_ID}`;
/** Owns the organization, so holds INSTRUCTION_CREATE on its projects. */
const OWNER_ID = `sync-toggle-owner-${RUN_ID}`;
/** No membership at all, so holds nothing on the project. */
const OUTSIDER_ID = `sync-toggle-outsider-${RUN_ID}`;
const REPO = `sync-toggle-${RUN_ID}`;
const SHA = (c: string) => c.repeat(40);

let projectId = "";
let integrationId = "";
let otherIntegrationId = "";
let runNumber = 0;

/** The stored configuration the toggle and "Re-enable" send back. */
function stored(extra: Record<string, unknown> = {}) {
	return {
		projectId,
		organizationId: ORGANIZATION_ID,
		userId: OWNER_ID,
		repositoryIntegrationId: integrationId,
		ref: "main",
		rootPath: ".claude",
		...extra,
	};
}

async function syncRow() {
	return db.projectInstructionRepositorySync.findFirstOrThrow({
		where: { projectId, organizationId: ORGANIZATION_ID },
	});
}

async function dbClock(): Promise<Date> {
	const [row] = await db.$queryRaw<{ now: Date }[]>`
		SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS "now"`;
	if (!row) {
		throw new Error("no clock row");
	}
	return row.now;
}

/** `begin`'s receipt for a POLL run acting as `userId`, at `generation`. */
async function beginRun(
	syncId: string,
	generation: number,
	userId: string = OWNER_ID,
) {
	runNumber += 1;
	const id = `${syncId}:run-${runNumber}`;
	const inserted = await insertInstructionRepositorySyncRun({
		id,
		syncId,
		projectId,
		organizationId: ORGANIZATION_ID,
		userId,
		generation,
		trigger: "POLL",
		startedAt: new Date(),
	});
	return { id, ...inserted };
}

/** The publish fence a snapshot frozen at `generation` meets. */
async function publishRefusal(syncId: string, generation: number) {
	return db.$transaction(async (tx) => {
		const project = await tx.project.findUniqueOrThrow({
			where: { id: projectId },
			select: { instructionSettings: true },
		});
		return repositorySyncPublishRefusal(tx, {
			projectId,
			organizationId: ORGANIZATION_ID,
			settingsFrozen: { syncId, syncGeneration: generation },
			instructionSettings: project.instructionSettings,
			actingUserId: OWNER_ID,
		});
	});
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"upsertInstructionRepositorySync: the automatic toggle keeps the generation (Fizzy #2744)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			for (const id of [OWNER_ID, OUTSIDER_ID]) {
				await db.user.create({
					data: {
						id,
						name: "Dev Example",
						email: `${id}@example.com`,
						emailVerified: true,
						createdAt: now,
						updatedAt: now,
					},
				});
			}
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Sync Toggle Integration",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			await db.member.create({
				data: {
					organizationId: ORGANIZATION_ID,
					userId: OWNER_ID,
					role: "owner",
					createdAt: now,
				},
			});
			const project = await db.project.create({
				data: {
					name: "Sync Toggle Integration",
					userId: OWNER_ID,
					organizationId: ORGANIZATION_ID,
					techStack: [],
					features: [],
					tags: [],
				},
			});
			projectId = project.id;
			for (const suffix of ["", "-other"]) {
				const integration =
					await db.projectRepositoryIntegration.create({
						data: {
							projectId,
							provider: "GITHUB",
							authMethod: "OAUTH",
							repositoryUrl: `https://github.com/example-org/${REPO}${suffix}`,
							repositoryOwner: "example-org",
							repositoryName: `${REPO}${suffix}`,
						},
					});
				if (suffix === "") {
					integrationId = integration.id;
				} else {
					otherIntegrationId = integration.id;
				}
			}
			// The permission ladder the stale-pause tests rely on.
			expect(
				await canCreateProjectInstructions(projectId, OWNER_ID),
			).toBe(true);
			expect(
				await canCreateProjectInstructions(projectId, OUTSIDER_ID),
			).toBe(false);
		});

		beforeEach(async () => {
			// A first configure, then the cursors a live schedule carries, all
			// bound to generation 1.
			const first = await upsertInstructionRepositorySync({
				...stored(),
				automatic: true,
			});
			expect(first?.sync.generation).toBe(1);
			await db.projectInstructionRepositorySync.update({
				where: { projectId },
				data: {
					automaticPausedReason: "REF_MISSING",
					automaticPausedAt: new Date("2026-09-23T10:00:00Z"),
					failureCount: 4,
					nextCheckAt: null,
					suppressedCommitSha: SHA("a"),
					suppressedGeneration: 1,
					lastEvaluatedCommitSha: SHA("b"),
					lastEvaluatedGeneration: 1,
					pendingCommitSha: SHA("e"),
				},
			});
		});

		afterEach(async () => {
			await db.projectInstructionRepositorySyncRun.deleteMany({
				where: { projectId },
			});
			await db.projectInstructionRepositorySync.deleteMany({
				where: { projectId },
			});
			// audit_log is append-only; tests purge their own rows the way
			// audit-log-seal.integration.test.ts does.
			await db.$transaction([
				db.$executeRawUnsafe("SET LOCAL app.audit_allow_delete = 'on'"),
				db.$executeRaw`DELETE FROM "audit_log" WHERE "organizationId" = ${ORGANIZATION_ID}`,
			]);
		});

		afterAll(async () => {
			// Delete by the exact ids this run created, never by pattern.
			if (projectId) {
				await db.project.deleteMany({ where: { id: projectId } });
			}
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({
				where: { id: { in: [OWNER_ID, OUTSIDER_ID] } },
			});
			await db.$disconnect();
		});

		it("re-enabling keeps the generation and its cursors, clears the pause and the failures, re-delegates, and dates the due time on the database's clock", async () => {
			const before = await dbClock();
			const result = await upsertInstructionRepositorySync(
				stored({ userId: OUTSIDER_ID }),
			);
			const after = await dbClock();

			expect(result?.sync.generation).toBe(1);
			const row = await syncRow();
			expect(row).toMatchObject({
				generation: 1,
				userId: OUTSIDER_ID,
				automatic: true,
				automaticPausedReason: null,
				automaticPausedAt: null,
				failureCount: 0,
				suppressedCommitSha: SHA("a"),
				suppressedGeneration: 1,
				lastEvaluatedCommitSha: SHA("b"),
				lastEvaluatedGeneration: 1,
				pendingCommitSha: SHA("e"),
			});
			// The lock statement's clock, rounded to the column's milliseconds.
			expect(row.nextCheckAt?.getTime()).toBeGreaterThanOrEqual(
				before.getTime() - 1,
			);
			expect(row.nextCheckAt?.getTime()).toBeLessThanOrEqual(
				after.getTime(),
			);
		});

		it.each([
			["switched off", false],
			["switched on", true],
		])(
			"an open run survives automatic sync %s: begin's retry, the publish fence and the completion all still see its generation",
			async (_label, automatic) => {
				const { id: syncId } = await syncRow();
				const run = await beginRun(syncId, 1);
				expect(run.inserted).toBe(true);

				await upsertInstructionRepositorySync({
					...stored(),
					automatic,
				});

				// `begin` retried: the receipt's generation is still the row's.
				const retry = await insertInstructionRepositorySyncRun({
					id: run.id,
					syncId,
					projectId,
					organizationId: ORGANIZATION_ID,
					userId: OWNER_ID,
					generation: (await syncRow()).generation,
					trigger: "POLL",
					startedAt: new Date(),
				});
				expect(retry).toEqual({ inserted: false, generation: 1 });
				// The publish goes ahead rather than NOT_PUBLISHED.
				expect(await publishRefusal(syncId, 1)).toBeNull();
				// And the completion is current, so it is not reclassified as
				// CONFIGURATION_CHANGED and its schedule effect lands.
				expect(
					await completeInstructionRepositorySyncRun({
						runKey: run.id,
						syncId,
						generation: 1,
						projectId,
						organizationId: ORGANIZATION_ID,
						userId: OWNER_ID,
						trigger: "POLL",
						status: "SUCCEEDED",
						error: null,
						note: null,
						commitSha: SHA("c"),
						snapshotId: null,
						scheduling: { kind: "success", commitSha: SHA("c") },
						classifyStaleAsConfigurationChanged: true,
					}),
				).toEqual({ completed: true, configurationCurrent: true });
				const receipt =
					await db.projectInstructionRepositorySyncRun.findUniqueOrThrow(
						{ where: { id: run.id } },
					);
				expect(receipt).toMatchObject({
					status: "SUCCEEDED",
					error: null,
				});
				expect(await syncRow()).toMatchObject({
					generation: 1,
					lastEvaluatedCommitSha: SHA("c"),
					lastEvaluatedGeneration: 1,
					// Consumed by the completion, as an open run's must be.
					pendingCommitSha: null,
				});
			},
		);

		it.each([
			[
				"the repository",
				() => ({ repositoryIntegrationId: otherIntegrationId }),
			],
			["the branch", () => ({ ref: "release" })],
			["the folder", () => ({ rootPath: "" })],
			["the ignore rules", () => ({ ignoreGlobs: ["skills/**"] })],
		])(
			"changing %s still fences the open run and resets the schedule",
			async (_label, change) => {
				const { id: syncId } = await syncRow();
				const run = await beginRun(syncId, 1);

				await upsertInstructionRepositorySync({
					...stored(),
					...change(),
				});

				const row = await syncRow();
				expect(row.generation).toBeGreaterThan(1);
				expect(row).toMatchObject({
					suppressedCommitSha: null,
					lastEvaluatedCommitSha: null,
					pendingCommitSha: null,
				});
				expect(await publishRefusal(syncId, 1)).toBe(
					"configuration_changed",
				);
				await completeInstructionRepositorySyncRun({
					runKey: run.id,
					syncId,
					generation: 1,
					projectId,
					organizationId: ORGANIZATION_ID,
					userId: OWNER_ID,
					trigger: "POLL",
					status: "SUCCEEDED",
					error: null,
					note: null,
					commitSha: SHA("c"),
					snapshotId: null,
					scheduling: { kind: "success", commitSha: SHA("c") },
					classifyStaleAsConfigurationChanged: true,
				});
				expect(
					await db.projectInstructionRepositorySyncRun.findUniqueOrThrow(
						{ where: { id: run.id } },
					),
				).toMatchObject({
					status: "FAILED",
					error: "CONFIGURATION_CHANGED",
				});
			},
		);

		it("ends a poll check's held lease without a generation bump: the lease read and the fenced write both refuse", async () => {
			// A live, unpaused row with a lease the claim would have written:
			// the database's clock plus two minutes, read back as written.
			await db.projectInstructionRepositorySync.update({
				where: { projectId },
				data: { automaticPausedReason: null, automaticPausedAt: null },
			});
			const [leased] = await db.$queryRaw<
				{ id: string; generation: number; leaseUntil: Date }[]
			>`
				UPDATE "project_instruction_repository_sync"
				SET "nextCheckAt" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '2 minutes'
				WHERE "projectId" = ${projectId}
				RETURNING "id", "generation", "nextCheckAt" AS "leaseUntil"`;
			if (!leased) {
				throw new Error("no row leased");
			}
			expect((await instructionSyncLeaseHeld(db, leased)).held).toBe(
				true,
			);

			// "Re-enable" with automatic sync left on: only `nextCheckAt` can
			// end the lease here.
			await upsertInstructionRepositorySync(stored());

			const row = await syncRow();
			expect(row.generation).toBe(leased.generation);
			expect(row.automatic).toBe(true);
			expect(row.nextCheckAt?.getTime()).toBeLessThan(
				leased.leaseUntil.getTime(),
			);
			expect((await instructionSyncLeaseHeld(db, leased)).held).toBe(
				false,
			);
			expect(
				await writeBackInstructionSync(db, leased, {
					failureCount: 9,
					nextCheckAt: new Date("2030-01-01T00:00:00Z"),
				}),
			).toEqual({ applied: false });
			expect((await syncRow()).failureCount).toBe(0);
		});

		describe("a run that records PERMISSION_DENIED after a re-enable", () => {
			/**
			 * The history a stale pause comes from: the delegate lost the
			 * permission, and a poll run began acting as that delegate, as
			 * `begin` makes an automatic run act as the row's delegate.
			 */
			async function beginAsRevokedDelegate() {
				const { id: syncId } = await syncRow();
				await db.projectInstructionRepositorySync.update({
					where: { id: syncId },
					data: {
						userId: OUTSIDER_ID,
						automaticPausedReason: null,
						automaticPausedAt: null,
					},
				});
				const run = await beginRun(syncId, 1, OUTSIDER_ID);
				return { syncId, run };
			}

			/** The completion that run records: PERMISSION_DENIED, pausing. */
			async function completeRevoked(syncId: string, runKey: string) {
				await completeInstructionRepositorySyncRun({
					runKey,
					syncId,
					generation: 1,
					projectId,
					organizationId: ORGANIZATION_ID,
					userId: OUTSIDER_ID,
					trigger: "POLL",
					status: "NOT_PUBLISHED",
					error: "PERMISSION_DENIED",
					note: null,
					commitSha: SHA("c"),
					snapshotId: null,
					scheduling: { kind: "pause", reason: "PERMISSION_REVOKED" },
				});
			}

			it("does not pause again once the owner re-enabled while the run was open: the delegate the configuration names now may create instructions", async () => {
				const { syncId, run } = await beginAsRevokedDelegate();
				// Re-enabled by the owner, who becomes the delegate, while the
				// outsider's run is still open.
				await upsertInstructionRepositorySync(stored());

				await completeRevoked(syncId, run.id);

				expect(await syncRow()).toMatchObject({
					generation: 1,
					userId: OWNER_ID,
					automaticPausedReason: null,
					automaticPausedAt: null,
				});
				expect(
					await db.projectInstructionRepositorySyncRun.findUniqueOrThrow(
						{ where: { id: run.id } },
					),
				).toMatchObject({
					userId: OUTSIDER_ID,
					status: "NOT_PUBLISHED",
					error: "PERMISSION_DENIED",
				});
			});

			it("pauses while the delegate the configuration names now still lacks the permission", async () => {
				const { syncId, run } = await beginAsRevokedDelegate();

				await completeRevoked(syncId, run.id);

				expect(await syncRow()).toMatchObject({
					generation: 1,
					userId: OUTSIDER_ID,
					automaticPausedReason: "PERMISSION_REVOKED",
					nextCheckAt: null,
				});
			});
		});

		it("a flag-only configure and a completion that holds the configuration row while inserting a project-keyed row both commit: no 40P01", async () => {
			const { id: syncId } = await syncRow();

			// Transaction A plays the completion: the configuration row lock
			// first, then an insert whose project foreign key takes
			// FOR KEY SHARE on the project row (the completion's audit row;
			// here a receipt, which carries the same kind of key).
			let releaseA: () => void = () => {};
			const aHoldsLock = new Promise<void>((resolve) => {
				releaseA = resolve;
			});
			let signalLocked: (pid: number) => void = () => {};
			const locked = new Promise<number>((resolve) => {
				signalLocked = resolve;
			});
			const completion = db.$transaction(
				async (tx) => {
					const [lock] = await tx.$queryRaw<{ pid: number }[]>`
						SELECT pg_backend_pid() AS "pid"
						FROM "project_instruction_repository_sync"
						WHERE "id" = ${syncId}
						FOR UPDATE`;
					signalLocked(lock?.pid ?? -1);
					await aHoldsLock;
					runNumber += 1;
					await tx.projectInstructionRepositorySyncRun.create({
						data: {
							id: `${syncId}:run-${runNumber}`,
							syncId,
							projectId,
							organizationId: ORGANIZATION_ID,
							userId: OWNER_ID,
							generation: 1,
							trigger: "POLL",
							startedAt: new Date(),
						},
					});
				},
				{ timeout: 20_000, maxWait: 5_000 },
			);

			let configure: Promise<unknown> = Promise.resolve();
			let configureBlocked = false;
			try {
				// A failed lock rejects here rather than leaving the wait hung.
				const aPid = await Promise.race([
					locked,
					completion.then(() => -1),
				]);
				expect(aPid).toBeGreaterThan(0);
				// The configure takes the project row, then waits on A's lock.
				configure = upsertInstructionRepositorySync(stored());
				// Wait until THIS configure is blocked by A itself: a backend
				// whose blockers include A's pid, running the configuration
				// row lock. A holds no other lock anyone could wait on, so an
				// unrelated waiter in the shared database cannot match.
				const deadline = Date.now() + 5_000;
				while (!configureBlocked && Date.now() < deadline) {
					const [row] = await db.$queryRaw<{ waiting: bigint }[]>`
						SELECT count(*) AS "waiting"
						FROM pg_stat_activity
						WHERE ${aPid}::int = ANY (pg_blocking_pids("pid"))
							AND "query" LIKE '%FROM "project_instruction_repository_sync"%FOR UPDATE%'
							AND "query" LIKE '%clock_timestamp()%'`;
					configureBlocked = Number(row?.waiting ?? 0) > 0;
					if (!configureBlocked) {
						await new Promise((resolve) => setTimeout(resolve, 25));
					}
				}
			} finally {
				// Only now does A insert its project-keyed row, and it always
				// ends, so a failed wait never leaves it holding the row.
				releaseA();
			}
			const [a, b] = await Promise.allSettled([completion, configure]);

			expect(configureBlocked).toBe(true);
			expect(a).toEqual({ status: "fulfilled", value: undefined });
			// A rejection shows its reason here (40P01 on a FOR UPDATE lock).
			expect(b.status === "rejected" ? String(b.reason) : b.status).toBe(
				"fulfilled",
			);
			expect(await syncRow()).toMatchObject({
				generation: 1,
				automaticPausedReason: null,
			});
		}, 30_000);
	},
);
