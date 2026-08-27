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

it.skipIf(!RUN_DB)(
	"admits exactly the five live topic statuses, DEFERRED having left the type",
	async () => {
		// Read the LABELS out of the catalog rather than attempting a write, because
		// no write can answer this question. The generated client's union already
		// excludes DEFERRED, so `create({ status: "DEFERRED" })` does not compile;
		// and a hand-rolled `'DEFERRED'::publishing_topic_status` fails on the CAST
		// before Postgres looks at any column, so it would report a pass against a
		// column that is not even of this type. The sibling case on
		// PublishingTopicPostType in publishing-preference-fields.test.ts was green
		// for two drafts for exactly that reason.
		//
		// The join runs from the COLUMN outwards — pg_attribute to its atttypid to
		// pg_enum — and not from a type looked up by name. Those are different
		// questions. "A five-label enum named publishing_topic_status exists" is
		// satisfied by a type nothing uses, which is the exact shape a half-applied
		// or hand-recovered rebuild leaves behind: the new type created and named,
		// the column still pointing at the old one, DEFERRED still reachable through
		// the only route that matters. Starting from the column cannot be satisfied
		// that way. The type's NAME is then asserted separately, because the rename
		// is its own step of the same migration and schema.prisma's @@map commits
		// every later migration to finding the type under it.
		//
		// enumlabel and typname are Postgres type `name`, which Prisma cannot map —
		// without the ::text casts this throws rather than failing an assertion.
		const rows = await db.$queryRaw<{ typeName: string; label: string }[]>`
			SELECT t.typname::text AS "typeName", e.enumlabel::text AS label
			FROM pg_attribute a
			JOIN pg_class c ON c.oid = a.attrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			JOIN pg_type t ON t.oid = a.atttypid
			JOIN pg_enum e ON e.enumtypid = t.oid
			WHERE n.nspname = 'public'
			  AND c.relname = 'publishing_topic'
			  AND a.attname = 'status'
			  AND a.attnum > 0
			  AND NOT a.attisdropped
			ORDER BY e.enumsortorder
		`;

		// An empty result would mean the column is not an enum at all, so assert the
		// name off a row rather than off a defaulted lookup that reads the same
		// whether the join found nothing or found the wrong thing.
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0]?.typeName).toBe("publishing_topic_status");

		// The WHOLE ordered list, not the absence of one value: a migration that
		// rebuilds an enum type is equally free to drop or reorder a live label, and
		// "DEFERRED is missing" stays green through that.
		expect(rows.map((r) => r.label)).toEqual([
			"SUGGESTION",
			"SELECTED",
			"IN_PROGRESS",
			"PUBLISHED",
			"DECLINED",
		]);
	},
);

it.skipIf(!RUN_DB)(
	"keeps the status column's DEFAULT across the enum rebuild",
	async () => {
		// The rebuild drops the DEFAULT and restores it, because the default is a
		// SECOND dependent of the type (pg_attrdef) and does not follow the column
		// onto a rebuilt one — a default is parsed against the type it was declared
		// with. The migration's header calls that bracketing load-bearing; this is
		// what makes the claim falsifiable.
		//
		// Without this case the restoring statement is silently droppable. The
		// label assertion above cannot see a default, no workflow runs
		// `prisma migrate diff` against schema.prisma, and Prisma applies
		// @default(SUGGESTION) client-side — so an ORM write still looks correct
		// and the loss surfaces only on a raw INSERT that omits status.
		//
		// column_default is information_schema.character_data, a domain Prisma
		// cannot map; ::text is what keeps this an assertion rather than a throw.
		const rows = await db.$queryRaw<{ columnDefault: string | null }[]>`
			SELECT column_default::text AS "columnDefault"
			FROM information_schema.columns
			WHERE table_schema = 'public'
			  AND table_name = 'publishing_topic'
			  AND column_name = 'status'
		`;

		expect(rows).toHaveLength(1);
		expect(rows[0]?.columnDefault).toBe(
			"'SUGGESTION'::publishing_topic_status",
		);
	},
);

afterAll(async () => {
	await db.project.deleteMany({ where: { id: { in: createdProjectIds } } });
	await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
});
