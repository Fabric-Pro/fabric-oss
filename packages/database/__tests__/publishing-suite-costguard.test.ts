import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { db } from "../index";
import { countNewContextSince } from "../prisma/queries/projects/publishing-suite";

// REAL-DB integration test: countNewContextSince's per-source existence checks (and the H2
// ACTIVE-repo-integration always-possibly-new branch) depend on real Postgres `count()` semantics
// against seeded rows. Gated on RUN_DB_INTEGRATION like the sibling publishing-suite-*.test.ts
// files, so the no-Postgres unit run SKIPS it; it runs only in the db-integration CI job.
const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";
const projectIds: string[] = [];
const createdUserIds: string[] = [];

async function seedProject(name: string) {
	// A dedicated user (not db.user.findFirstOrThrow()) — the db-integration CI job runs against a
	// fresh, unseeded Postgres, and sibling suites delete their own fixture users in afterAll, so
	// relying on "some other row exists" is order-dependent and can 404 in CI. User has no defaults
	// on name/email/emailVerified/createdAt/updatedAt, so supply them explicitly (schema.prisma).
	const user = await db.user.create({
		data: {
			id: `pub-costguard-${randomUUID()}`,
			name: "pub-suite-costguard",
			email: `pub-costguard-${randomUUID()}@test.local`,
			emailVerified: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	createdUserIds.push(user.id);
	const project = await db.project.create({
		data: {
			name,
			userId: user.id,
			techStack: [],
			features: [],
			tags: [],
		},
	});
	projectIds.push(project.id);
	return { project, user };
}

async function seedStory(projectId: string, userId: string, title: string) {
	const status = await db.projectStoryStatus.create({
		data: {
			projectId,
			name: "Backlog",
			color: "#94a3b8",
			order: 0,
			isDefault: true,
		},
	});
	return db.userStory.create({
		data: {
			projectId,
			statusId: status.id,
			identifier: "US-001",
			title,
			createdById: userId,
		},
	});
}

async function seedRepoIntegration(
	projectId: string,
	status: "ACTIVE" | "DISCONNECTED",
) {
	return db.projectRepositoryIntegration.create({
		data: {
			projectId,
			provider: "GITHUB",
			authMethod: "OAUTH",
			repositoryUrl: `https://github.com/acme/${randomUUID()}`,
			repositoryOwner: "acme",
			repositoryName: `repo-${randomUUID()}`,
			status,
		},
	});
}

async function seedTranscript(
	projectId: string,
	opts: { syncedAt: Date; insightsExtractedAt: Date | null },
) {
	// linkedMeetingId is a required FK to ProjectLinkedMeeting — seed the parent row first.
	const linkedMeeting = await db.projectLinkedMeeting.create({
		data: {
			projectId,
			joinUrl: `https://teams.microsoft.com/l/meetup-join/${randomUUID()}`,
		},
	});
	return db.projectMeetingTranscript.create({
		data: {
			projectId,
			linkedMeetingId: linkedMeeting.id,
			meetingId: randomUUID(),
			transcriptId: randomUUID(),
			syncedAt: opts.syncedAt,
			insightsExtractedAt: opts.insightsExtractedAt,
		},
	});
}

it.skipIf(!RUN_DB)(
	"(a) hasNew is true for a recent story with empty coverage, and false once coverage postdates it",
	async () => {
		const { project, user } = await seedProject("costguard-story");
		await seedStory(project.id, user.id, "Recent story");

		const empty = await countNewContextSince(project.id, null, {});
		expect(empty.hasNew).toBe(true);

		const future = new Date(Date.now() + 60_000).toISOString();
		const postdated = await countNewContextSince(project.id, null, {
			stories: future,
		});
		expect(postdated.hasNew).toBe(false);
	},
);

it.skipIf(!RUN_DB)(
	"(b) H2: hasNew stays true for an ACTIVE-integration-only project even when coverage postdates all local content",
	async () => {
		const { project } = await seedProject("costguard-active-integration");
		await seedRepoIntegration(project.id, "ACTIVE");

		const future = new Date(Date.now() + 60_000).toISOString();
		const result = await countNewContextSince(project.id, null, {
			stories: future,
			documents: future,
			transcripts: future,
		});
		expect(result.hasNew).toBe(true);
	},
);

it.skipIf(!RUN_DB)(
	"(c) hasNew is false when the only integration is DISCONNECTED and local content is stale",
	async () => {
		const { project, user } = await seedProject("costguard-disconnected");
		await seedStory(project.id, user.id, "Stale story");
		await seedRepoIntegration(project.id, "DISCONNECTED");

		const future = new Date(Date.now() + 60_000).toISOString();
		const result = await countNewContextSince(project.id, null, {
			stories: future,
		});
		expect(result.hasNew).toBe(false);
	},
);

it.skipIf(!RUN_DB)(
	"(d) F5: hasNew is true when a transcript's insightsExtractedAt is newer than coverage even though syncedAt predates it",
	async () => {
		const { project } = await seedProject("costguard-late-insights");
		const syncedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
		const insightsExtractedAt = new Date(Date.now() - 60_000); // 1 minute ago
		await seedTranscript(project.id, { syncedAt, insightsExtractedAt });

		// Coverage watermark sits strictly BETWEEN syncedAt and insightsExtractedAt:
		// syncedAt-only filtering would report false (the row was "seen" before the
		// watermark), but the collector treats `insightsExtractedAt ?? syncedAt` as the
		// real freshness signal — the row was summarized AFTER the watermark.
		const coverageWatermark = new Date(
			(syncedAt.getTime() + insightsExtractedAt.getTime()) / 2,
		).toISOString();
		const result = await countNewContextSince(project.id, null, {
			transcripts: coverageWatermark,
		});
		expect(result.hasNew).toBe(true);
	},
);

it.skipIf(!RUN_DB)(
	"(e) F5: hasNew is false when both syncedAt and insightsExtractedAt predate coverage",
	async () => {
		const { project } = await seedProject("costguard-stale-insights");
		const syncedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
		const insightsExtractedAt = new Date(
			Date.now() - 2 * 24 * 60 * 60 * 1000,
		);
		await seedTranscript(project.id, { syncedAt, insightsExtractedAt });

		const future = new Date(Date.now() + 60_000).toISOString();
		const result = await countNewContextSince(project.id, null, {
			transcripts: future,
		});
		expect(result.hasNew).toBe(false);
	},
);

afterAll(async () => {
	await db.project.deleteMany({ where: { id: { in: projectIds } } });
	await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
});
