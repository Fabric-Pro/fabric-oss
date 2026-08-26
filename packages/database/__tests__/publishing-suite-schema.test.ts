import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { db } from "../index"; // package root barrel (what consumers import as @repo/database)

// REAL-DB integration smoke test: the two Publishing Suite models exist on the client and
// enforce the FK + enum contract. Gated on RUN_DB_INTEGRATION (mirrors the RLS test / other
// @repo/database integration tests) so the unit run — which has no Postgres — SKIPS it; it runs
// only in the db-integration CI job (add this file to that job's invocation, Step 10).
const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";
const createdProjectIds: string[] = [];
const createdUserIds: string[] = [];

it.skipIf(!RUN_DB)(
	"persists a cycle and a topic and reads them back",
	async () => {
		// Create a DEDICATED User (self-contained, not a seeded row). `User` has NO defaults on
		// createdAt/updatedAt/emailVerified, so supply them explicitly (schema.prisma).
		const user = await db.user.create({
			data: {
				id: `pub-smoke-${randomUUID()}`,
				name: "pub-suite-smoke",
				email: `pub-smoke-${randomUUID()}@test.local`,
				emailVerified: false,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		createdUserIds.push(user.id);

		// Project's techStack/features/tags are optional String[] (default to empty arrays);
		// passed explicitly here for clarity.
		const project = await db.project.create({
			data: {
				name: "pub-suite-smoke",
				userId: user.id,
				techStack: [],
				features: [],
				tags: [],
			},
		});
		createdProjectIds.push(project.id);

		const cycle = await db.publishingSuggestionCycle.create({
			data: {
				projectId: project.id,
				userId: user.id,
				status: "GENERATING",
				actorUserId: user.id,
				coveredThrough: new Date(),
				executionTimeoutAt: new Date(Date.now() + 3_600_000),
			},
		});
		const topic = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: user.id,
				cycleId: cycle.id,
				title: "We cut p95 latency 40%",
				pitch: "A 40% p95 latency win worth a short write-up",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: `${project.id}:p95-latency`,
			},
		});

		expect(cycle.status).toBe("GENERATING");
		expect(topic.origin).toBe("AI");
		const readBack = await db.publishingTopic.findUniqueOrThrow({
			where: { id: topic.id },
			include: { cycle: true },
		});
		expect(readBack.cycle?.id).toBe(cycle.id);
	},
);

it.skipIf(!RUN_DB)(
	"enforces one active GENERATING cycle per project (partial unique index) and frees the slot on terminalization",
	async () => {
		const user = await db.user.create({
			data: {
				id: `pub-conc-${randomUUID()}`,
				name: "pub-suite-concurrency",
				email: `pub-conc-${randomUUID()}@test.local`,
				emailVerified: false,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		createdUserIds.push(user.id);
		const project = await db.project.create({
			data: {
				name: "pub-suite-concurrency",
				userId: user.id,
				techStack: [],
				features: [],
				tags: [],
			},
		});
		createdProjectIds.push(project.id);

		const first = await db.publishingSuggestionCycle.create({
			data: {
				projectId: project.id,
				userId: user.id,
				status: "GENERATING",
				actorUserId: user.id,
				coveredThrough: new Date(),
				executionTimeoutAt: new Date(Date.now() + 3_600_000),
			},
		});

		// A second GENERATING cycle for the same project must hit the partial unique index.
		await expect(
			db.publishingSuggestionCycle.create({
				data: {
					projectId: project.id,
					userId: user.id,
					status: "GENERATING",
					actorUserId: user.id,
					coveredThrough: new Date(),
					executionTimeoutAt: new Date(Date.now() + 3_600_000),
				},
			}),
		).rejects.toMatchObject({ code: "P2002" });

		// Terminalizing the first cycle frees the slot; a fresh GENERATING run then succeeds.
		await db.publishingSuggestionCycle.update({
			where: { id: first.id },
			data: { status: "FAILED" },
		});
		const retry = await db.publishingSuggestionCycle.create({
			data: {
				projectId: project.id,
				userId: user.id,
				status: "GENERATING",
				actorUserId: user.id,
				coveredThrough: new Date(),
				executionTimeoutAt: new Date(Date.now() + 3_600_000),
			},
		});
		expect(retry.status).toBe("GENERATING");
		expect(retry.id).not.toBe(first.id);
	},
);

it.skipIf(!RUN_DB)(
	"enforces project-wide topic dedupe on (projectId, dedupeKey) across differing status/origin",
	async () => {
		const user = await db.user.create({
			data: {
				id: `pub-dedupe-${randomUUID()}`,
				name: "pub-suite-dedupe",
				email: `pub-dedupe-${randomUUID()}@test.local`,
				emailVerified: false,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		createdUserIds.push(user.id);
		const project = await db.project.create({
			data: {
				name: "pub-suite-dedupe",
				userId: user.id,
				techStack: [],
				features: [],
				tags: [],
			},
		});
		createdProjectIds.push(project.id);

		const dedupeKey = `dupe:${randomUUID()}`;
		await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: user.id,
				title: "First",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey,
			},
		});
		// Same (projectId, dedupeKey) must be rejected regardless of differing status/origin.
		await expect(
			db.publishingTopic.create({
				data: {
					projectId: project.id,
					userId: user.id,
					title: "Second",
					status: "DECLINED",
					origin: "MANUAL",
					dedupeKey,
				},
			}),
		).rejects.toMatchObject({ code: "P2002" });
	},
);

afterAll(async () => {
	await db.project.deleteMany({ where: { id: { in: createdProjectIds } } });
	await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
});
