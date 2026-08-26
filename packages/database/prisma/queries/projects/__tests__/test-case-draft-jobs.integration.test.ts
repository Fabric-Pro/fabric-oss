/**
 * Real-Postgres integration tests for the TestCaseDraftJob ledger — the durable
 * row behind one "draft test cases with AI" run.
 *
 * This row is the only thing that makes the run survive a reload, so every
 * write against it is a compare-and-set against the status the caller expects.
 * These are the assertions a mocked suite cannot make, because the contract
 * under test IS the SQL:
 *   - `recordTestCaseDraftFeatureOutcome` is idempotent per story. The workflow
 *     proxies it with `maximumAttempts: 3`, and Temporal's classic failure mode
 *     is "the DB write commits, the completion report to the server is lost" —
 *     so the same outcome arrives twice. Proving that takes a real row, because
 *     the dedupe reads back the `Json` column it previously wrote.
 *   - the compare-and-set on RUNNING is an `updateMany ... WHERE status` whose
 *     whole value is the row it refuses to touch; a mock's `count` is a
 *     tautology.
 *   - the readers' project scoping is a `WHERE projectId` — only a second
 *     project's real rows can show that a cross-project id resolves to nothing.
 *
 * No mocks — hits the live Aspire Postgres via the shared Prisma singleton.
 * Self-skips when DATABASE_URL is unset or is the CI placeholder
 * (`hasReachableDatabaseUrl`), mirroring the sibling integration suites.
 *
 * Run with: pnpm --filter @repo/database test:integration
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { db, Prisma } from "../../../client";
import {
	cancelTestCaseDraftJob,
	claimTestCaseDraftJob,
	completeTestCaseDraftJob,
	createTestCaseDraftJob,
	failTestCaseDraftJob,
	getTestCaseDraftJob,
	getTestCaseDraftJobResultCases,
	listTestCaseDraftJobs,
	markTestCaseDraftJobRunning,
	parseFeatureOutcomes,
	recordTestCaseDraftFeatureOutcome,
	STALE_ACTIVE_DRAFT_JOB_MS,
	setTestCaseDraftJobWorkflowId,
	type TestCaseDraftFeatureOutcome,
} from "../test-case-draft-jobs";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-tcjob-org-${RUN_ID}`;
const USER_ID = `test-tcjob-user-${RUN_ID}`;
/** A second requester — `listTestCaseDraftJobs` scopes to one. */
const OTHER_USER_ID = `test-tcjob-user2-${RUN_ID}`;
const PROJECT_ID = `test-tcjob-proj-${RUN_ID}`;
/** Proves every read/write is re-scoped to the project it was asked for. */
const OTHER_PROJECT_ID = `test-tcjob-proj-other-${RUN_ID}`;
const PROJECT_IDS = [PROJECT_ID, OTHER_PROJECT_ID];
const STATUS_ID = `test-tcjob-status-${RUN_ID}`;

describe.skipIf(!hasReachableDatabaseUrl())(
	"TestCaseDraftJob ledger (real Postgres)",
	() => {
		/** A real story, for the one test that exercises coverage rendering. */
		const coveredStoryId = `test-tcjob-story-${RUN_ID}`;

		/** Only unique per project matters, so a shared counter is enough. */
		let caseSeq = 0;

		/** Per-test requesters, torn down with the rest of the fixture. */
		const requesterIds: string[] = [];

		/**
		 * A real TestCase row. The ledger stores case ids as a bare `String[]`
		 * with no FK, but the results reader resolves them against `test_case`,
		 * so anything asserting on that reader needs rows that exist.
		 */
		async function seedCase(input: {
			projectId?: string;
			title: string;
			order?: number;
			stepCount?: number;
			coverStoryId?: string;
			acceptanceCriterionRefs?: string[];
		}): Promise<string> {
			caseSeq += 1;
			const created = await db.testCase.create({
				data: {
					projectId: input.projectId ?? PROJECT_ID,
					identifier: `TC-${String(caseSeq).padStart(3, "0")}`,
					createdById: USER_ID,
					userId: USER_ID,
					organizationId: ORG_ID,
					title: input.title,
					order: input.order ?? caseSeq,
					...(input.stepCount
						? {
								steps: {
									create: Array.from(
										{ length: input.stepCount },
										(_, i) => ({
											order: i + 1,
											action: `Action ${i + 1}`,
											expected: `Expected ${i + 1}`,
										}),
									),
								},
							}
						: {}),
					...(input.coverStoryId
						? {
								workItemLinks: {
									create: {
										userStoryId: input.coverStoryId,
										acceptanceCriterionRefs:
											input.acceptanceCriterionRefs ?? [],
									},
								},
							}
						: {}),
				},
				select: { id: true },
			});
			return created.id;
		}

		/**
		 * Every mutating test creates its own job, so no test can observe or
		 * disturb another's row regardless of execution order.
		 */
		async function newJob(
			storyIds: string[],
			overrides?: { projectId?: string; requestedById?: string },
		) {
			return await createTestCaseDraftJob({
				projectId: overrides?.projectId ?? PROJECT_ID,
				organizationId: ORG_ID,
				userId: USER_ID,
				requestedById: overrides?.requestedById ?? USER_ID,
				storyIds,
			});
		}

		/** A job advanced to RUNNING — the state every outcome write expects. */
		async function newRunningJob(storyIds: string[]) {
			const job = await newJob(storyIds);
			expect(await markTestCaseDraftJobRunning(job.id)).toBe(true);
			return job;
		}

		/**
		 * A requester of this run's own. The list reader pages (`take: 10`) over
		 * one requester's jobs, so a test that asserts on a whole listing gives
		 * itself a private requester rather than sharing the suite-wide user and
		 * competing with every other test's rows for the page.
		 */
		async function seedRequester(suffix: string): Promise<string> {
			const id = `test-tcjob-${suffix}-${RUN_ID}`;
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${id}, ${`Draft Job ${suffix}`}, ${`${id}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			requesterIds.push(id);
			return id;
		}

		/** Read back through the project-scoped reader, narrowing away null. */
		async function readJob(jobId: string, projectId: string = PROJECT_ID) {
			const row = await getTestCaseDraftJob({ jobId, projectId });
			if (!row) {
				throw new Error(
					`job ${jobId} unexpectedly absent from project ${projectId}`,
				);
			}
			return row;
		}

		function outcomeFor(
			storyId: string,
			caseIds: string[],
			overrides?: Partial<TestCaseDraftFeatureOutcome>,
		): TestCaseDraftFeatureOutcome {
			return {
				storyId,
				storyIdentifier: "F-001",
				storyTitle: `Feature for ${storyId}`,
				status: "DRAFTED",
				caseIds,
				...overrides,
			};
		}

		beforeAll(async () => {
			const now = new Date();
			for (const [id, name] of [
				[USER_ID, "Draft Job User"],
				[OTHER_USER_ID, "Draft Job Other User"],
			]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
					VALUES (${id}, ${name}, ${`${id}@test.com`}, true, false, ${now}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
			}
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Draft Job Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);

			// Raw SQL (like the user/org rows above) rather than `project.create`:
			// the fixture only needs id/name/owner, and naming the columns keeps
			// the suite independent of unrelated churn in the Project model.
			for (const [id, name] of [
				[PROJECT_ID, "Draft Job Project"],
				[OTHER_PROJECT_ID, "Draft Job Other Project"],
			]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "project" (id, name, "userId", "organizationId", "createdAt", "updatedAt")
					VALUES (${id}, ${name}, ${USER_ID}, ${ORG_ID}, ${now}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
			}

			// One real story, so the results reader has coverage to render. The
			// ledger itself never FKs to `user_story` — its `storyIds` and the
			// `storyId` inside each outcome are plain strings — so the rest of
			// the suite uses synthetic ids.
			await db.projectStoryStatus.create({
				data: {
					id: STATUS_ID,
					projectId: PROJECT_ID,
					name: "Backlog",
					color: "#000000",
					order: 1,
					isDefault: true,
				},
			});
			await db.userStory.create({
				data: {
					id: coveredStoryId,
					projectId: PROJECT_ID,
					statusId: STATUS_ID,
					identifier: "F-001",
					title: "Covered feature",
					createdById: USER_ID,
				},
			});
		}, 60_000);

		afterAll(async () => {
			// Steps and work-item links cascade from test_case. Everything else
			// is deleted explicitly rather than leaning on the project cascade,
			// so a missed row surfaces in the check below instead of silently
			// polluting a shared local DB.
			await db.testCaseDraftJob.deleteMany({
				where: { projectId: { in: PROJECT_IDS } },
			});
			await db.testCase.deleteMany({
				where: { projectId: { in: PROJECT_IDS } },
			});
			await db.userStory.deleteMany({
				where: { projectId: { in: PROJECT_IDS } },
			});
			await db.projectStoryStatus.deleteMany({
				where: { projectId: { in: PROJECT_IDS } },
			});
			await db.project.deleteMany({ where: { id: { in: PROJECT_IDS } } });
			await db.organization.deleteMany({ where: { id: ORG_ID } });
			const userIds = [USER_ID, OTHER_USER_ID, ...requesterIds];
			await db.user.deleteMany({ where: { id: { in: userIds } } });

			// Verify the teardown rather than assume it.
			const [jobs, cases, stories, statuses, projects, orgs, users] =
				await Promise.all([
					db.testCaseDraftJob.count({
						where: { projectId: { in: PROJECT_IDS } },
					}),
					db.testCase.count({
						where: { projectId: { in: PROJECT_IDS } },
					}),
					db.userStory.count({
						where: { projectId: { in: PROJECT_IDS } },
					}),
					db.projectStoryStatus.count({
						where: { projectId: { in: PROJECT_IDS } },
					}),
					db.project.count({ where: { id: { in: PROJECT_IDS } } }),
					db.organization.count({ where: { id: ORG_ID } }),
					db.user.count({ where: { id: { in: userIds } } }),
				]);
			expect({
				jobs,
				cases,
				stories,
				statuses,
				projects,
				orgs,
				users,
			}).toEqual({
				jobs: 0,
				cases: 0,
				stories: 0,
				statuses: 0,
				projects: 0,
				orgs: 0,
				users: 0,
			});
		});

		// -------------------------------------------------------------------
		// 1. Idempotency — a Temporal retry must not double-count
		// -------------------------------------------------------------------

		it("records a repeated outcome exactly once and keeps the count honest", async () => {
			const storyId = `story-retry-${RUN_ID}`;
			const job = await newRunningJob([storyId]);
			const caseA = await seedCase({ title: "Retry case A" });
			const caseB = await seedCase({ title: "Retry case B" });
			const outcome = outcomeFor(storyId, [caseA, caseB]);

			// The real scenario, not a hypothetical: the activity's Postgres
			// write commits, then the completion report back to the Temporal
			// server is lost. The workflow proxies this activity with
			// `maximumAttempts: 3`, so Temporal re-runs it with byte-identical
			// input. Both calls must report success — from the workflow's side a
			// retry is not a failure, and returning false here would tell it the
			// run had been cancelled and stop a healthy job.
			const first = await recordTestCaseDraftFeatureOutcome({
				jobId: job.id,
				outcome,
			});
			const second = await recordTestCaseDraftFeatureOutcome({
				jobId: job.id,
				outcome,
			});
			expect(first).toBe(true);
			expect(second).toBe(true);

			const row = await readJob(job.id);
			const outcomes = parseFeatureOutcomes(row.featureOutcomes);
			expect(outcomes).toHaveLength(1);
			expect(outcomes[0]).toEqual(outcome);
			// Progress can never exceed the work that was requested.
			expect(row.totalFeatures).toBe(1);
			expect(row.processedFeatures).toBe(1);
			expect(row.createdCaseIds).toEqual([caseA, caseB]);
			expect(new Set(row.createdCaseIds).size).toBe(
				row.createdCaseIds.length,
			);

			// The downstream consequence — the part a user actually sees.
			// `finalizeTestCaseDraftJob` (packages/temporal) derives the
			// completion notification's headline from `createdCaseIds.length`
			// and lands the terminal state through `completeTestCaseDraftJob`.
			// It cannot be imported here (temporal depends on database, not the
			// reverse), so this asserts the exact value it reads off the row it
			// gets back.
			const finished = await completeTestCaseDraftJob({
				jobId: job.id,
				status: "SUCCEEDED",
			});
			if (!finished) {
				throw new Error("terminal write was unexpectedly dropped");
			}
			const createdCount = finished.createdCaseIds.length;
			expect(createdCount).toBe(2);

			// ...and the number the notification promises has to match what the
			// results view can actually show. The reader resolves ids through
			// `IN (...)`, which collapses a duplicated id back to one row — so a
			// ledger that double-appended would promise "4 draft test cases
			// ready" and then render 2.
			const resultCases = await getTestCaseDraftJobResultCases({
				projectId: PROJECT_ID,
				caseIds: finished.createdCaseIds,
			});
			expect(resultCases).toHaveLength(2);
			expect(createdCount).toBe(resultCases.length);
		});

		it("dedupes on the story, not on the payload — a corrected retry does not re-append", async () => {
			const storyId = `story-corrected-${RUN_ID}`;
			const job = await newRunningJob([storyId]);
			const caseA = await seedCase({ title: "Corrected case A" });
			const caseB = await seedCase({ title: "Corrected case B" });

			// A retry does not have to be byte-identical: the activity re-runs
			// its own work, so the second attempt can legitimately carry a
			// different payload for the same feature. The ledger's key is the
			// story, so the first recorded answer stands and the retry is a
			// no-op — one feature can never occupy two ledger slots.
			expect(
				await recordTestCaseDraftFeatureOutcome({
					jobId: job.id,
					outcome: outcomeFor(storyId, [caseA]),
				}),
			).toBe(true);
			expect(
				await recordTestCaseDraftFeatureOutcome({
					jobId: job.id,
					outcome: outcomeFor(storyId, [caseB], { status: "FAILED" }),
				}),
			).toBe(true);

			const row = await readJob(job.id);
			expect(parseFeatureOutcomes(row.featureOutcomes)).toHaveLength(1);
			expect(row.processedFeatures).toBe(1);
			expect(row.createdCaseIds).toEqual([caseA]);
		});

		// -------------------------------------------------------------------
		// 2. Distinct features still accumulate
		// -------------------------------------------------------------------

		it("accumulates outcomes for different features", async () => {
			// The guard against an over-broad dedupe: collapsing on anything
			// coarser than the story id would swallow real, paid-for work.
			const storyA = `story-multi-a-${RUN_ID}`;
			const storyB = `story-multi-b-${RUN_ID}`;
			const job = await newRunningJob([storyA, storyB]);
			const caseA = await seedCase({ title: "Multi case A" });
			const caseB = await seedCase({ title: "Multi case B" });

			expect(
				await recordTestCaseDraftFeatureOutcome({
					jobId: job.id,
					outcome: outcomeFor(storyA, [caseA]),
				}),
			).toBe(true);
			expect(
				await recordTestCaseDraftFeatureOutcome({
					jobId: job.id,
					outcome: outcomeFor(storyB, [caseB]),
				}),
			).toBe(true);

			const row = await readJob(job.id);
			const outcomes = parseFeatureOutcomes(row.featureOutcomes);
			expect(outcomes).toHaveLength(2);
			expect(outcomes.map((o) => o.storyId)).toEqual([storyA, storyB]);
			expect(row.processedFeatures).toBe(2);
			expect(row.totalFeatures).toBe(2);
			expect(row.createdCaseIds).toEqual([caseA, caseB]);
		});

		it("keeps a partially-successful run fully explainable", async () => {
			// A feature failing never aborts the others, so every requested
			// story lands an outcome — including the non-DRAFTED ones, which
			// contribute no case ids.
			const drafted = `story-mixed-ok-${RUN_ID}`;
			const noCriteria = `story-mixed-nac-${RUN_ID}`;
			const failed = `story-mixed-fail-${RUN_ID}`;
			const job = await newRunningJob([drafted, noCriteria, failed]);
			const caseId = await seedCase({ title: "Mixed run case" });

			await recordTestCaseDraftFeatureOutcome({
				jobId: job.id,
				outcome: outcomeFor(drafted, [caseId]),
			});
			await recordTestCaseDraftFeatureOutcome({
				jobId: job.id,
				outcome: outcomeFor(noCriteria, [], {
					status: "NO_ACCEPTANCE_CRITERIA",
				}),
			});
			await recordTestCaseDraftFeatureOutcome({
				jobId: job.id,
				outcome: outcomeFor(failed, [], {
					status: "FAILED",
					error: "Rate limited by the provider",
				}),
			});

			const row = await readJob(job.id);
			const outcomes = parseFeatureOutcomes(row.featureOutcomes);
			expect(outcomes).toHaveLength(3);
			expect(outcomes.map((o) => o.status)).toEqual([
				"DRAFTED",
				"NO_ACCEPTANCE_CRITERIA",
				"FAILED",
			]);
			// `error` is optional in the type; it has to survive the Json
			// round-trip on the one entry that carries it, and stay absent on
			// the others.
			expect(outcomes[2].error).toBe("Rate limited by the provider");
			expect(outcomes[0].error).toBeUndefined();
			expect(outcomes[1].error).toBeUndefined();
			expect(row.processedFeatures).toBe(3);
			// Only the drafted feature contributed a case.
			expect(row.createdCaseIds).toEqual([caseId]);
		});

		// -------------------------------------------------------------------
		// 3. Compare-and-set on RUNNING
		// -------------------------------------------------------------------

		it("drops an outcome arriving for a cancelled job", async () => {
			const storyId = `story-cancelled-${RUN_ID}`;
			const job = await newRunningJob([storyId]);
			const caseId = await seedCase({ title: "Cancelled run case" });

			expect(
				await cancelTestCaseDraftJob({
					jobId: job.id,
					projectId: PROJECT_ID,
				}),
			).toEqual({ workflowId: null });

			// The user pressed Stop while a generation was in flight. Returning
			// false is what tells the workflow to stop rather than pay for the
			// next feature.
			expect(
				await recordTestCaseDraftFeatureOutcome({
					jobId: job.id,
					outcome: outcomeFor(storyId, [caseId]),
				}),
			).toBe(false);

			const row = await readJob(job.id);
			expect(row.status).toBe("CANCELLED");
			expect(parseFeatureOutcomes(row.featureOutcomes)).toEqual([]);
			expect(row.processedFeatures).toBe(0);
			expect(row.createdCaseIds).toEqual([]);
		});

		it("drops an outcome for a job that never reached RUNNING", async () => {
			const storyId = `story-pending-${RUN_ID}`;
			const job = await newJob([storyId]);

			expect(
				await recordTestCaseDraftFeatureOutcome({
					jobId: job.id,
					outcome: outcomeFor(storyId, []),
				}),
			).toBe(false);

			const row = await readJob(job.id);
			expect(row.status).toBe("PENDING");
			expect(row.processedFeatures).toBe(0);
		});

		it("drops an outcome for a job id that does not exist", async () => {
			expect(
				await recordTestCaseDraftFeatureOutcome({
					jobId: `test-tcjob-missing-${RUN_ID}`,
					outcome: outcomeFor(`story-missing-${RUN_ID}`, []),
				}),
			).toBe(false);
		});

		it("refuses to resurrect a cancelled job when the result lands late", async () => {
			const job = await newRunningJob([`story-late-${RUN_ID}`]);
			await cancelTestCaseDraftJob({
				jobId: job.id,
				projectId: PROJECT_ID,
			});

			// The finalize step racing a cancel: the workflow finished its last
			// feature just as the user pressed Stop. CANCELLED has to win — the
			// user already moved on, and a SUCCEEDED row here would notify them
			// about a run they explicitly stopped.
			expect(
				await completeTestCaseDraftJob({
					jobId: job.id,
					status: "SUCCEEDED",
				}),
			).toBeNull();

			const row = await readJob(job.id);
			expect(row.status).toBe("CANCELLED");
			expect(row.error).toBeNull();
		});

		// -------------------------------------------------------------------
		// 4. The rest of the lifecycle
		// -------------------------------------------------------------------

		it("creates a job PENDING with progress zeroed", async () => {
			const storyIds = [`story-new-a-${RUN_ID}`, `story-new-b-${RUN_ID}`];
			const job = await newJob(storyIds);

			expect(job.status).toBe("PENDING");
			expect(job.storyIds).toEqual(storyIds);
			expect(job.totalFeatures).toBe(storyIds.length);
			expect(job.processedFeatures).toBe(0);
			expect(job.createdCaseIds).toEqual([]);
			expect(job.featureOutcomes).toBeNull();
			expect(job.workflowId).toBeNull();
			expect(job.completedAt).toBeNull();
			expect(job.error).toBeNull();
			// Denormalized from the parent Project for RLS and cascade delete.
			expect(job.projectId).toBe(PROJECT_ID);
			expect(job.organizationId).toBe(ORG_ID);
			expect(job.userId).toBe(USER_ID);
			expect(job.requestedById).toBe(USER_ID);
		});

		it("stamps the workflow id while PENDING and advances to RUNNING once", async () => {
			const job = await newJob([`story-begin-${RUN_ID}`]);
			const workflowId = `wf-begin-${RUN_ID}`;

			await setTestCaseDraftJobWorkflowId({ jobId: job.id, workflowId });
			expect((await readJob(job.id)).workflowId).toBe(workflowId);

			expect(await markTestCaseDraftJobRunning(job.id)).toBe(true);
			const running = await readJob(job.id);
			expect(running.status).toBe("RUNNING");
			expect(running.startedAt).toBeInstanceOf(Date);

			// PENDING → RUNNING is a compare-and-set, so a second worker (or a
			// retry of the begin activity) is told the transition was not its
			// to make.
			expect(await markTestCaseDraftJobRunning(job.id)).toBe(false);
			expect((await readJob(job.id)).status).toBe("RUNNING");
		});

		it("ignores a workflow-id stamp that arrives after the job left PENDING", async () => {
			const job = await newJob([`story-late-stamp-${RUN_ID}`]);
			await setTestCaseDraftJobWorkflowId({
				jobId: job.id,
				workflowId: `wf-first-${RUN_ID}`,
			});
			await markTestCaseDraftJobRunning(job.id);

			// The stamp is scoped to PENDING: a slow dispatch reply must never
			// write onto a job that has already moved on.
			await setTestCaseDraftJobWorkflowId({
				jobId: job.id,
				workflowId: `wf-late-${RUN_ID}`,
			});
			expect((await readJob(job.id)).workflowId).toBe(
				`wf-first-${RUN_ID}`,
			);
		});

		it("lands SUCCEEDED with no error and a completion time", async () => {
			const job = await newRunningJob([`story-succeed-${RUN_ID}`]);

			const finished = await completeTestCaseDraftJob({
				jobId: job.id,
				status: "SUCCEEDED",
				error: null,
			});
			if (!finished) {
				throw new Error("terminal write was unexpectedly dropped");
			}
			expect(finished.status).toBe("SUCCEEDED");
			expect(finished.error).toBeNull();
			expect(finished.completedAt).toBeInstanceOf(Date);

			// Terminal is terminal — a duplicate finalize finds nothing RUNNING.
			expect(
				await completeTestCaseDraftJob({
					jobId: job.id,
					status: "FAILED",
					error: "should not land",
				}),
			).toBeNull();
			expect((await readJob(job.id)).status).toBe("SUCCEEDED");
		});

		it("lands FAILED with the error, bounded to the column's budget", async () => {
			const job = await newRunningJob([`story-fail-${RUN_ID}`]);
			const error = "e".repeat(5000);

			const finished = await completeTestCaseDraftJob({
				jobId: job.id,
				status: "FAILED",
				error,
			});
			if (!finished) {
				throw new Error("terminal write was unexpectedly dropped");
			}
			expect(finished.status).toBe("FAILED");
			// An upstream provider error can be arbitrarily long; the row caps it
			// rather than letting one run's stack trace bloat the table.
			expect(finished.error).toHaveLength(4000);
			expect(finished.error).toBe(error.slice(0, 4000));
		});

		it("fails a job that never got as far as RUNNING", async () => {
			const job = await newJob([`story-dispatch-fail-${RUN_ID}`]);

			// Dispatch blew up — the workflow never started, so nothing will ever
			// move this row off PENDING unless the caller does it here.
			await failTestCaseDraftJob({
				jobId: job.id,
				error: "Failed to start workflow",
			});

			const row = await readJob(job.id);
			expect(row.status).toBe("FAILED");
			expect(row.error).toBe("Failed to start workflow");
			expect(row.completedAt).toBeInstanceOf(Date);
		});

		it("cannot overwrite a real outcome with a dispatch failure", async () => {
			const job = await newRunningJob([`story-fail-late-${RUN_ID}`]);
			await completeTestCaseDraftJob({
				jobId: job.id,
				status: "SUCCEEDED",
			});

			await failTestCaseDraftJob({ jobId: job.id, error: "too late" });

			const row = await readJob(job.id);
			expect(row.status).toBe("SUCCEEDED");
			expect(row.error).toBeNull();
		});

		it("cancels a live job and hands back its workflow id", async () => {
			const job = await newJob([`story-cancel-${RUN_ID}`]);
			const workflowId = `wf-cancel-${RUN_ID}`;
			await setTestCaseDraftJobWorkflowId({ jobId: job.id, workflowId });

			// The workflow id comes back so the caller can cancel the Temporal
			// run — the DB write alone only stops the ledger advancing.
			expect(
				await cancelTestCaseDraftJob({
					jobId: job.id,
					projectId: PROJECT_ID,
				}),
			).toEqual({ workflowId });

			const row = await readJob(job.id);
			expect(row.status).toBe("CANCELLED");
			expect(row.completedAt).toBeInstanceOf(Date);

			// Nothing live left to cancel.
			expect(
				await cancelTestCaseDraftJob({
					jobId: job.id,
					projectId: PROJECT_ID,
				}),
			).toBeNull();
		});

		it("refuses to cancel a job through another project", async () => {
			const job = await newRunningJob([`story-cancel-cross-${RUN_ID}`]);

			// A caller only ever proves rights over a project. Passing a foreign
			// job id must resolve to nothing rather than stopping someone else's
			// paid-for run.
			expect(
				await cancelTestCaseDraftJob({
					jobId: job.id,
					projectId: OTHER_PROJECT_ID,
				}),
			).toBeNull();
			expect((await readJob(job.id)).status).toBe("RUNNING");
		});

		it("refuses to cancel a job that already succeeded", async () => {
			const job = await newRunningJob([`story-cancel-done-${RUN_ID}`]);
			await completeTestCaseDraftJob({
				jobId: job.id,
				status: "SUCCEEDED",
			});

			expect(
				await cancelTestCaseDraftJob({
					jobId: job.id,
					projectId: PROJECT_ID,
				}),
			).toBeNull();
			expect((await readJob(job.id)).status).toBe("SUCCEEDED");
		});

		// -------------------------------------------------------------------
		// 5. Readers
		// -------------------------------------------------------------------

		it("resolves a job only through its own project", async () => {
			const job = await newJob([`story-get-${RUN_ID}`]);

			expect(
				await getTestCaseDraftJob({
					jobId: job.id,
					projectId: PROJECT_ID,
				}),
			).not.toBeNull();
			// The id alone is not authorization.
			expect(
				await getTestCaseDraftJob({
					jobId: job.id,
					projectId: OTHER_PROJECT_ID,
				}),
			).toBeNull();
		});

		it("lists only this requester's jobs for this project, newest first", async () => {
			const requestedById = await seedRequester("lister");
			const mineOld = await newJob([`story-list-old-${RUN_ID}`], {
				requestedById,
			});
			const mineNew = await newJob([`story-list-new-${RUN_ID}`], {
				requestedById,
			});
			const otherUsers = await newJob(
				[`story-list-other-user-${RUN_ID}`],
				{
					requestedById: OTHER_USER_ID,
				},
			);
			const otherProjects = await newJob(
				[`story-list-other-proj-${RUN_ID}`],
				{
					projectId: OTHER_PROJECT_ID,
					requestedById,
				},
			);

			// `startedAt` defaults to now(); rows created this fast can tie, so
			// pin the ordering key explicitly rather than race the clock.
			await db.testCaseDraftJob.update({
				where: { id: mineOld.id },
				data: { startedAt: new Date("2024-01-01T00:00:00.000Z") },
			});
			await db.testCaseDraftJob.update({
				where: { id: mineNew.id },
				data: { startedAt: new Date("2024-02-01T00:00:00.000Z") },
			});

			const listed = await listTestCaseDraftJobs({
				projectId: PROJECT_ID,
				requestedById,
			});
			const listedIds = listed.map((j) => j.id);

			// The rediscovery read is what re-attaches a reloaded page to a run,
			// so it must never surface a run the viewer did not start...
			expect(listedIds).not.toContain(otherUsers.id);
			// ...nor one from another project.
			expect(listedIds).not.toContain(otherProjects.id);

			// Newest first, and nothing else: the run a returning user cares
			// about is the last one they started.
			expect(listedIds).toEqual([mineNew.id, mineOld.id]);
		});

		it("filters the list by status and honours the limit", async () => {
			const requestedById = await seedRequester("filterer");
			const pending = await newJob([`story-filter-pending-${RUN_ID}`], {
				requestedById,
			});
			const running = await newJob([`story-filter-running-${RUN_ID}`], {
				requestedById,
			});
			await markTestCaseDraftJobRunning(running.id);

			const live = await listTestCaseDraftJobs({
				projectId: PROJECT_ID,
				requestedById,
				statuses: ["PENDING", "RUNNING"],
			});
			expect(new Set(live.map((j) => j.id))).toEqual(
				new Set([pending.id, running.id]),
			);

			const onlyRunning = await listTestCaseDraftJobs({
				projectId: PROJECT_ID,
				requestedById,
				statuses: ["RUNNING"],
			});
			expect(onlyRunning.map((j) => j.id)).toEqual([running.id]);

			expect(
				await listTestCaseDraftJobs({
					projectId: PROJECT_ID,
					requestedById,
					statuses: ["SUCCEEDED"],
				}),
			).toEqual([]);

			expect(
				await listTestCaseDraftJobs({
					projectId: PROJECT_ID,
					requestedById,
					limit: 1,
				}),
			).toHaveLength(1);
		});

		it("returns nothing for an empty batch without touching the DB", async () => {
			expect(
				await getTestCaseDraftJobResultCases({
					projectId: PROJECT_ID,
					caseIds: [],
				}),
			).toEqual([]);
		});

		it("resolves result cases in creation order with steps and coverage", async () => {
			const second = await seedCase({
				title: "Result case B",
				order: 902,
				stepCount: 2,
			});
			const first = await seedCase({
				title: "Result case A",
				order: 901,
				stepCount: 3,
				coverStoryId: coveredStoryId,
				acceptanceCriterionRefs: ["AC 2"],
			});

			// Ids handed in "wrong": the reader orders in the DB, not by the
			// caller's array, so the batch reads in the order it was created.
			const cases = await getTestCaseDraftJobResultCases({
				projectId: PROJECT_ID,
				caseIds: [second, first],
			});
			expect(cases.map((c) => c.id)).toEqual([first, second]);

			expect(cases[0]).toEqual({
				id: first,
				identifier: expect.stringMatching(/^TC-\d{3}$/),
				title: "Result case A",
				state: "DRAFT",
				priority: "MEDIUM",
				stepCount: 3,
				coverage: [
					{
						storyIdentifier: "F-001",
						storyTitle: "Covered feature",
						acceptanceCriterionRefs: ["AC 2"],
					},
				],
			});
			expect(cases[1].stepCount).toBe(2);
			expect(cases[1].coverage).toEqual([]);
		});

		it("collapses a duplicated case id to one row", async () => {
			const caseId = await seedCase({ title: "Duplicated id case" });

			// The ledger's `createdCaseIds` is a plain array with no uniqueness
			// guarantee, so the reader resolving through `IN (...)` is the last
			// line of defence: the results view shows each case once regardless
			// of what the ledger recorded.
			const cases = await getTestCaseDraftJobResultCases({
				projectId: PROJECT_ID,
				caseIds: [caseId, caseId, caseId],
			});
			expect(cases).toHaveLength(1);
			expect(cases[0].id).toBe(caseId);
		});

		it("drops case ids belonging to another project", async () => {
			const mine = await seedCase({ title: "In-project case" });
			const foreign = await seedCase({
				projectId: OTHER_PROJECT_ID,
				title: "Foreign project case",
			});

			// The ids come off the job row, but the project is re-asserted so a
			// stale or tampered id can never read a case from another project.
			const cases = await getTestCaseDraftJobResultCases({
				projectId: PROJECT_ID,
				caseIds: [mine, foreign],
			});
			expect(cases.map((c) => c.id)).toEqual([mine]);
		});

		it("drops case ids that were deleted after the run", async () => {
			const kept = await seedCase({ title: "Kept case", order: 911 });
			const removed = await seedCase({
				title: "Removed case",
				order: 912,
			});
			await db.testCase.update({
				where: { id: removed },
				data: { deletedAt: new Date() },
			});

			// A run's batch is a historical record; cases deleted since then fall
			// out rather than resurrecting in the results view.
			const cases = await getTestCaseDraftJobResultCases({
				projectId: PROJECT_ID,
				caseIds: [kept, removed],
			});
			expect(cases.map((c) => c.id)).toEqual([kept]);
		});

		describe("claimTestCaseDraftJob (atomic overlap claim)", () => {
			/** Every claim in one call, so tests read as intent. */
			function claim(storyIds: string[]) {
				return claimTestCaseDraftJob({
					projectId: PROJECT_ID,
					organizationId: ORG_ID,
					userId: USER_ID,
					requestedById: USER_ID,
					storyIds,
				});
			}

			/** A claim that must win — narrows away the blocked branch. */
			async function claimWon(storyIds: string[]) {
				const result = await claim(storyIds);
				if (!result.job) {
					throw new Error(
						`claim unexpectedly blocked: ${result.blockedStoryIds}`,
					);
				}
				return result.job;
			}

			it("two truly concurrent claims for the same feature — exactly one wins", async () => {
				// THE race the claim exists to close: the procedure's old
				// check-then-create was two statements, so a ~same-instant pair
				// both passed the check and both created — duplicate billing,
				// duplicate cases. Only a real database can prove the advisory
				// lock serializes them: the loser must block until the winner
				// commits and then see its row.
				const storyId = `race-story-${RUN_ID}`;
				const [a, b] = await Promise.all([
					claim([storyId]),
					claim([storyId]),
				]);

				const winners = [a, b].filter((r) => r.job);
				const losers = [a, b].filter((r) => r.blockedStoryIds);
				expect(winners).toHaveLength(1);
				expect(losers).toHaveLength(1);
				expect(losers[0]?.blockedStoryIds).toEqual([storyId]);

				// Exactly one row exists — the loser created nothing.
				const rows = await db.testCaseDraftJob.count({
					where: {
						projectId: PROJECT_ID,
						storyIds: { has: storyId },
					},
				});
				expect(rows).toBe(1);
			});

			it("blocks overlap with an active run and names only the overlapping ids", async () => {
				const active = `blocked-story-${RUN_ID}`;
				const free = `free-story-${RUN_ID}`;
				const first = await claim([active]);
				expect(first.job).toBeDefined();

				// A second claim overlapping the active feature reports JUST the
				// overlap — the caller needs the exact ids to name the blockers.
				const second = await claim([active, free]);
				expect(second.job).toBeUndefined();
				expect(second.blockedStoryIds).toEqual([active]);
			});

			it("allows a run over different features while another is active", async () => {
				// The guard blocks OVERLAP, not parallelism — drafting feature B
				// while feature A's run is active stays legal.
				const a = await claim([`parallel-a-${RUN_ID}`]);
				const b = await claim([`parallel-b-${RUN_ID}`]);
				expect(a.job).toBeDefined();
				expect(b.job).toBeDefined();
			});

			it("stops blocking once the active run reaches a terminal status", async () => {
				const storyId = `terminal-story-${RUN_ID}`;
				const first = await claimWon([storyId]);
				await cancelTestCaseDraftJob({
					jobId: first.id,
					projectId: PROJECT_ID,
				});

				const second = await claim([storyId]);
				expect(second.job).toBeDefined();
			});

			it("ignores a stale active row — a stuck job must not block the project forever", async () => {
				// A PENDING row the worker never picked up stays active
				// indefinitely (only activities advance it, and cancel is
				// requester-scoped). The claim only honours rows younger than the
				// worst legitimate run.
				const storyId = `stale-story-${RUN_ID}`;
				const stuck = await claimWon([storyId]);
				await db.testCaseDraftJob.update({
					where: { id: stuck.id },
					data: {
						createdAt: new Date(
							Date.now() - STALE_ACTIVE_DRAFT_JOB_MS - 60_000,
						),
					},
				});

				const fresh = await claim([storyId]);
				expect(fresh.job).toBeDefined();
			});
		});
	},
);
