/**
 * Cascade-on-document-delete coverage for DocumentAssistantConversation
 * (spec 2026-05-19 §3.9 FR-24, §4.2).
 *
 * Exercises the polymorphic cleanup wired into `deleteDocument` and
 * `deleteStory` query helpers. Real Postgres only — the test connects to
 * the same dev DB Aspire spins up so the FK cascade behaviour is real, not
 * mocked.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import { createAgentConversation } from "../prisma/queries/agent-conversations";
import { deleteDocument } from "../prisma/queries/projects/documents";
import { deleteStory } from "../prisma/queries/projects/stories";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

// Unique per-process suffix prevents cross-suite collisions when vitest
// runs files in parallel against the same dev Postgres.
const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-cascade-doc-asst-org-${RUN_ID}`;
const USER_ID = `test-cascade-doc-asst-user-${RUN_ID}`;

describe.skipIf(!hasReachableDatabaseUrl())(
	"cascade-on-document-delete (DocumentAssistantConversation)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Cascade Test User"}, ${`${USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Cascade Test Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
		});

		afterEach(async () => {
			await db.documentAssistantConversation.deleteMany({
				where: { userId: USER_ID },
			});
			await db.agentConversation.deleteMany({
				where: { userId: USER_ID },
			});
			await db.userStory.deleteMany({ where: { createdById: USER_ID } });
			await db.projectStoryStatus.deleteMany({
				where: { project: { userId: USER_ID } },
			});
			await db.projectDocument.deleteMany({ where: { userId: USER_ID } });
			await db.project.deleteMany({ where: { userId: USER_ID } });
		});

		async function seedProject() {
			return db.project.create({
				data: {
					name: "Cascade Project",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			});
		}

		it("removes all DocumentAssistantConversation + AgentConversation rows when the ProjectDocument is deleted", async () => {
			const project = await seedProject();
			const doc = await db.projectDocument.create({
				data: {
					projectId: project.id,
					type: "PRD",
					title: "Cascade Doc",
					content: "Hello",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			});

			// Seed two attached conversations, plus one unrelated conversation
			// that must survive.
			const attachedA = await createAgentConversation({
				userId: USER_ID,
				organizationId: ORG_ID,
				agentId: "document_generator",
			});
			const attachedB = await createAgentConversation({
				userId: USER_ID,
				organizationId: ORG_ID,
				agentId: "document_generator",
			});
			const unrelated = await createAgentConversation({
				userId: USER_ID,
				organizationId: ORG_ID,
				agentId: "orchestrator",
			});

			for (const conv of [attachedA, attachedB]) {
				await db.documentAssistantConversation.create({
					data: {
						conversationId: conv.id,
						documentRefKind: "PROJECT_DOCUMENT",
						documentRefId: doc.id,
						projectId: project.id,
						organizationId: ORG_ID,
						userId: USER_ID,
					},
				});
			}

			await deleteDocument(doc.id);

			const remainingJoins = await db.documentAssistantConversation.count(
				{
					where: {
						documentRefKind: "PROJECT_DOCUMENT",
						documentRefId: doc.id,
					},
				},
			);
			expect(remainingJoins).toBe(0);

			const remainingConvs = await db.agentConversation.count({
				where: { id: { in: [attachedA.id, attachedB.id] } },
			});
			expect(remainingConvs).toBe(0);

			const unrelatedStillThere = await db.agentConversation.findUnique({
				where: { id: unrelated.id },
			});
			expect(unrelatedStillThere).not.toBeNull();
		});

		it("removes all DocumentAssistantConversation + AgentConversation rows when the UserStory is deleted", async () => {
			const project = await seedProject();
			const status = await db.projectStoryStatus.create({
				data: {
					projectId: project.id,
					name: "Backlog",
					color: "#94a3b8",
					order: 0,
					isDefault: true,
				},
			});
			const story = await db.userStory.create({
				data: {
					projectId: project.id,
					statusId: status.id,
					identifier: "US-001",
					title: "Cascade Story",
					createdById: USER_ID,
				},
			});

			const attached = await createAgentConversation({
				userId: USER_ID,
				organizationId: ORG_ID,
				agentId: "document_generator",
			});
			const unrelated = await createAgentConversation({
				userId: USER_ID,
				organizationId: ORG_ID,
				agentId: "document_generator",
			});

			await db.documentAssistantConversation.create({
				data: {
					conversationId: attached.id,
					documentRefKind: "USER_STORY",
					documentRefId: story.id,
					projectId: project.id,
					organizationId: ORG_ID,
					userId: USER_ID,
				},
			});

			await deleteStory(story.id, project.id);

			const remainingJoins = await db.documentAssistantConversation.count(
				{
					where: {
						documentRefKind: "USER_STORY",
						documentRefId: story.id,
					},
				},
			);
			expect(remainingJoins).toBe(0);

			const attachedStillThere = await db.agentConversation.findUnique({
				where: { id: attached.id },
			});
			expect(attachedStillThere).toBeNull();

			const unrelatedStillThere = await db.agentConversation.findUnique({
				where: { id: unrelated.id },
			});
			expect(unrelatedStillThere).not.toBeNull();
		});

		it("succeeds when there are no attached conversations", async () => {
			const project = await seedProject();
			const doc = await db.projectDocument.create({
				data: {
					projectId: project.id,
					type: "PRD",
					title: "Empty Cascade Doc",
					content: "Hello",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			});

			await expect(deleteDocument(doc.id)).resolves.toBeDefined();
		});
	},
);
