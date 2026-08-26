import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { db } from "../index";
import { resolveProjectContributorIds } from "../prisma/queries/projects/publishing-suite";

// REAL-DB integration test: resolveProjectContributorIds's project-scoping (a
// foreign project's story/document must never resolve) depends on real Postgres
// query semantics against seeded rows — not faithfully mockable. Gated on
// RUN_DB_INTEGRATION like the sibling publishing-suite-*.test.ts files, so the
// no-Postgres unit run SKIPS it; it runs only in the db-integration CI job.
const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";
const projectIds: string[] = [];
const userIds: string[] = [];

async function createUser(label: string) {
	const user = await db.user.create({
		data: {
			id: `pub-contrib-${randomUUID()}`,
			name: `pub-suite-contrib-${label}`,
			email: `pub-contrib-${randomUUID()}@test.local`,
			emailVerified: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	userIds.push(user.id);
	return user;
}

async function createProject(ownerId: string, name: string) {
	const project = await db.project.create({
		data: {
			name,
			userId: ownerId,
			status: "ACTIVE",
			techStack: [],
			features: [],
			tags: [],
		},
	});
	projectIds.push(project.id);
	return project;
}

it.skipIf(!RUN_DB)(
	"unions story creator+assignee and doc owner, deduped, scoped to project",
	async () => {
		const owner = await createUser("owner");
		const project = await createProject(owner.id, "contrib");
		const status = await db.projectStoryStatus.create({
			data: {
				projectId: project.id,
				name: "Backlog",
				color: "#94a3b8",
				order: 0,
			},
		});

		const u1 = await createUser("creator");
		const u2 = await createUser("assignee");
		const u3 = await createUser("doc-owner");

		const story = await db.userStory.create({
			data: {
				projectId: project.id,
				statusId: status.id,
				identifier: "US-1",
				title: "Story",
				createdById: u1.id,
				assigneeId: u2.id,
			},
		});
		const doc = await db.projectDocument.create({
			data: {
				projectId: project.id,
				type: "PRD",
				title: "Doc",
				content: "content",
				userId: u3.id,
			},
		});

		// A story in ANOTHER project that must NOT resolve, even if its id were
		// (mistakenly) passed in — project-scoping is the isolation boundary.
		const otherOwner = await createUser("other-owner");
		const otherProject = await createProject(otherOwner.id, "other");
		const otherStatus = await db.projectStoryStatus.create({
			data: {
				projectId: otherProject.id,
				name: "Backlog",
				color: "#94a3b8",
				order: 0,
			},
		});
		const otherUser = await createUser("other-creator");
		const otherStory = await db.userStory.create({
			data: {
				projectId: otherProject.id,
				statusId: otherStatus.id,
				identifier: "US-1",
				title: "Other project story",
				createdById: otherUser.id,
			},
		});

		const ids = await resolveProjectContributorIds(project.id, {
			storyIds: [story.id, otherStory.id],
			docIds: [doc.id],
		});
		expect(new Set(ids)).toEqual(new Set([u1.id, u2.id, u3.id]));
	},
);

it.skipIf(!RUN_DB)("returns [] for empty/absent provenance", async () => {
	const owner = await createUser("empty-owner");
	const project = await createProject(owner.id, "contrib-empty");
	expect(await resolveProjectContributorIds(project.id, {})).toEqual([]);
});

afterAll(async () => {
	await db.project.deleteMany({ where: { id: { in: projectIds } } });
	await db.user.deleteMany({ where: { id: { in: userIds } } });
});
