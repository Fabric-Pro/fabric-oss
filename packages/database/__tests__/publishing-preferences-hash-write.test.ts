import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../index";
import {
	getLastCountedPublishingRunPreferencesHash,
	getLastCountedPublishingRuns,
} from "../prisma/queries/projects/publishing-last-run";
import { persistCycleTerminal } from "../prisma/queries/projects/publishing-suite";
import {
	buildPublishingPreferencesSnapshot,
	computePublishingPreferencesHash,
} from "../src/publishing-preferences";

// REAL-DB integration test. Its whole point is that the raw-SQL "counts as a
// run" predicate and its TypeScript twin agree against a real Postgres, which
// no mock can answer. Gated on RUN_DB_INTEGRATION exactly like the sibling
// publishing-*.test.ts files — db-integration.yml sets that variable and
// nothing else, so a DATABASE_URL-keyed gate would self-skip in the very job
// meant to run it, which is a false pass rather than a missing run.
const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";
const projectIds: string[] = [];
const createdUserIds: string[] = [];

const PREFS_A = buildPublishingPreferencesSnapshot({ lookbackDays: 30 });
const PREFS_B = buildPublishingPreferencesSnapshot({ lookbackDays: 90 });
const HASH_A = computePublishingPreferencesHash(PREFS_A);
const HASH_B = computePublishingPreferencesHash(PREFS_B);

async function seedPersonalProject(name: string) {
	const user = await db.user.create({
		data: {
			id: `pub-prefhash-${randomUUID()}`,
			name: "pub-prefhash",
			email: `pub-prefhash-${randomUUID()}@test.local`,
			emailVerified: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	createdUserIds.push(user.id);
	// persistCycleTerminal re-validates the project's CURRENT eligibility
	// (status ACTIVE, deletedAt null) inside its transaction, so the fixture has
	// to match what a real dispatch would have produced.
	const project = await db.project.create({
		data: {
			name,
			userId: user.id,
			status: "ACTIVE",
			techStack: [],
			features: [],
			tags: [],
		},
	});
	projectIds.push(project.id);
	return { project, user };
}

/**
 * `startedAt` is a parameter rather than a default because two of the cases
 * below are entirely about the ORDER of two counted cycles, and the reader
 * orders by this column explicitly. A test whose ordering came from insertion
 * order would prove nothing about a query that does not read insertion order.
 */
async function seedGeneratingCycle(input: {
	projectId: string;
	actorUserId: string;
	tenant: { organizationId: string | null; userId: string | null };
	startedAt?: Date;
}) {
	return await db.publishingSuggestionCycle.create({
		data: {
			projectId: input.projectId,
			organizationId: input.tenant.organizationId,
			userId: input.tenant.userId,
			status: "GENERATING",
			actorUserId: input.actorUserId,
			coveredThrough: new Date(),
			...(input.startedAt ? { startedAt: input.startedAt } : {}),
			// publishing_suggestion_cycle_generating_timeout requires a GENERATING
			// row to carry an execution timeout.
			executionTimeoutAt: new Date(Date.now() + 3_600_000),
		},
	});
}

const buildTopic = (projectId: string) => ({
	title: "T",
	pitch: "P",
	dedupeKey: `${projectId}:t`,
	provenance: {},
	suggestedPostTypes: [],
	contributorUserIds: [],
	relevantFunctionTags: [],
	postTypeRecommendations: [],
});

afterAll(async () => {
	if (!RUN_DB) {
		return;
	}
	await db.publishingTopic.deleteMany({
		where: { projectId: { in: projectIds } },
	});
	await db.publishingSuggestionCycle.deleteMany({
		where: { projectId: { in: projectIds } },
	});
	await db.project.deleteMany({ where: { id: { in: projectIds } } });
	await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

const CASES = [
	{ kind: "SUGGESTIONS", topics: 1, failures: {}, counts: true },
	{ kind: "SUGGESTIONS", topics: 0, failures: {}, counts: true },
	{
		kind: "SUGGESTIONS",
		topics: 1,
		failures: { releases: "x" },
		counts: true,
	},
	{ kind: "INSUFFICIENT_CONTEXT", topics: 0, failures: {}, counts: true },
	{
		kind: "INSUFFICIENT_CONTEXT",
		topics: 0,
		failures: { pullRequests: "x" },
		counts: false,
	},
] as const;

describe("persistCycleTerminal preferences hash", () => {
	for (const [i, c] of CASES.entries()) {
		it.skipIf(!RUN_DB)(
			`records a hash exactly when the terminal counts as a run: ${c.kind} topics=${c.topics} dirty=${Object.keys(c.failures).length > 0}`,
			async () => {
				const { project, user } = await seedPersonalProject(
					`prefhash-${i}`,
				);
				const cycle = await seedGeneratingCycle({
					projectId: project.id,
					actorUserId: user.id,
					tenant: { organizationId: null, userId: user.id },
				});

				await persistCycleTerminal({
					cycleId: cycle.id,
					kind: c.kind,
					topics: c.topics === 0 ? [] : [buildTopic(project.id)],
					sourceCoverage: {},
					sourceFailures: c.failures,
					tenant: {
						projectId: project.id,
						organizationId: null,
						userId: user.id,
					},
					preferences: PREFS_A,
				});

				const row =
					await db.publishingSuggestionCycle.findUniqueOrThrow({
						where: { id: cycle.id },
						select: { preferencesHash: true },
					});
				expect(row.preferencesHash).toBe(c.counts ? HASH_A : null);

				// The pin: a hash is present on exactly the cycles the CADENCE
				// reader counts. These are two independent encodings of one rule
				// — SQL there, TypeScript in this writer — and this is the only
				// place they meet.
				const counted = await getLastCountedPublishingRuns([
					project.id,
				]);
				expect(counted.has(project.id)).toBe(c.counts);
				expect(row.preferencesHash !== null).toBe(
					counted.has(project.id),
				);
			},
		);
	}

	it.skipIf(!RUN_DB)(
		"derives the stored hash from the snapshot, not from a value the caller chose",
		async () => {
			const { project, user } =
				await seedPersonalProject("prefhash-derived");
			const cycle = await seedGeneratingCycle({
				projectId: project.id,
				actorUserId: user.id,
				tenant: { organizationId: null, userId: user.id },
			});

			await persistCycleTerminal({
				cycleId: cycle.id,
				kind: "SUGGESTIONS",
				topics: [],
				sourceCoverage: {},
				sourceFailures: {},
				tenant: {
					projectId: project.id,
					organizationId: null,
					userId: user.id,
				},
				preferences: PREFS_B,
			});

			const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
				where: { id: cycle.id },
				select: { preferencesHash: true },
			});
			expect(row.preferencesHash).toBe(HASH_B);
			expect(row.preferencesHash).not.toBe(HASH_A);
		},
	);

	it.skipIf(!RUN_DB)(
		"backfills a null hash when a replay re-terminalizes an already-terminal counted cycle",
		async () => {
			// The rolling-deploy sequence: a worker that predates this slice
			// commits the terminal with no hash, the activity is retried, and the
			// retry lands on a current worker. The replay-recovery path returns
			// persisted:true WITHOUT a second CAS, so without an explicit backfill
			// the cycle stays counted-and-hashless — and every later due dispatch
			// reads null, treats the preferences as changed, and spends another
			// forced run.
			const { project, user } =
				await seedPersonalProject("prefhash-replay");
			const tenant = { organizationId: null, userId: user.id };
			const cycle = await seedGeneratingCycle({
				projectId: project.id,
				actorUserId: user.id,
				tenant,
			});

			// Terminal written by an "old worker" — no preferences at all.
			await persistCycleTerminal({
				cycleId: cycle.id,
				kind: "SUGGESTIONS",
				topics: [],
				sourceCoverage: {},
				sourceFailures: {},
				tenant: { projectId: project.id, ...tenant },
			});

			// The retry, on a current worker.
			const replay = await persistCycleTerminal({
				cycleId: cycle.id,
				kind: "SUGGESTIONS",
				topics: [],
				sourceCoverage: {},
				sourceFailures: {},
				tenant: { projectId: project.id, ...tenant },
				preferences: PREFS_A,
			});

			expect(replay.persisted).toBe(true);
			await expect(
				getLastCountedPublishingRunPreferencesHash(project.id, tenant),
			).resolves.toBe(HASH_A);
		},
	);

	it.skipIf(!RUN_DB)(
		"backfills the INSUFFICIENT_CONTEXT replay path too, but only when it was clean",
		async () => {
			// Two independent recovery branches exist, and a fix applied to one
			// is not a fix applied to the other. The dirty half also pins that
			// the backfill respects the counts-as-a-run rule rather than filling
			// any null it finds.
			for (const [suffix, failures, expected] of [
				["clean", {}, HASH_A],
				["dirty", { pullRequests: "x" }, null],
			] as const) {
				const { project, user } = await seedPersonalProject(
					`prefhash-replay-insuf-${suffix}`,
				);
				const tenant = { organizationId: null, userId: user.id };
				const cycle = await seedGeneratingCycle({
					projectId: project.id,
					actorUserId: user.id,
					tenant,
				});

				const base = {
					cycleId: cycle.id,
					kind: "INSUFFICIENT_CONTEXT" as const,
					topics: [],
					sourceCoverage: {},
					sourceFailures: failures,
					tenant: { projectId: project.id, ...tenant },
				};
				await persistCycleTerminal(base);
				await persistCycleTerminal({ ...base, preferences: PREFS_A });

				const row =
					await db.publishingSuggestionCycle.findUniqueOrThrow({
						where: { id: cycle.id },
						select: { preferencesHash: true },
					});
				expect(row.preferencesHash).toBe(expected);
			}
		},
	);

	it.skipIf(!RUN_DB)(
		"never overwrites a hash that is already recorded",
		async () => {
			// The backfill fills nulls. If it could overwrite, a replay carrying a
			// different snapshot would rewrite history and silently settle a
			// mismatch that the recorded run never actually applied.
			const { project, user } = await seedPersonalProject(
				"prefhash-nooverwrite",
			);
			const tenant = { organizationId: null, userId: user.id };
			const cycle = await seedGeneratingCycle({
				projectId: project.id,
				actorUserId: user.id,
				tenant,
			});

			const base = {
				cycleId: cycle.id,
				kind: "SUGGESTIONS" as const,
				topics: [],
				sourceCoverage: {},
				sourceFailures: {},
				tenant: { projectId: project.id, ...tenant },
			};
			await persistCycleTerminal({ ...base, preferences: PREFS_A });
			await persistCycleTerminal({ ...base, preferences: PREFS_B });

			const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
				where: { id: cycle.id },
				select: { preferencesHash: true },
			});
			expect(row.preferencesHash).toBe(HASH_A);
		},
	);

	it.skipIf(!RUN_DB)(
		"reads the NEWEST counted cycle, even when that one carries no hash",
		async () => {
			// The ancestor-hash trap, at the layer that can actually stage it: an
			// older hash-bearing cycle behind a newer counted null-hash one.
			const { project, user } =
				await seedPersonalProject("prefhash-ancestor");
			const tenant = { organizationId: null, userId: user.id };

			const older = await seedGeneratingCycle({
				projectId: project.id,
				actorUserId: user.id,
				tenant,
				startedAt: new Date("2026-01-01T00:00:00.000Z"),
			});
			await persistCycleTerminal({
				cycleId: older.id,
				kind: "SUGGESTIONS",
				topics: [],
				sourceCoverage: {},
				sourceFailures: {},
				tenant: { projectId: project.id, ...tenant },
				preferences: PREFS_A,
			});

			const newer = await seedGeneratingCycle({
				projectId: project.id,
				actorUserId: user.id,
				tenant,
				startedAt: new Date("2026-02-01T00:00:00.000Z"),
			});
			await persistCycleTerminal({
				cycleId: newer.id,
				kind: "SUGGESTIONS",
				topics: [],
				sourceCoverage: {},
				sourceFailures: {},
				tenant: { projectId: project.id, ...tenant },
				// No preferences — an older worker terminalized this one.
			});

			await expect(
				getLastCountedPublishingRunPreferencesHash(project.id, tenant),
			).resolves.toBeNull();
		},
	);

	it.skipIf(!RUN_DB)(
		"ignores a cycle that did NOT count as a run when answering",
		async () => {
			const { project, user } = await seedPersonalProject(
				"prefhash-dirty-read",
			);
			const tenant = { organizationId: null, userId: user.id };

			const counted = await seedGeneratingCycle({
				projectId: project.id,
				actorUserId: user.id,
				tenant,
				startedAt: new Date("2026-01-01T00:00:00.000Z"),
			});
			await persistCycleTerminal({
				cycleId: counted.id,
				kind: "SUGGESTIONS",
				topics: [],
				sourceCoverage: {},
				sourceFailures: {},
				tenant: { projectId: project.id, ...tenant },
				preferences: PREFS_A,
			});

			const dirty = await seedGeneratingCycle({
				projectId: project.id,
				actorUserId: user.id,
				tenant,
				startedAt: new Date("2026-02-01T00:00:00.000Z"),
			});
			await persistCycleTerminal({
				cycleId: dirty.id,
				kind: "INSUFFICIENT_CONTEXT",
				topics: [],
				sourceCoverage: {},
				sourceFailures: { pullRequests: "source incomplete" },
				tenant: { projectId: project.id, ...tenant },
				preferences: PREFS_B,
			});

			// The dirty cycle is retried tomorrow rather than counted, so it must
			// not answer for the project — otherwise a collector outage would
			// settle a mismatch that was never applied.
			await expect(
				getLastCountedPublishingRunPreferencesHash(project.id, tenant),
			).resolves.toBe(HASH_A);
		},
	);

	it.skipIf(!RUN_DB)(
		"writes no hash when the caller supplies no preferences",
		async () => {
			const { project, user } =
				await seedPersonalProject("prefhash-absent");
			const cycle = await seedGeneratingCycle({
				projectId: project.id,
				actorUserId: user.id,
				tenant: { organizationId: null, userId: user.id },
			});

			await persistCycleTerminal({
				cycleId: cycle.id,
				kind: "SUGGESTIONS",
				topics: [],
				sourceCoverage: {},
				sourceFailures: {},
				tenant: {
					projectId: project.id,
					organizationId: null,
					userId: user.id,
				},
			});

			const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
				where: { id: cycle.id },
				select: { preferencesHash: true },
			});
			expect(row.preferencesHash).toBeNull();
		},
	);
});
