import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { db } from "../index"; // package root barrel (what consumers import as @repo/database)
import { PrismaClient } from "../prisma/generated/client";
import { saveAnalysisRevision } from "../prisma/queries/projects/publishing-analysis-revision";
import { getEffectivePlanningAnalysis } from "../prisma/queries/projects/publishing-planning";
// INTERNAL by design (absent from the queries barrel), so it is imported by
// path. Only a real server can produce the error shape it reads, so this is the
// one place its answer about THIS table's constraint can be proved.
import { uniqueViolationConstraint } from "../prisma/queries/projects/publishing-tenant-lock";

/**
 * Real-database tests for the analysis revision writer (Fizzy #1851).
 *
 * `it.skipIf(!RUN_DB)` gates the CASES; the `afterAll` hook is gated too, with
 * `if (!RUN_DB) return;` as its first line, because a file whose cases all skip
 * still RUNS its hooks — an ungated cleanup would issue `deleteMany` against
 * whatever `DATABASE_URL` happens to be set in the default unit run.
 *
 * Real Postgres rather than a mocked `db`, and not as a matter of taste. Two of
 * the claims here cannot be made against a mock at all:
 *
 *  - the constraint name the writer's catch matches on is produced by Postgres
 *    and this repo's driver adapter, and a fixture asserting it would only
 *    encode the guess that wrote it (see `uniqueViolationConstraint`'s own
 *    docblock, where exactly that mistake is recorded);
 *  - `SELECT … FOR UPDATE` only blocks a second CONNECTION, so the case proving
 *    the project lock is load-bearing needs two clients against one server.
 */
const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";

const createdProjectIds: string[] = [];
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

interface Fixture {
	userId: string;
	orgId: string;
	projectId: string;
	topicId: string;
}

/**
 * An organization project with one topic and one READY analysis at version 1.
 *
 * Organization context on purpose: the tenant-stamping case asserts
 * `userId === null`, which is only a claim about XOR normalisation when the
 * project actually has an organization to normalise away from.
 */
async function makeFixture(label: string): Promise<Fixture> {
	const user = await db.user.create({
		data: {
			id: `rev-${randomUUID()}`,
			name: `analysis-revision-${label}`,
			email: `rev-${randomUUID()}@example.com`,
			emailVerified: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	createdUserIds.push(user.id);

	const org = await db.organization.create({
		data: { name: `example-org-${randomUUID()}`, createdAt: new Date() },
	});
	createdOrgIds.push(org.id);

	const project = await db.project.create({
		data: {
			name: `analysis-revision-${label}`,
			userId: user.id,
			organizationId: org.id,
			// Explicit: `Project.status` defaults to DRAFT, and `lockProjectTenant`
			// refuses anything but ACTIVE. Omitting it makes every case below
			// return `project_ineligible` and prove nothing.
			status: "ACTIVE",
			techStack: [],
			features: [],
			tags: [],
		},
	});
	createdProjectIds.push(project.id);

	const topic = await db.publishingTopic.create({
		data: {
			projectId: project.id,
			organizationId: org.id,
			title: "analysis revision fixture",
			status: "SUGGESTION",
			origin: "MANUAL",
			dedupeKey: `rev:${randomUUID()}`,
		},
	});

	await db.publishingTopicPlanningAnalysis.create({
		data: {
			topicId: topic.id,
			projectId: project.id,
			organizationId: org.id,
			version: 1,
			status: "READY",
			// `topicAngle` (a PROSE field) and `contentTypes` (a DATA field) are
			// both real keys `effectivePlanningAnalysis` / `splitAnalysis` look
			// for — a fixture shaped like `{ summary: ... }` would render an
			// empty prose and undefined data, proving nothing about either half.
			content: {
				topicAngle: `Topic angle for ${label}.`,
				contentTypes: ["blog_post"],
			},
		},
	});

	return {
		userId: user.id,
		orgId: org.id,
		projectId: project.id,
		topicId: topic.id,
	};
}

let primary: Fixture;
let secondary: Fixture;

beforeAll(async () => {
	if (!RUN_DB) {
		return;
	}
	// Two projects in two DIFFERENT organizations, so the cross-project case
	// below is real: a topic id that names a live row, presented with a project
	// id that also names a live row, and the two disagreeing.
	primary = await makeFixture("primary");
	secondary = await makeFixture("secondary");
});

beforeEach(async () => {
	if (!RUN_DB) {
		return;
	}
	await db.publishingTopicAnalysisRevision.deleteMany({
		where: { topicId: primary.topicId },
	});
});

afterAll(async () => {
	// FIRST LINE, deliberately. `it.skipIf` skips the cases and nothing else;
	// hooks still run, and this one deletes rows.
	if (!RUN_DB) {
		return;
	}
	await db.project.deleteMany({ where: { id: { in: createdProjectIds } } });
	await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
	await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

it.skipIf(!RUN_DB)(
	"writes version 1 when there is no revision yet",
	async () => {
		const r = await saveAnalysisRevision({
			topicId: primary.topicId,
			projectId: primary.projectId,
			body: "first",
			expectedVersion: null,
			sourceAnalysisVersion: 1,
			authorUserId: primary.userId,
		});
		expect(r).toEqual({ status: "saved", version: 1 });
	},
);

it.skipIf(!RUN_DB)(
	"rejects a second writer holding the same expectedVersion",
	async () => {
		await saveAnalysisRevision({
			topicId: primary.topicId,
			projectId: primary.projectId,
			body: "a",
			expectedVersion: null,
			sourceAnalysisVersion: 1,
			authorUserId: primary.userId,
		});
		const second = await saveAnalysisRevision({
			topicId: primary.topicId,
			projectId: primary.projectId,
			body: "b",
			expectedVersion: null,
			sourceAnalysisVersion: 1,
			authorUserId: primary.userId,
		});
		expect(second).toEqual({ status: "conflict" });
	},
);

it.skipIf(!RUN_DB)(
	"rejects an expectedVersion AHEAD of reality instead of skipping version numbers",
	async () => {
		await saveAnalysisRevision({
			topicId: primary.topicId,
			projectId: primary.projectId,
			body: "a",
			expectedVersion: null,
			sourceAnalysisVersion: 1,
			authorUserId: primary.userId,
		});
		// Current is 1. A stale or forged 99 must NOT be honoured: arithmetic on
		// what the client sent would insert version 100 and WIN, because the
		// unique index only rejects a pair that already exists.
		const forged = await saveAnalysisRevision({
			topicId: primary.topicId,
			projectId: primary.projectId,
			body: "b",
			expectedVersion: 99,
			sourceAnalysisVersion: 1,
			authorUserId: primary.userId,
		});
		expect(forged).toEqual({ status: "conflict" });
		const rows = await db.publishingTopicAnalysisRevision.findMany({
			where: { topicId: primary.topicId },
		});
		expect(rows.map((r) => r.version)).toEqual([1]);
	},
);

it.skipIf(!RUN_DB)(
	"refuses a sourceAnalysisVersion that names no READY analysis",
	async () => {
		const r = await saveAnalysisRevision({
			topicId: primary.topicId,
			projectId: primary.projectId,
			body: "x",
			expectedVersion: null,
			sourceAnalysisVersion: 99,
			authorUserId: primary.userId,
		});
		expect(r).toEqual({ status: "unknown_source_version" });
	},
);

it.skipIf(!RUN_DB)(
	"refuses a topic that belongs to a DIFFERENT project",
	async () => {
		const r = await saveAnalysisRevision({
			topicId: primary.topicId,
			projectId: secondary.projectId,
			body: "x",
			expectedVersion: null,
			sourceAnalysisVersion: 1,
			authorUserId: primary.userId,
		});
		expect(r).toEqual({ status: "not_found" });
		// Nothing was written under the OTHER project's identity either.
		const rows = await db.publishingTopicAnalysisRevision.findMany({
			where: { topicId: primary.topicId },
		});
		expect(rows).toHaveLength(0);
	},
);

it.skipIf(!RUN_DB)(
	"stamps the tenant from the LOCKED project row, not from the caller",
	async () => {
		await saveAnalysisRevision({
			topicId: primary.topicId,
			projectId: primary.projectId,
			body: "x",
			expectedVersion: null,
			sourceAnalysisVersion: 1,
			authorUserId: primary.userId,
		});
		const row = await db.publishingTopicAnalysisRevision.findFirst({
			where: { topicId: primary.topicId },
		});
		expect(row?.organizationId).toBe(primary.orgId);
		expect(row?.userId).toBeNull();
	},
);

/**
 * The constraint name in the writer's catch, MEASURED.
 *
 * The writer matches one constraint by name rather than catching every `P2002`,
 * so the string it compares against is load-bearing: get it wrong and the catch
 * silently rethrows every conflict as a 500. `uniqueViolationConstraint`'s own
 * docblock records that its first version was written against a plausible error
 * shape, matched nothing, and passed its unit test because the fixture encoded
 * the same guess — so this asserts against a violation a real server raised.
 */
it.skipIf(!RUN_DB)(
	"names publishing_topic_analysis_revision_topicId_version_key on a real duplicate",
	async () => {
		const row = {
			topicId: primary.topicId,
			projectId: primary.projectId,
			organizationId: primary.orgId,
			version: 1,
			body: "duplicate probe",
			sourceAnalysisVersion: 1,
		};
		await db.publishingTopicAnalysisRevision.create({ data: row });
		let observed: string | null = null;
		try {
			await db.publishingTopicAnalysisRevision.create({ data: row });
		} catch (e) {
			observed = uniqueViolationConstraint(e);
		}
		expect(observed).toBe(
			"publishing_topic_analysis_revision_topicId_version_key",
		);
	},
);

/**
 * The case that proves `lockProjectTenant` is load-bearing.
 *
 * A single-connection test cannot fail for the reason the lock exists, so a
 * later refactor could swap `SELECT … FOR UPDATE` for a plain read with the
 * rest of this file green.
 *
 * INVERTED relative to the obvious shape (hold the save, watch a transfer
 * wait). Holding the lock inside the TEST would mean calling
 * `lockProjectTenant` from the test rather than through `saveAnalysisRevision`,
 * and a mutation that removed the lock from the WRITER would leave such a test
 * passing — it would be proving the helper, not the caller. So the transfer
 * holds the row here and the writer is the party that must block: the save
 * cannot settle while the transfer is uncommitted, and once it does settle it
 * carries the tenant the transfer left behind, because the tuple was read after
 * the lock was granted.
 *
 * BOTH assertions discriminate, measured rather than assumed. Swapping
 * `lockProjectTenant` for an unlocked `tx.project.findFirst` in the writer
 * reddens the pending-save assertion (`settled` is already true at the 400 ms
 * mark) AND the tenant-stamp assertion (the row carries the pre-transfer
 * organization). Both were observed in a single run with `expect.soft`; under
 * the hard assertions shipped here the first one aborts the case, so a mutation
 * run reports the pending-save failure alone and the tenant stamp is reached
 * again only once the fence is restored.
 *
 * That is true ONLY because the transfer holds the row with a bare UPDATE — see
 * the comment on it, and do not add a lock there. An earlier revision of this
 * case ran `SELECT … FOR UPDATE` before the UPDATE, and under that shape the
 * pending-save assertion passed even for a writer holding no lock at all: the
 * revision insert's foreign key onto `project` takes FOR KEY SHARE, and a held
 * FOR UPDATE blocks that too, so the unlocked writer waited for a reason that
 * had nothing to do with the code under test. One assertion did the work and
 * the other only looked like it did.
 */
it.skipIf(!RUN_DB)(
	"blocks the save behind a concurrent tenant transfer and stamps the post-transfer tenant",
	async () => {
		// Its own project: this case moves it to another organization for good.
		const fx = await makeFixture("lock");
		const other = new PrismaClient({
			adapter: new PrismaPg({
				connectionString: process.env.DATABASE_URL as string,
			}),
		});

		try {
			let releaseTransfer!: () => void;
			const transferHeld = new Promise<void>((r) => {
				releaseTransfer = r;
			});
			let transferLocked!: () => void;
			const transferReady = new Promise<void>((r) => {
				transferLocked = r;
			});

			// B: move the project to another organization, then sit on the open
			// transaction.
			//
			// A BARE UPDATE, deliberately, with no `SELECT … FOR UPDATE` in front
			// of it. `organizationId` appears in no non-partial unique index on
			// `project`, so the UPDATE takes FOR NO KEY UPDATE — and against this
			// schema that was measured, not looked up: with only this statement
			// held open, a competing `FOR KEY SHARE` acquires immediately while a
			// competing `FOR UPDATE` blocks. Those are exactly the two locks in
			// play — FOR KEY SHARE is what the revision insert's foreign key onto
			// `project` takes, FOR UPDATE is what `lockProjectTenant` takes — so
			// this shape leaves the writer's own lock as the only thing that can
			// hold the save back. Locking the row here first would block the
			// foreign-key check too, and the fence assertion below would then pass
			// for a writer holding no lock.
			const transferring = other.$transaction(
				async (otx) => {
					await otx.$executeRaw`UPDATE "project" SET "organizationId" = ${secondary.orgId} WHERE "id" = ${fx.projectId}`;
					transferLocked();
					await transferHeld;
				},
				{ timeout: 20_000, maxWait: 20_000 },
			);
			await transferReady;

			// A: the writer. It must WAIT on B's row lock.
			let settled = false;
			const saving = saveAnalysisRevision({
				topicId: fx.topicId,
				projectId: fx.projectId,
				body: "written across a transfer",
				expectedVersion: null,
				sourceAnalysisVersion: 1,
				authorUserId: fx.userId,
			}).then((r) => {
				settled = true;
				return r;
			});

			await new Promise((r) => setTimeout(r, 400));
			// The fence, first half. Measured: with `lockProjectTenant` swapped
			// for an unlocked read the writer has already settled by this point —
			// it read straight past the uncommitted transfer, and the foreign-key
			// check did not stop it, because FOR KEY SHARE does not conflict with
			// the bare UPDATE above.
			expect(settled).toBe(false);

			releaseTransfer();
			await transferring;
			expect(await saving).toEqual({ status: "saved", version: 1 });

			// The tuple was read AFTER the lock was granted, so it is the truth the
			// transfer committed — not the stale one an unlocked read would have
			// captured before it.
			const row = await db.publishingTopicAnalysisRevision.findFirst({
				where: { topicId: fx.topicId },
			});
			expect(row?.organizationId).toBe(secondary.orgId);
			expect(row?.userId).toBeNull();
		} finally {
			await other.$disconnect();
		}
	},
);

/**
 * A second READY analysis, layered onto a fixture's existing topic.
 *
 * Only the "stale body" case below needs a topic with two AI versions, and
 * building that through `saveAnalysisRevision` or a second `makeFixture` call
 * would either be the wrong table or a parallel topic that proves nothing
 * about ONE topic's history advancing past a saved revision.
 */
async function seedReadyAnalysis(input: {
	topicId: string;
	projectId: string;
	version: number;
}): Promise<void> {
	const topic = await db.publishingTopic.findFirstOrThrow({
		where: { id: input.topicId, projectId: input.projectId },
		select: { organizationId: true },
	});
	await db.publishingTopicPlanningAnalysis.create({
		data: {
			topicId: input.topicId,
			projectId: input.projectId,
			organizationId: topic.organizationId,
			version: input.version,
			status: "READY",
			content: {
				topicAngle: `Revised topic angle, v${input.version}.`,
				contentTypes: ["case_study"],
			},
		},
	});
}

/**
 * `getEffectivePlanningAnalysis` — the one reader every consumer of a topic's
 * analysis goes through (Fizzy #1851). These four cases sit after the writer
 * cases above rather than in their own file because they exercise the same
 * fixtures and the same `beforeEach` revision cleanup.
 */

it.skipIf(!RUN_DB)(
	"resolves the AI prose when nothing was edited",
	async () => {
		const r = await getEffectivePlanningAnalysis({
			topicId: primary.topicId,
			projectId: primary.projectId,
		});
		expect(r.effective?.overridden).toBe(false);
		expect(r.effective?.prose).toContain("Topic angle");
	},
);

it.skipIf(!RUN_DB)(
	"resolves the user's prose once a revision exists",
	async () => {
		await saveAnalysisRevision({
			topicId: primary.topicId,
			projectId: primary.projectId,
			body: "MY WORDS",
			expectedVersion: null,
			sourceAnalysisVersion: 1,
			authorUserId: primary.userId,
		});
		const r = await getEffectivePlanningAnalysis({
			topicId: primary.topicId,
			projectId: primary.projectId,
		});
		expect(r.effective?.prose).toBe("MY WORDS");
		expect(r.effective?.overridden).toBe(true);
		expect(r.effective?.data.contentTypes).toBeDefined();
	},
);

/**
 * The project-scoping case for the reader side.
 *
 * `effective` alone is NOT decisive here: `effectivePlanningAnalysis` returns
 * null whenever the AI half is null, and the AI half IS null for this call
 * regardless of `getCurrentAnalysisRevision`'s scoping — `getLatestPlanningAnalysis`
 * is already project-scoped, so a mismatched (topicId, projectId) pair finds no
 * AI row either way. A scoping bug in `getCurrentAnalysisRevision` alone would
 * hide behind that assertion and leave this case green.
 *
 * `sourceAnalysisVersion`, `revisionVersion` and `author` are read straight off
 * the revision with no such gate, so they are what actually catches
 * `getCurrentAnalysisRevision` dropping `projectId` from its `where` — measured
 * in Step 5 below, where removing it turns all three non-null while `effective`
 * stays null throughout.
 */
it.skipIf(!RUN_DB)(
	"does not resolve a revision belonging to another project",
	async () => {
		await saveAnalysisRevision({
			topicId: primary.topicId,
			projectId: primary.projectId,
			body: "MY WORDS",
			expectedVersion: null,
			sourceAnalysisVersion: 1,
			authorUserId: primary.userId,
		});
		const r = await getEffectivePlanningAnalysis({
			topicId: primary.topicId,
			projectId: secondary.projectId,
		});
		expect(r.effective).toBeNull();
		expect(r.sourceAnalysisVersion).toBeNull();
		expect(r.revisionVersion).toBeNull();
		expect(r.author).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"reports the source version so a caller can detect a stale body",
	async () => {
		await saveAnalysisRevision({
			topicId: primary.topicId,
			projectId: primary.projectId,
			body: "x",
			expectedVersion: null,
			sourceAnalysisVersion: 1,
			authorUserId: primary.userId,
		});
		await seedReadyAnalysis({
			topicId: primary.topicId,
			projectId: primary.projectId,
			version: 2,
		});
		const r = await getEffectivePlanningAnalysis({
			topicId: primary.topicId,
			projectId: primary.projectId,
		});
		expect(r.sourceAnalysisVersion).toBe(1);
		expect(r.aiVersion).toBe(2);
	},
);
