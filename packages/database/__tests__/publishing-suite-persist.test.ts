import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { db } from "../index";
import { PublishingTopicPostType } from "../prisma/generated/client";
import {
	createManualPublishingTopic,
	persistCycleTerminal,
} from "../prisma/queries/projects/publishing-suite";
import {
	computeDedupeKey,
	computeSubjectKey,
} from "../src/publishing-suite-schema";

// REAL-DB integration test: persistCycleTerminal's CAS + tenant-binding (F5) + terminal-status
// decision (P8) + coverage-commit gating (P5) all depend on real Postgres transaction semantics
// (updateMany affected-row counts, unique-index skipDuplicates) that cannot be faithfully mocked.
// Gated on RUN_DB_INTEGRATION like the sibling publishing-suite-*.test.ts files, so the no-Postgres
// unit run SKIPS it; it runs only in the db-integration CI job.
const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";
const projectIds: string[] = [];
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

async function seedCycle(status: "GENERATING" | "FAILED") {
	// A dedicated user (not db.user.findFirstOrThrow()) — the db-integration CI job runs against a
	// fresh, unseeded Postgres, and sibling suites delete their own fixture users in afterAll, so
	// relying on "some other row exists" is order-dependent and can 404 in CI. User has no defaults
	// on name/email/emailVerified/createdAt/updatedAt, so supply them explicitly (schema.prisma).
	const user = await db.user.create({
		data: {
			id: `pub-persist-${randomUUID()}`,
			name: "pub-suite-persist",
			email: `pub-persist-${randomUUID()}@test.local`,
			emailVerified: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	createdUserIds.push(user.id);
	// F1: persistCycleTerminal now re-validates the Project's CURRENT eligibility (mirrors
	// find-eligible-projects.ts's sweep filter: status ACTIVE, deletedAt null) before writing —
	// a real cycle is only ever dispatched for an ACTIVE project, so fixtures must match that
	// reality for the happy-path assertions below to exercise the intended code paths.
	const project = await db.project.create({
		data: {
			name: "persist",
			userId: user.id,
			status: "ACTIVE",
			techStack: [],
			features: [],
			tags: [],
		},
	});
	projectIds.push(project.id);
	const cycle = await db.publishingSuggestionCycle.create({
		data: {
			projectId: project.id,
			userId: user.id,
			status,
			actorUserId: user.id,
			coveredThrough: new Date(),
			// Task 0's CHECK constraint (publishing_suggestion_cycle_generating_timeout) requires a
			// GENERATING row to carry executionTimeoutAt; set it unconditionally since terminal
			// states tolerate a non-null value too.
			executionTimeoutAt: new Date(Date.now() + 3_600_000),
		},
	});
	return { project, user, cycle };
}
const tenantOf = (p: { id: string }, u: { id: string }) => ({
	projectId: p.id,
	organizationId: null,
	userId: u.id,
});

it.skipIf(!RUN_DB)(
	"inserts topics + sets READY when cycle is GENERATING",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		const res = await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "SUGGESTIONS",
			topics: [
				{
					title: "T",
					pitch: "P",
					dedupeKey: `${project.id}:t`,
					provenance: {},
					suggestedPostTypes: [],
					contributorUserIds: [],
					relevantFunctionTags: [],
					postTypeRecommendations: [],
				},
			],
			sourceCoverage: { stories: new Date().toISOString() },
			sourceFailures: {},
			tenant: tenantOf(project, user),
		});
		expect(res).toEqual({ persisted: true, status: "READY" });
		expect(
			await db.publishingTopic.count({ where: { cycleId: cycle.id } }),
		).toBe(1);
	},
);

it.skipIf(!RUN_DB)(
	"sets NO_TOPICS when every generated key is already owned (P8)",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		// A manual topic already owns the dedupeKey.
		await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: user.id,
				title: "M",
				status: "SELECTED",
				origin: "MANUAL",
				dedupeKey: `${project.id}:dup`,
			},
		});
		const res = await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "SUGGESTIONS",
			topics: [
				{
					title: "T",
					pitch: "P",
					dedupeKey: `${project.id}:dup`,
					provenance: {},
					suggestedPostTypes: [],
					contributorUserIds: [],
					relevantFunctionTags: [],
					postTypeRecommendations: [],
				},
			],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(project, user),
		});
		expect(res).toEqual({ persisted: true, status: "NO_TOPICS" });
	},
);

it.skipIf(!RUN_DB)(
	"writes NO topics and no coverage when the cycle is no longer GENERATING (CAS loses)",
	async () => {
		const { project, user, cycle } = await seedCycle("FAILED");
		const res = await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "SUGGESTIONS",
			topics: [
				{
					title: "T",
					pitch: "P",
					dedupeKey: `${project.id}:t2`,
					provenance: {},
					suggestedPostTypes: [],
					contributorUserIds: [],
					relevantFunctionTags: [],
					postTypeRecommendations: [],
				},
			],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(project, user),
		});
		expect(res.persisted).toBe(false);
		expect(
			await db.publishingTopic.count({ where: { cycleId: cycle.id } }),
		).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"no-ops when the supplied tenant does not own the cycle (F5)",
	async () => {
		const { project, cycle } = await seedCycle("GENERATING"); // cycle belongs to `project`
		const other = await seedCycle("GENERATING"); // a DIFFERENT project + owner
		const res = await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "SUGGESTIONS",
			topics: [
				{
					title: "X",
					pitch: "P",
					dedupeKey: `${project.id}:f5`,
					provenance: {},
					suggestedPostTypes: [],
					contributorUserIds: [],
					relevantFunctionTags: [],
					postTypeRecommendations: [],
				},
			],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(other.project, other.user), // WRONG tenant (points at project B)
		});
		expect(res.persisted).toBe(false);
		expect(
			await db.publishingTopic.count({ where: { cycleId: cycle.id } }),
		).toBe(0);
		// the real cycle is left GENERATING (untouched) — no cross-tenant write or transition
		const row = await db.publishingSuggestionCycle.findUnique({
			where: { id: cycle.id },
			select: { status: true },
		});
		expect(row?.status).toBe("GENERATING");
	},
);

it.skipIf(!RUN_DB)(
	"no-ops when the Project transfers org between the workflow's start-time assertion and persist (F1 TOCTOU)",
	async () => {
		const user = await db.user.create({
			data: {
				id: `pub-persist-${randomUUID()}`,
				name: "pub-suite-persist-f1",
				email: `pub-persist-${randomUUID()}@test.local`,
				emailVerified: false,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		createdUserIds.push(user.id);
		const orgA = await db.organization.create({
			data: {
				name: `pub-persist-org-a-${randomUUID()}`,
				createdAt: new Date(),
			},
		});
		const orgB = await db.organization.create({
			data: {
				name: `pub-persist-org-b-${randomUUID()}`,
				createdAt: new Date(),
			},
		});
		createdOrgIds.push(orgA.id, orgB.id);
		// status ACTIVE so the ONLY reason this no-ops is the tenant-tuple mismatch below,
		// isolating the F1 re-validation from the separate eligibility check.
		const project = await db.project.create({
			data: {
				name: "persist-f1",
				userId: user.id,
				organizationId: orgA.id,
				status: "ACTIVE",
				techStack: [],
				features: [],
				tags: [],
			},
		});
		projectIds.push(project.id);
		// Cycle carries a DENORMALIZED snapshot of the org-A tuple, captured at creation —
		// this is what the F5 cycle-tuple check (above) validates against, and it never
		// changes when the Project's live organizationId later moves.
		const cycle = await db.publishingSuggestionCycle.create({
			data: {
				projectId: project.id,
				organizationId: orgA.id,
				status: "GENERATING",
				actorUserId: user.id,
				coveredThrough: new Date(),
				executionTimeoutAt: new Date(Date.now() + 3_600_000),
			},
		});
		// Simulate a concurrent org transfer landing AFTER the workflow's start-time
		// assertProjectTenantTuple check but BEFORE this persist call.
		await db.project.update({
			where: { id: project.id },
			data: { organizationId: orgB.id },
		});

		const res = await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "SUGGESTIONS",
			topics: [
				{
					title: "T",
					pitch: "P",
					dedupeKey: `${project.id}:f1`,
					provenance: {},
					suggestedPostTypes: [],
					contributorUserIds: [],
					relevantFunctionTags: [],
					postTypeRecommendations: [],
				},
			],
			sourceCoverage: {},
			sourceFailures: {},
			// STALE org-A tuple — still matches the cycle's denormalized snapshot (F5 passes)
			// but no longer matches the Project's CURRENT live tuple (F1 must catch this).
			tenant: {
				projectId: project.id,
				organizationId: orgA.id,
				userId: null,
			},
		});
		expect(res.persisted).toBe(false);
		expect(
			await db.publishingTopic.count({ where: { cycleId: cycle.id } }),
		).toBe(0);
		const row = await db.publishingSuggestionCycle.findUnique({
			where: { id: cycle.id },
			select: { status: true },
		});
		expect(row?.status).toBe("GENERATING");
	},
);

it.skipIf(!RUN_DB)(
	"persists suggestedPostTypes and contributorUserIds on inserted topics",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "SUGGESTIONS",
			topics: [
				{
					title: "Ship X",
					pitch: "we shipped X",
					dedupeKey: `${project.id}:dk-x`,
					provenance: { storyIds: ["s1"] },
					suggestedPostTypes: [
						PublishingTopicPostType.BLOG_POST,
						PublishingTopicPostType.TWEET,
					],
					contributorUserIds: ["u1", "u2"],
					relevantFunctionTags: [],
					postTypeRecommendations: [],
				},
			],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(project, user),
		});
		const row = await db.publishingTopic.findFirst({
			where: { cycleId: cycle.id },
			select: { suggestedPostTypes: true, contributorUserIds: true },
		});
		expect(row?.suggestedPostTypes).toEqual([
			PublishingTopicPostType.BLOG_POST,
			PublishingTopicPostType.TWEET,
		]);
		expect(row?.contributorUserIds).toEqual(["u1", "u2"]);
	},
);

it.skipIf(!RUN_DB)(
	"does NOT advance coverage on INSUFFICIENT_CONTEXT (P5)",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		const res = await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "INSUFFICIENT_CONTEXT",
			topics: [],
			sourceCoverage: { stories: new Date().toISOString() },
			sourceFailures: {},
			tenant: tenantOf(project, user),
		});
		expect(res.status).toBe("INSUFFICIENT_CONTEXT");
		const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: cycle.id },
		});
		expect(row.sourceCoverage).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"persists and reads back relevantFunctionTags and postTypeRecommendations",
	async () => {
		const { project, user } = await seedCycle("GENERATING");
		const topic = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				organizationId: null,
				userId: user.id,
				title: "role-aware round-trip",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: `${project.id}:role-aware-rt`,
				relevantFunctionTags: ["DEVELOPER", "ARCHITECT"],
				postTypeRecommendations: [
					{
						type: "BLOG_POST",
						theme: "engineering deep-dive",
						rationale: "big feature PR",
					},
				],
			},
			select: {
				relevantFunctionTags: true,
				postTypeRecommendations: true,
			},
		});
		expect(topic.relevantFunctionTags).toEqual(["DEVELOPER", "ARCHITECT"]);
		expect(topic.postTypeRecommendations).toEqual([
			{
				type: "BLOG_POST",
				theme: "engineering deep-dive",
				rationale: "big feature PR",
			},
		]);
	},
);

it.skipIf(!RUN_DB)(
	"persists relevantFunctionTags and postTypeRecommendations via persistCycleTerminal (Task 6)",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		const res = await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "SUGGESTIONS",
			topics: [
				{
					title: "Role-aware enrichment topic",
					pitch: "P",
					dedupeKey: `${project.id}:role-aware-persist`,
					provenance: {},
					suggestedPostTypes: [PublishingTopicPostType.BLOG_POST],
					contributorUserIds: [],
					relevantFunctionTags: ["DEVELOPER"],
					postTypeRecommendations: [
						{
							type: PublishingTopicPostType.BLOG_POST,
							theme: "t",
							rationale: "r",
						},
					],
				},
			],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(project, user),
		});
		expect(res).toEqual({ persisted: true, status: "READY" });
		const row = await db.publishingTopic.findFirst({
			where: { cycleId: cycle.id },
			select: {
				relevantFunctionTags: true,
				postTypeRecommendations: true,
			},
		});
		expect(row?.relevantFunctionTags).toEqual(["DEVELOPER"]);
		expect(row?.postTypeRecommendations).toEqual([
			{ type: "BLOG_POST", theme: "t", rationale: "r" },
		]);
	},
);

it.skipIf(!RUN_DB)(
	"stamps relevantFunctionTags and postTypeRecommendations as empty on a MANUAL topic (Task 6 / I5)",
	async () => {
		const { project, user } = await seedCycle("GENERATING");
		const { topic } = await createManualPublishingTopic({
			projectId: project.id,
			createdById: user.id,
			title: "Manual role-aware topic",
		});
		const row = await db.publishingTopic.findUnique({
			where: { id: topic.id },
			select: {
				relevantFunctionTags: true,
				postTypeRecommendations: true,
			},
		});
		expect(row?.relevantFunctionTags).toEqual([]);
		expect(row?.postTypeRecommendations).toEqual([]);
	},
);

// Local helper: a second GENERATING cycle for an existing project (cross-cycle cases).
async function secondCycle(project: { id: string }, user: { id: string }) {
	return db.publishingSuggestionCycle.create({
		data: {
			projectId: project.id,
			userId: user.id,
			status: "GENERATING",
			actorUserId: user.id,
			coveredThrough: new Date(),
			executionTimeoutAt: new Date(Date.now() + 3_600_000),
		},
	});
}

it.skipIf(!RUN_DB)(
	"persists angle on an inserted AI topic (AC-TA1)",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "SUGGESTIONS",
			tenant: tenantOf(project, user),
			sourceCoverage: {},
			sourceFailures: {},
			topics: [
				{
					title: "Angle-RT-1",
					pitch: "P",
					dedupeKey: `${project.id}:rt1`,
					provenance: {},
					suggestedPostTypes: [],
					contributorUserIds: [],
					relevantFunctionTags: [],
					postTypeRecommendations: [],
					angle: "Engineering deep-dive",
				},
			],
		});
		const row = await db.publishingTopic.findFirst({
			where: { projectId: project.id, dedupeKey: `${project.id}:rt1` },
			select: { angle: true },
		});
		expect(row?.angle).toBe("Engineering deep-dive");
	},
);

it.skipIf(!RUN_DB)(
	"coerces an empty-string angle to null at the write boundary (Copilot)",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "SUGGESTIONS",
			tenant: tenantOf(project, user),
			sourceCoverage: {},
			sourceFailures: {},
			topics: [
				{
					title: "Angle-RT-empty",
					pitch: "P",
					dedupeKey: `${project.id}:rtempty`,
					provenance: {},
					suggestedPostTypes: [],
					contributorUserIds: [],
					relevantFunctionTags: [],
					postTypeRecommendations: [],
					angle: "",
				},
			],
		});
		const row = await db.publishingTopic.findFirst({
			where: {
				projectId: project.id,
				dedupeKey: `${project.id}:rtempty`,
			},
			select: { angle: true },
		});
		expect(row?.angle).toBeNull();
	},
);

it.skipIf(!RUN_DB)("leaves angle null when omitted (AC-TA2)", async () => {
	const { project, user, cycle } = await seedCycle("GENERATING");
	await persistCycleTerminal({
		cycleId: cycle.id,
		kind: "SUGGESTIONS",
		tenant: tenantOf(project, user),
		sourceCoverage: {},
		sourceFailures: {},
		topics: [
			{
				title: "Angle-RT-2",
				pitch: "P",
				dedupeKey: `${project.id}:rt2`,
				provenance: {},
				suggestedPostTypes: [],
				contributorUserIds: [],
				relevantFunctionTags: [],
				postTypeRecommendations: [],
			}, // no angle
		],
	});
	const row = await db.publishingTopic.findFirst({
		where: { projectId: project.id, dedupeKey: `${project.id}:rt2` },
		select: { angle: true },
	});
	expect(row?.angle).toBeNull();
});

it.skipIf(!RUN_DB)(
	"same-dedupeKey different-angle in one batch: first occurrence wins (AC-TA9/D7)",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		const key = `${project.id}:dup`;
		const mk = (angle: string) => ({
			title: "Dup",
			pitch: "P",
			dedupeKey: key,
			provenance: {},
			suggestedPostTypes: [],
			contributorUserIds: [],
			relevantFunctionTags: [],
			postTypeRecommendations: [],
			angle,
		});
		await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "SUGGESTIONS",
			tenant: tenantOf(project, user),
			sourceCoverage: {},
			sourceFailures: {},
			topics: [mk("First angle"), mk("Second angle")],
		});
		const rows = await db.publishingTopic.findMany({
			where: { projectId: project.id, dedupeKey: key },
			select: { angle: true },
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].angle).toBe("First angle");
	},
);

it.skipIf(!RUN_DB)(
	"cross-cycle create-once: an existing angle is not overwritten (AC-TA10)",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		const key = `${project.id}:xc`;
		const mk = (angle: string) => ({
			title: "XC",
			pitch: "P",
			dedupeKey: key,
			provenance: {},
			suggestedPostTypes: [],
			contributorUserIds: [],
			relevantFunctionTags: [],
			postTypeRecommendations: [],
			angle,
		});
		await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "SUGGESTIONS",
			tenant: tenantOf(project, user),
			sourceCoverage: {},
			sourceFailures: {},
			topics: [mk("Original")],
		});
		const cycle2 = await secondCycle(project, user);
		await persistCycleTerminal({
			cycleId: cycle2.id,
			kind: "SUGGESTIONS",
			tenant: tenantOf(project, user),
			sourceCoverage: {},
			sourceFailures: {},
			topics: [mk("Replacement")],
		});
		const rows = await db.publishingTopic.findMany({
			where: { projectId: project.id, dedupeKey: key },
			select: { angle: true },
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].angle).toBe("Original");
	},
);

it.skipIf(!RUN_DB)(
	"cross-cycle create-once: an existing null angle stays null (AC-TA10)",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		const key = `${project.id}:xcnull`;
		const persist = (cycleId: string, angle?: string) =>
			persistCycleTerminal({
				cycleId,
				kind: "SUGGESTIONS",
				tenant: tenantOf(project, user),
				sourceCoverage: {},
				sourceFailures: {},
				topics: [
					{
						title: "XCNull",
						pitch: "P",
						dedupeKey: key,
						provenance: {},
						suggestedPostTypes: [],
						contributorUserIds: [],
						relevantFunctionTags: [],
						postTypeRecommendations: [],
						...(angle ? { angle } : {}),
					},
				],
			});
		await persist(cycle.id); // no angle
		const cycle2 = await secondCycle(project, user);
		await persist(cycle2.id, "Late angle");
		const rows = await db.publishingTopic.findMany({
			where: { projectId: project.id, dedupeKey: key },
			select: { angle: true },
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].angle).toBeNull();
	},
);

// FR9/10 multiplication: a fully-formed persist topic (mirrors the existing
// cases' shape) with subject grouping.
function member(
	project: { id: string },
	title: string,
	angle: string,
	subject: string,
) {
	return {
		title,
		pitch: "p",
		dedupeKey: computeDedupeKey(project.id, title),
		provenance: {},
		suggestedPostTypes: [] as PublishingTopicPostType[],
		contributorUserIds: [] as string[],
		relevantFunctionTags: [],
		postTypeRecommendations: [],
		angle,
		subject,
		subjectKey: computeSubjectKey(project.id, subject),
	};
}

it.skipIf(!RUN_DB)(
	"(a) persists two angle-records for one subject with shared subjectKey, distinct dedupeKey",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		const sk = computeSubjectKey(project.id, "Shipped RLS");
		await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "SUGGESTIONS",
			topics: [
				member(project, "How we built RLS", "eng", "Shipped RLS"),
				member(
					project,
					"Acme passed its audit",
					"customer",
					"Shipped RLS",
				),
			],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(project, user),
		});
		const rows = await db.publishingTopic.findMany({
			where: { cycleId: cycle.id },
			orderBy: { title: "asc" },
		});
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.subject === "Shipped RLS")).toBe(true);
		expect(rows.every((r) => r.subjectKey === sk)).toBe(true);
		expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(2);
	},
);

it.skipIf(!RUN_DB)(
	"(b) a single angled topic persists one row, subject/subjectKey null, byte-identical dedupeKey",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "SUGGESTIONS",
			topics: [
				{
					title: "Solo topic",
					pitch: "p",
					dedupeKey: computeDedupeKey(project.id, "Solo topic"),
					provenance: {},
					suggestedPostTypes: [],
					contributorUserIds: [],
					relevantFunctionTags: [],
					postTypeRecommendations: [],
					angle: "eng",
					subject: null,
					subjectKey: null,
				},
			],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(project, user),
		});
		const row = await db.publishingTopic.findFirstOrThrow({
			where: { cycleId: cycle.id },
		});
		expect(row.subject).toBeNull();
		expect(row.subjectKey).toBeNull();
		expect(row.dedupeKey).toBe(computeDedupeKey(project.id, "Solo topic"));
	},
);

it.skipIf(!RUN_DB)(
	"(c) cross-cycle AI promotion: an existing ungrouped AI row is stamped into the new group",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		// Pre-existing AI singleton with cycleId: null. Only ONE GENERATING cycle per
		// project is allowed (partial unique index), so the pre-existing row must NOT
		// carry its own second GENERATING cycle — null cycleId keeps it out of the way.
		await db.publishingTopic.create({
			data: {
				projectId: project.id,
				organizationId: null,
				userId: user.id,
				cycleId: null,
				title: "How we built RLS",
				pitch: "p",
				status: "SUGGESTION",
				origin: "AI",
				provenance: {},
				dedupeKey: computeDedupeKey(project.id, "How we built RLS"),
				subject: null,
				subjectKey: null,
			},
		});
		await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "SUGGESTIONS",
			topics: [
				member(project, "How we built RLS", "eng", "Shipped RLS"),
				member(
					project,
					"Acme passed its audit",
					"customer",
					"Shipped RLS",
				),
			],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(project, user),
		});
		const sk = computeSubjectKey(project.id, "Shipped RLS");
		const rows = await db.publishingTopic.findMany({
			where: { projectId: project.id, subjectKey: sk },
		});
		expect(rows).toHaveLength(2); // the promoted pre-existing row (create-once-skipped) + the new sibling
		expect(rows.every((r) => r.subject === "Shipped RLS")).toBe(true);
	},
);

it.skipIf(!RUN_DB)(
	"(d) manual-title collision: the manual row is NOT relabelled; the AI sibling stays labelled",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		await db.publishingTopic.create({
			data: {
				projectId: project.id,
				organizationId: null,
				userId: user.id,
				title: "How we built RLS",
				pitch: "p",
				status: "SUGGESTION",
				origin: "MANUAL",
				createdById: user.id,
				provenance: {},
				dedupeKey: computeDedupeKey(project.id, "How we built RLS"),
				subject: null,
				subjectKey: null,
			},
		});
		await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "SUGGESTIONS",
			topics: [
				member(project, "How we built RLS", "eng", "Shipped RLS"),
				member(
					project,
					"Acme passed its audit",
					"customer",
					"Shipped RLS",
				),
			],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(project, user),
		});
		const manual = await db.publishingTopic.findFirstOrThrow({
			where: { projectId: project.id, origin: "MANUAL" },
		});
		expect(manual.subject).toBeNull(); // origin:AI predicate protects it
		const sibling = await db.publishingTopic.findFirstOrThrow({
			where: {
				projectId: project.id,
				origin: "AI",
				title: "Acme passed its audit",
			},
		});
		expect(sibling.subject).toBe("Shipped RLS");
	},
);

it.skipIf(!RUN_DB)(
	"(e) a manual topic (no collision) leaves subject/subjectKey null",
	async () => {
		const { project, user } = await seedCycle("GENERATING");
		const { topic } = await createManualPublishingTopic({
			projectId: project.id,
			createdById: user.id,
			title: "Manual only",
		});
		const row = await db.publishingTopic.findUniqueOrThrow({
			where: { id: topic.id },
		});
		expect(row.subject).toBeNull();
		expect(row.subjectKey).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"(f) re-running the same title dedupes (count 0) and logs the create-once skip",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			const t = [
				{
					title: "Repeat",
					pitch: "p",
					dedupeKey: computeDedupeKey(project.id, "Repeat"),
					provenance: {},
					suggestedPostTypes: [] as PublishingTopicPostType[],
					contributorUserIds: [] as string[],
					relevantFunctionTags: [],
					postTypeRecommendations: [],
					angle: undefined,
					subject: null,
					subjectKey: null,
				},
			];
			await persistCycleTerminal({
				cycleId: cycle.id,
				kind: "SUGGESTIONS",
				topics: t,
				sourceCoverage: {},
				sourceFailures: {},
				tenant: tenantOf(project, user),
			});
			// Only ONE GENERATING cycle per project is allowed (partial unique index);
			// this second cycle is created only AFTER the first persist above has
			// terminalized cycle1 (GENERATING -> READY/NO_TOPICS).
			const cycle2 = await secondCycle(project, user);
			const res = await persistCycleTerminal({
				cycleId: cycle2.id,
				kind: "SUGGESTIONS",
				topics: t,
				sourceCoverage: {},
				sourceFailures: {},
				tenant: tenantOf(project, user),
			});
			expect(res.status).toBe("NO_TOPICS");
			expect(info).toHaveBeenCalledWith(
				expect.stringContaining("create-once"),
				expect.objectContaining({ skipped: 1 }),
			);
		} finally {
			info.mockRestore();
		}
	},
);

it.skipIf(!RUN_DB)(
	"(g) F9 guard: an already-grouped AI row with a colliding title is NOT relabelled by a different subject",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		const skA = computeSubjectKey(project.id, "Subject A");
		// Pre-existing AI row already grouped under Subject A, cycleId: null (one-GENERATING-cycle rule).
		await db.publishingTopic.create({
			data: {
				projectId: project.id,
				organizationId: null,
				userId: user.id,
				cycleId: null,
				title: "How we built RLS",
				pitch: "p",
				status: "SUGGESTION",
				origin: "AI",
				provenance: {},
				dedupeKey: computeDedupeKey(project.id, "How we built RLS"),
				subject: "Subject A",
				subjectKey: skA,
			},
		});
		await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "SUGGESTIONS",
			topics: [
				member(project, "How we built RLS", "eng", "Subject B"),
				member(project, "A different angle", "customer", "Subject B"),
			],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(project, user),
		});
		const old = await db.publishingTopic.findFirstOrThrow({
			where: { projectId: project.id, title: "How we built RLS" },
		});
		expect(old.subject).toBe("Subject A"); // untouched — its subjectKey is non-null, so the subjectKey:null predicate skips it
		expect(old.subjectKey).toBe(skA);
	},
);

it.skipIf(!RUN_DB)(
	"recovers READY when a committed attempt is retried and inserts nothing (1C-2a)",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		const call = {
			cycleId: cycle.id,
			kind: "SUGGESTIONS" as const,
			topics: [
				{
					title: "T",
					pitch: "P",
					dedupeKey: `${project.id}:replay`,
					provenance: {},
					suggestedPostTypes: [],
					contributorUserIds: [],
					relevantFunctionTags: [],
					postTypeRecommendations: [],
				},
			],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(project, user),
		};
		const first = await persistCycleTerminal(call);
		expect(first).toEqual({ persisted: true, status: "READY" });

		// The activity's completion was lost and Temporal retried it: the identical call
		// runs again against a cycle that is already READY and already owns its topics.
		const retry = await persistCycleTerminal(call);
		expect(retry).toEqual({ persisted: true, status: "READY" });

		// The retry must not double-insert.
		expect(
			await db.publishingTopic.count({ where: { cycleId: cycle.id } }),
		).toBe(1);
	},
);

it.skipIf(!RUN_DB)(
	"recovers READY on retry even when some keys were create-once skipped (1C-2a)",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		// A manual topic already owns one of the two keys, so the first attempt inserts
		// only the other one — the mixed case, where `inserted.count` is neither 0 nor N.
		await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: user.id,
				title: "M",
				status: "SELECTED",
				origin: "MANUAL",
				dedupeKey: `${project.id}:owned`,
			},
		});
		const topic = (key: string) => ({
			title: "T",
			pitch: "P",
			dedupeKey: key,
			provenance: {},
			suggestedPostTypes: [],
			contributorUserIds: [],
			relevantFunctionTags: [],
			postTypeRecommendations: [],
		});
		const call = {
			cycleId: cycle.id,
			kind: "SUGGESTIONS" as const,
			topics: [
				topic(`${project.id}:owned`),
				topic(`${project.id}:fresh`),
			],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(project, user),
		};
		expect(await persistCycleTerminal(call)).toEqual({
			persisted: true,
			status: "READY",
		});
		expect(await persistCycleTerminal(call)).toEqual({
			persisted: true,
			status: "READY",
		});
		expect(
			await db.publishingTopic.count({ where: { cycleId: cycle.id } }),
		).toBe(1);
	},
);

it.skipIf(!RUN_DB)(
	"recovers NO_TOPICS on retry of a committed no-topics call (1C-2a)",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: user.id,
				title: "M",
				status: "SELECTED",
				origin: "MANUAL",
				dedupeKey: `${project.id}:allowned`,
			},
		});
		const call = {
			cycleId: cycle.id,
			kind: "SUGGESTIONS" as const,
			topics: [
				{
					title: "T",
					pitch: "P",
					dedupeKey: `${project.id}:allowned`,
					provenance: {},
					suggestedPostTypes: [],
					contributorUserIds: [],
					relevantFunctionTags: [],
					postTypeRecommendations: [],
				},
			],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(project, user),
		};
		expect(await persistCycleTerminal(call)).toEqual({
			persisted: true,
			status: "NO_TOPICS",
		});
		// The retry recomputes NO_TOPICS, finds the cycle already holding exactly that,
		// and reports its own commit rather than SUPERSEDED.
		expect(await persistCycleTerminal(call)).toEqual({
			persisted: true,
			status: "NO_TOPICS",
		});
	},
);

it.skipIf(!RUN_DB)(
	"still reports not-persisted when the cycle was terminalized to a DIFFERENT status (1C-2a)",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		const call = {
			cycleId: cycle.id,
			kind: "SUGGESTIONS" as const,
			topics: [
				{
					title: "T",
					pitch: "P",
					dedupeKey: `${project.id}:reclaimed`,
					provenance: {},
					suggestedPostTypes: [],
					contributorUserIds: [],
					relevantFunctionTags: [],
					postTypeRecommendations: [],
				},
			],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(project, user),
		};
		expect(await persistCycleTerminal(call)).toEqual({
			persisted: true,
			status: "READY",
		});
		// A liveness reclaim terminalizes the cycle to FAILED before the retry lands.
		// The retry inserts nothing, but FAILED is not the status this call computed, so
		// it must NOT be mistaken for this call's own commit.
		await db.publishingSuggestionCycle.update({
			where: { id: cycle.id },
			data: { status: "FAILED" },
		});
		const retry = await persistCycleTerminal(call);
		expect(retry.persisted).toBe(false);
		const row = await db.publishingSuggestionCycle.findUnique({
			where: { id: cycle.id },
			select: { status: true },
		});
		expect(row?.status).toBe("FAILED");
	},
);

it.skipIf(!RUN_DB)(
	"recovers INSUFFICIENT_CONTEXT on retry of a committed call (1C-2a)",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		const call = {
			cycleId: cycle.id,
			kind: "INSUFFICIENT_CONTEXT" as const,
			topics: [],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(project, user),
		};
		expect(await persistCycleTerminal(call)).toEqual({
			persisted: true,
			status: "INSUFFICIENT_CONTEXT",
		});
		expect(await persistCycleTerminal(call)).toEqual({
			persisted: true,
			status: "INSUFFICIENT_CONTEXT",
		});
	},
);

it.skipIf(!RUN_DB)(
	"suppresses recovery when the Project transfers org AFTER a committed attempt (1C-2a boundary)",
	async () => {
		const user = await db.user.create({
			data: {
				id: `pub-persist-${randomUUID()}`,
				name: "pub-suite-persist-xfer",
				email: `pub-persist-${randomUUID()}@test.local`,
				emailVerified: false,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		createdUserIds.push(user.id);
		const orgA = await db.organization.create({
			data: {
				name: `pub-persist-org-a-${randomUUID()}`,
				createdAt: new Date(),
			},
		});
		const orgB = await db.organization.create({
			data: {
				name: `pub-persist-org-b-${randomUUID()}`,
				createdAt: new Date(),
			},
		});
		createdOrgIds.push(orgA.id, orgB.id);
		const project = await db.project.create({
			data: {
				name: "persist-xfer",
				userId: user.id,
				organizationId: orgA.id,
				status: "ACTIVE",
				techStack: [],
				features: [],
				tags: [],
			},
		});
		projectIds.push(project.id);
		const cycle = await db.publishingSuggestionCycle.create({
			data: {
				projectId: project.id,
				organizationId: orgA.id,
				status: "GENERATING",
				actorUserId: user.id,
				coveredThrough: new Date(),
				executionTimeoutAt: new Date(Date.now() + 3_600_000),
			},
		});
		const call = {
			cycleId: cycle.id,
			kind: "SUGGESTIONS" as const,
			topics: [
				{
					title: "T",
					pitch: "P",
					dedupeKey: `${project.id}:xfer`,
					provenance: {},
					suggestedPostTypes: [],
					contributorUserIds: [],
					relevantFunctionTags: [],
					postTypeRecommendations: [],
				},
			],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: {
				projectId: project.id,
				organizationId: orgA.id,
				userId: null,
			},
		};
		// Attempt 1 commits under org A.
		expect(await persistCycleTerminal(call)).toEqual({
			persisted: true,
			status: "READY",
		});

		// The project moves to org B before Temporal retries the lost completion.
		await db.project.update({
			where: { id: project.id },
			data: { organizationId: orgB.id },
		});

		// The retry is stopped by F1 before either recovery path. Deliberate: recovering
		// READY here would let a downstream notification step address org B's members
		// about topics committed under org A.
		const retry = await persistCycleTerminal(call);
		expect(retry.persisted).toBe(false);

		// Nothing was written twice, and the committed terminal state is untouched.
		expect(
			await db.publishingTopic.count({ where: { cycleId: cycle.id } }),
		).toBe(1);
		const row = await db.publishingSuggestionCycle.findUnique({
			where: { id: cycle.id },
			select: { status: true },
		});
		expect(row?.status).toBe("READY");
	},
);

// 1C-2b: `topic(...)` follows the same field shape as the file's other inline topic
// literals (see e.g. the local `topic` helper in the "recovers READY on retry even
// when some keys were create-once skipped" case above) — a fresh closure per test,
// since each test seeds its own project and the dedupeKey must be project-scoped.
it.skipIf(!RUN_DB)(
	"activates the notification lifecycle in the same transaction that sets READY (1C-2b)",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		const topic = (name: string) => ({
			title: `Topic ${name}`,
			pitch: "P",
			dedupeKey: `${project.id}:${name}`,
			provenance: {},
			suggestedPostTypes: [] as PublishingTopicPostType[],
			contributorUserIds: [] as string[],
			relevantFunctionTags: [],
			postTypeRecommendations: [],
		});
		const res = await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "SUGGESTIONS",
			topics: [topic("a")],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(project, user),
			activateNotificationLifecycle: true,
		});
		expect(res).toEqual({ persisted: true, status: "READY" });
		const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: cycle.id },
		});
		expect(row.notificationOutcome).toBe("PENDING");
	},
);

it.skipIf(!RUN_DB)(
	"leaves the cycle at NOT_APPLICABLE when the caller does not ask for activation (1C-2b)",
	async () => {
		// This is the OLD-WORKER case made executable: an older worker on the shared task queue
		// ignores the new input field entirely, so the absent flag must behave exactly as a worker
		// that has never heard of it. A cycle at NOT_APPLICABLE is honestly classified as "never
		// entered the lifecycle" — it is not an incident, and monitoring excludes it.
		const { project, user, cycle } = await seedCycle("GENERATING");
		const topic = (name: string) => ({
			title: `Topic ${name}`,
			pitch: "P",
			dedupeKey: `${project.id}:${name}`,
			provenance: {},
			suggestedPostTypes: [] as PublishingTopicPostType[],
			contributorUserIds: [] as string[],
			relevantFunctionTags: [],
			postTypeRecommendations: [],
		});
		const res = await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "SUGGESTIONS",
			topics: [topic("b")],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(project, user),
		});
		expect(res).toEqual({ persisted: true, status: "READY" });
		const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: cycle.id },
		});
		expect(row.notificationOutcome).toBe("NOT_APPLICABLE");
	},
);

it.skipIf(!RUN_DB)(
	"does not activate a cycle that terminalizes to NO_TOPICS (1C-2b)",
	async () => {
		const { project, user, cycle } = await seedCycle("GENERATING");
		const res = await persistCycleTerminal({
			cycleId: cycle.id,
			kind: "SUGGESTIONS",
			topics: [],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(project, user),
			activateNotificationLifecycle: true,
		});
		// 1C-2a derives the terminal status from ownership and reports `persisted: true`
		// for a genuine first-attempt commit — a cycle honestly going NO_TOPICS (zero
		// generated topics) is a real, successful CAS win, not a lost-CAS no-op. Matches
		// the sibling "sets NO_TOPICS when every generated key is already owned (P8)"
		// case above, which asserts the same `persisted: true` shape.
		expect(res).toEqual({ persisted: true, status: "NO_TOPICS" });
		const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: cycle.id },
		});
		expect(row.notificationOutcome).toBe("NOT_APPLICABLE");
	},
);

it.skipIf(!RUN_DB)(
	"a retry of a committed READY persist leaves the lifecycle at PENDING (1C-2b)",
	async () => {
		// Composes with 1C-2a's replay recovery: the second call reports READY again, and
		// activation is idempotent, so the pair leaves exactly one activated cycle.
		const { project, user, cycle } = await seedCycle("GENERATING");
		const topic = (name: string) => ({
			title: `Topic ${name}`,
			pitch: "P",
			dedupeKey: `${project.id}:${name}`,
			provenance: {},
			suggestedPostTypes: [] as PublishingTopicPostType[],
			contributorUserIds: [] as string[],
			relevantFunctionTags: [],
			postTypeRecommendations: [],
		});
		const input = {
			cycleId: cycle.id,
			kind: "SUGGESTIONS" as const,
			topics: [topic("c")],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(project, user),
			activateNotificationLifecycle: true,
		};
		await persistCycleTerminal(input);
		const replay = await persistCycleTerminal(input);
		expect(replay).toEqual({ persisted: true, status: "READY" });
		const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: cycle.id },
		});
		expect(row.notificationOutcome).toBe("PENDING");
		expect(row.notificationOutcomeVersion).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"activates via the replay-recovery path when only the retry requests it (1C-2b)",
	async () => {
		// This is the rolling-deploy case made executable, isolated from the CAS-won path:
		// attempt 1 runs WITHOUT the flag (an older worker, or one predating patched()) and
		// commits READY without activating; the Temporal retry of the identical call carries
		// the flag. Because attempt 1 already inserted the topics, attempt 2's insert is
		// zero-count and its CAS loses (the cycle is no longer GENERATING) — it recovers
		// READY via the ownership-derived 1C-2a path, not the CAS-won path. Only that
		// replay-recovery return can still close the activation gap here; a version wired
		// only to the CAS-won return would leave this cycle at NOT_APPLICABLE forever.
		const { project, user, cycle } = await seedCycle("GENERATING");
		const topic = (name: string) => ({
			title: `Topic ${name}`,
			pitch: "P",
			dedupeKey: `${project.id}:${name}`,
			provenance: {},
			suggestedPostTypes: [] as PublishingTopicPostType[],
			contributorUserIds: [] as string[],
			relevantFunctionTags: [],
			postTypeRecommendations: [],
		});
		const baseCall = {
			cycleId: cycle.id,
			kind: "SUGGESTIONS" as const,
			topics: [topic("d")],
			sourceCoverage: {},
			sourceFailures: {},
			tenant: tenantOf(project, user),
		};
		const first = await persistCycleTerminal(baseCall); // no flag — the "older worker"
		expect(first).toEqual({ persisted: true, status: "READY" });
		const afterFirst = await db.publishingSuggestionCycle.findUniqueOrThrow(
			{ where: { id: cycle.id } },
		);
		expect(afterFirst.notificationOutcome).toBe("NOT_APPLICABLE");

		const retry = await persistCycleTerminal({
			...baseCall,
			activateNotificationLifecycle: true,
		});
		expect(retry).toEqual({ persisted: true, status: "READY" });
		const afterRetry = await db.publishingSuggestionCycle.findUniqueOrThrow(
			{ where: { id: cycle.id } },
		);
		expect(afterRetry.notificationOutcome).toBe("PENDING");
	},
);

afterAll(async () => {
	await db.project.deleteMany({ where: { id: { in: projectIds } } });
	await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
	await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
});
