import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { db, getLastCountedPublishingRuns } from "../index";

const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";
const projectIds: string[] = [];
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

async function seedPersonalProject(name: string) {
	const user = await db.user.create({
		data: {
			id: `pub-lastrun-${randomUUID()}`,
			name: "pub-lastrun",
			email: `pub-lastrun-${randomUUID()}@test.local`,
			emailVerified: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	createdUserIds.push(user.id);
	const project = await db.project.create({
		data: { name, userId: user.id, techStack: [], features: [], tags: [] },
	});
	projectIds.push(project.id);
	return { project, user };
}

/**
 * Cycles are written with an explicit tenant tuple so the transfer case can be
 * staged: `tenant` is what the CYCLE carries, which is not always what the
 * project carries now.
 */
async function seedCycle(input: {
	projectId: string;
	actorUserId: string;
	tenant: { organizationId: string | null; userId: string | null };
	status:
		| "READY"
		| "NO_TOPICS"
		| "INSUFFICIENT_CONTEXT"
		| "FAILED"
		| "GENERATING";
	sourceFailures?: object | null;
	startedAt: Date;
	// Required by the DB when status is GENERATING — see
	// publishing_suggestion_cycle_generating_timeout in
	// 20260714140000_add_publishing_suite_check_constraints/migration.sql.
	executionTimeoutAt?: Date;
}) {
	await db.publishingSuggestionCycle.create({
		data: {
			projectId: input.projectId,
			organizationId: input.tenant.organizationId,
			userId: input.tenant.userId,
			status: input.status,
			actorUserId: input.actorUserId,
			startedAt: input.startedAt,
			coveredThrough: input.startedAt,
			...(input.executionTimeoutAt === undefined
				? {}
				: { executionTimeoutAt: input.executionTimeoutAt }),
			...(input.sourceFailures === undefined
				? {}
				: { sourceFailures: input.sourceFailures ?? undefined }),
		},
	});
}

afterAll(async () => {
	if (!RUN_DB) {
		return;
	}
	await db.publishingSuggestionCycle.deleteMany({
		where: { projectId: { in: projectIds } },
	});
	await db.project.deleteMany({ where: { id: { in: projectIds } } });
	await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
	await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
});

it.skipIf(!RUN_DB)("returns the newest READY cycle per project", async () => {
	const { project, user } = await seedPersonalProject("lastrun-newest");
	const older = new Date("2026-01-01T00:00:00.000Z");
	const newer = new Date("2026-02-01T00:00:00.000Z");
	await seedCycle({
		projectId: project.id,
		actorUserId: user.id,
		tenant: { organizationId: null, userId: user.id },
		status: "READY",
		startedAt: older,
	});
	await seedCycle({
		projectId: project.id,
		actorUserId: user.id,
		tenant: { organizationId: null, userId: user.id },
		status: "READY",
		startedAt: newer,
	});

	const runs = await getLastCountedPublishingRuns([project.id]);

	expect(runs.get(project.id)?.toISOString()).toBe(newer.toISOString());
});

it.skipIf(!RUN_DB)("counts NO_TOPICS as a run", async () => {
	const { project, user } = await seedPersonalProject("lastrun-no-topics");
	const at = new Date("2026-03-01T00:00:00.000Z");
	await seedCycle({
		projectId: project.id,
		actorUserId: user.id,
		tenant: { organizationId: null, userId: user.id },
		status: "NO_TOPICS",
		startedAt: at,
	});

	const runs = await getLastCountedPublishingRuns([project.id]);

	expect(runs.get(project.id)?.toISOString()).toBe(at.toISOString());
});

it.skipIf(!RUN_DB)(
	"counts a CLEAN INSUFFICIENT_CONTEXT cycle — the workflow stores {} for it, not NULL",
	async () => {
		const { project, user } = await seedPersonalProject(
			"lastrun-clean-insuf",
		);
		const at = new Date("2026-03-02T00:00:00.000Z");
		await seedCycle({
			projectId: project.id,
			actorUserId: user.id,
			tenant: { organizationId: null, userId: user.id },
			status: "INSUFFICIENT_CONTEXT",
			// EXACTLY what persistCycleTerminal writes for a clean run.
			sourceFailures: {},
			startedAt: at,
		});

		const runs = await getLastCountedPublishingRuns([project.id]);

		expect(runs.get(project.id)?.toISOString()).toBe(at.toISOString());
	},
);

it.skipIf(!RUN_DB)(
	"does NOT count an INSUFFICIENT_CONTEXT cycle that had source failures — it must retry tomorrow",
	async () => {
		const { project, user } = await seedPersonalProject(
			"lastrun-dirty-insuf",
		);
		await seedCycle({
			projectId: project.id,
			actorUserId: user.id,
			tenant: { organizationId: null, userId: user.id },
			status: "INSUFFICIENT_CONTEXT",
			sourceFailures: { pullRequests: "source incomplete" },
			startedAt: new Date("2026-03-03T00:00:00.000Z"),
		});

		const runs = await getLastCountedPublishingRuns([project.id]);

		expect(runs.has(project.id)).toBe(false);
	},
);

it.skipIf(!RUN_DB)(
	"does NOT count a FAILED cycle — one crash must not suppress a whole cadence period",
	async () => {
		const { project, user } = await seedPersonalProject("lastrun-failed");
		await seedCycle({
			projectId: project.id,
			actorUserId: user.id,
			tenant: { organizationId: null, userId: user.id },
			status: "FAILED",
			startedAt: new Date("2026-03-04T00:00:00.000Z"),
		});

		const runs = await getLastCountedPublishingRuns([project.id]);

		expect(runs.has(project.id)).toBe(false);
	},
);

it.skipIf(!RUN_DB)(
	"counts an ORGANIZATION project's cycle, which stores userId NULL against a non-null project owner",
	async () => {
		// This is the case a raw `cycle.userId = project.userId` comparison gets
		// wrong for EVERY org project: dispatch normalizes the cycle's userId to
		// NULL, but Project.userId still holds the owner. Getting this wrong makes
		// every org project look never-run and regenerate on every daily tick.
		const { project, user } = await seedPersonalProject("lastrun-org");
		const org = await db.organization.create({
			data: {
				id: `pub-lastrun-org2-${randomUUID()}`,
				name: "example-org",
				slug: `example-org-${randomUUID()}`,
				createdAt: new Date(),
			},
		});
		createdOrgIds.push(org.id);
		await db.project.update({
			where: { id: project.id },
			data: { organizationId: org.id },
		});
		const at = new Date("2026-04-01T00:00:00.000Z");
		await seedCycle({
			projectId: project.id,
			actorUserId: user.id,
			// EXACTLY the tuple dispatch-suggestion.ts writes for an org project.
			tenant: { organizationId: org.id, userId: null },
			status: "READY",
			startedAt: at,
		});

		const runs = await getLastCountedPublishingRuns([project.id]);

		expect(runs.get(project.id)?.toISOString()).toBe(at.toISOString());
	},
);

it.skipIf(!RUN_DB)(
	"does NOT count a cycle whose tenant tuple predates a project transfer",
	async () => {
		const { project, user } = await seedPersonalProject(
			"lastrun-transferred",
		);
		const org = await db.organization.create({
			data: {
				id: `pub-lastrun-org-${randomUUID()}`,
				name: "example-org",
				slug: `example-org-${randomUUID()}`,
				createdAt: new Date(),
			},
		});
		createdOrgIds.push(org.id);
		// The cycle was written while the project was still personal.
		await seedCycle({
			projectId: project.id,
			actorUserId: user.id,
			tenant: { organizationId: null, userId: user.id },
			status: "READY",
			startedAt: new Date("2026-03-05T00:00:00.000Z"),
		});
		// Then the project moved into the organization.
		await db.project.update({
			where: { id: project.id },
			data: { organizationId: org.id, userId: user.id },
		});

		const runs = await getLastCountedPublishingRuns([project.id]);

		// Under the new tenant the project reads as never-run, so it is due now.
		expect(runs.has(project.id)).toBe(false);
	},
);

it.skipIf(!RUN_DB)("returns an empty map for an empty id list", async () => {
	const runs = await getLastCountedPublishingRuns([]);

	expect(runs.size).toBe(0);
});

it.skipIf(!RUN_DB)(
	"returns one row per project, each keyed to its OWN newest cycle, when queried together",
	async () => {
		// Every existing case above queries a single project. The query is raw
		// SQL specifically to get tenant scoping, "counts as a run", AND one row
		// per project right — a CROSS JOIN LATERAL that mis-keyed or cross-joined
		// rows would still pass every single-project case above and only show up
		// once two projects are queried in the same call.
		const { project: projectA, user: userA } =
			await seedPersonalProject("lastrun-multi-a");
		const { project: projectB, user: userB } =
			await seedPersonalProject("lastrun-multi-b");

		const aOlder = new Date("2026-05-01T00:00:00.000Z");
		const aNewer = new Date("2026-05-02T00:00:00.000Z");
		const bOlder = new Date("2026-05-03T00:00:00.000Z");
		const bNewer = new Date("2026-05-04T00:00:00.000Z");

		await seedCycle({
			projectId: projectA.id,
			actorUserId: userA.id,
			tenant: { organizationId: null, userId: userA.id },
			status: "READY",
			startedAt: aOlder,
		});
		await seedCycle({
			projectId: projectA.id,
			actorUserId: userA.id,
			tenant: { organizationId: null, userId: userA.id },
			status: "READY",
			startedAt: aNewer,
		});
		await seedCycle({
			projectId: projectB.id,
			actorUserId: userB.id,
			tenant: { organizationId: null, userId: userB.id },
			status: "READY",
			startedAt: bOlder,
		});
		await seedCycle({
			projectId: projectB.id,
			actorUserId: userB.id,
			tenant: { organizationId: null, userId: userB.id },
			status: "READY",
			startedAt: bNewer,
		});

		const runs = await getLastCountedPublishingRuns([
			projectA.id,
			projectB.id,
		]);

		expect(runs.size).toBe(2);
		// Each project maps to its OWN newest cycle — not the other project's,
		// and not its own older cycle.
		expect(runs.get(projectA.id)?.toISOString()).toBe(aNewer.toISOString());
		expect(runs.get(projectB.id)?.toISOString()).toBe(bNewer.toISOString());
	},
);

it.skipIf(!RUN_DB)(
	"does NOT count a GENERATING cycle — still in flight, must not suppress a run for a whole cadence period",
	async () => {
		const { project, user } =
			await seedPersonalProject("lastrun-generating");
		const startedAt = new Date("2026-03-06T00:00:00.000Z");
		await seedCycle({
			projectId: project.id,
			actorUserId: user.id,
			tenant: { organizationId: null, userId: user.id },
			status: "GENERATING",
			startedAt,
			// Required by publishing_suggestion_cycle_generating_timeout.
			executionTimeoutAt: new Date(
				startedAt.getTime() + 2 * 60 * 60 * 1000,
			),
		});

		const runs = await getLastCountedPublishingRuns([project.id]);

		expect(runs.has(project.id)).toBe(false);
	},
);
