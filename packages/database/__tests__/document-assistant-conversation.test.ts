/**
 * Unit coverage for the document-assistant-conversation query helpers
 * (spec 2026-05-19 §5.1, §5.2, §5.4, §5.5, §5.7, §4.4).
 *
 * Real Postgres only — every helper is exercised end-to-end against the dev
 * DB so the XOR pattern + visibility predicate + transactional create are
 * verified as a unit, not mocked.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import {
	archiveDocumentAssistantConversation,
	canSubscribeToDocumentAssistantConversation,
	countDocumentAssistantConversationsInLast24h,
	createDocumentAssistantConversation,
	DocumentAssistantVisibilityLockedError,
	deleteDocumentAssistantConversationByConversationId,
	getActiveDocumentAssistantConversation,
	listDocumentAssistantConversations,
	setDocumentAssistantConversationVisibility,
} from "../prisma/queries/document-assistant-conversation";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

// Unique per-process suffix prevents cross-suite collisions when vitest
// runs files in parallel against the same dev Postgres.
const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-doc-asst-queries-org-${RUN_ID}`;
const USERS = {
	author: `test-doc-asst-queries-author-${RUN_ID}`,
	teammate: `test-doc-asst-queries-teammate-${RUN_ID}`,
	otherTenant: `test-doc-asst-queries-other-tenant-${RUN_ID}`,
} as const;

describe.skipIf(!hasReachableDatabaseUrl())(
	"document-assistant-conversation query helpers",
	() => {
		let projectId: string;
		const docId = "doc-queries-test";

		beforeAll(async () => {
			const now = new Date();
			for (const [_, uid] of Object.entries(USERS)) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
					VALUES (${uid}, ${uid}, ${`${uid}@test.com`}, true, false, ${now}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
			}
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Doc Asst Queries Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
				VALUES (${`m-${ORG_ID}-${USERS.author}`}, ${ORG_ID}, ${USERS.author}, ${"member"}, ${now})
				ON CONFLICT DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
				VALUES (${`m-${ORG_ID}-${USERS.teammate}`}, ${ORG_ID}, ${USERS.teammate}, ${"member"}, ${now})
				ON CONFLICT DO NOTHING
			`);
			const project = await db.project.create({
				data: {
					name: "Doc Asst Queries Project",
					userId: USERS.author,
					organizationId: ORG_ID,
				},
			});
			projectId = project.id;
		});

		afterEach(async () => {
			await db.documentAssistantConversation.deleteMany({
				where: { projectId },
			});
			await db.agentConversation.deleteMany({
				where: {
					userId: { in: Object.values(USERS) },
				},
			});
		});

		afterAll(async () => {
			await db.project.deleteMany({ where: { id: projectId } });
			await db.member.deleteMany({ where: { organizationId: ORG_ID } });
			await db.organization.deleteMany({ where: { id: ORG_ID } });
			await db.user.deleteMany({
				where: { id: { in: Object.values(USERS) } },
			});
		});

		describe("createDocumentAssistantConversation", () => {
			it("creates the agent_conversation and join row in a single transaction", async () => {
				const { conversation, join } =
					await createDocumentAssistantConversation({
						tenantFilter: {
							organizationId: ORG_ID,
							userId: USERS.author,
						},
						documentRefKind: "PROJECT_DOCUMENT",
						documentRefId: docId,
						projectId,
						agentId: "document_generator",
						visibility: "SHARED",
					});

				expect(conversation.userId).toBe(USERS.author);
				expect(conversation.organizationId).toBe(ORG_ID);
				expect(join.conversationId).toBe(conversation.id);
				expect(join.visibility).toBe("SHARED");
				expect(join.visibilityLockedAt).toBeNull();
				expect(join.archivedAt).toBeNull();
			});
		});

		describe("listDocumentAssistantConversations", () => {
			it("returns SHARED + own PRIVATE rows for the document; hides teammates' PRIVATE rows", async () => {
				const authorShared = await createDocumentAssistantConversation({
					tenantFilter: {
						organizationId: ORG_ID,
						userId: USERS.author,
					},
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: docId,
					projectId,
					agentId: "document_generator",
					visibility: "SHARED",
				});
				const authorPrivate = await createDocumentAssistantConversation(
					{
						tenantFilter: {
							organizationId: ORG_ID,
							userId: USERS.author,
						},
						documentRefKind: "PROJECT_DOCUMENT",
						documentRefId: docId,
						projectId,
						agentId: "document_generator",
						visibility: "PRIVATE",
					},
				);
				const teammatePrivate =
					await createDocumentAssistantConversation({
						tenantFilter: {
							organizationId: ORG_ID,
							userId: USERS.teammate,
						},
						documentRefKind: "PROJECT_DOCUMENT",
						documentRefId: docId,
						projectId,
						agentId: "document_generator",
						visibility: "PRIVATE",
					});

				const authorView = await listDocumentAssistantConversations({
					tenantFilter: {
						organizationId: ORG_ID,
						userId: USERS.author,
					},
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: docId,
				});
				const ids = authorView.items.map((i) => i.id);
				expect(ids).toContain(authorShared.join.id);
				expect(ids).toContain(authorPrivate.join.id);
				expect(ids).not.toContain(teammatePrivate.join.id);

				const teammateView = await listDocumentAssistantConversations({
					tenantFilter: {
						organizationId: ORG_ID,
						userId: USERS.teammate,
					},
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: docId,
				});
				const teammateIds = teammateView.items.map((i) => i.id);
				expect(teammateIds).toContain(authorShared.join.id);
				expect(teammateIds).toContain(teammatePrivate.join.id);
				expect(teammateIds).not.toContain(authorPrivate.join.id);
			});

			it("respects the limit and yields a stable cursor that paginates the next page", async () => {
				for (let i = 0; i < 5; i++) {
					await createDocumentAssistantConversation({
						tenantFilter: {
							organizationId: ORG_ID,
							userId: USERS.author,
						},
						documentRefKind: "PROJECT_DOCUMENT",
						documentRefId: docId,
						projectId,
						agentId: "document_generator",
						visibility: "SHARED",
					});
				}

				const page1 = await listDocumentAssistantConversations({
					tenantFilter: {
						organizationId: ORG_ID,
						userId: USERS.author,
					},
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: docId,
					limit: 2,
				});
				expect(page1.items).toHaveLength(2);
				expect(page1.nextCursor).not.toBeNull();

				const page2 = await listDocumentAssistantConversations({
					tenantFilter: {
						organizationId: ORG_ID,
						userId: USERS.author,
					},
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: docId,
					limit: 2,
					cursor: page1.nextCursor ?? undefined,
				});
				expect(page2.items).toHaveLength(2);
				const overlap = new Set(page1.items.map((i) => i.id));
				for (const item of page2.items) {
					expect(overlap.has(item.id)).toBe(false);
				}

				const page3 = await listDocumentAssistantConversations({
					tenantFilter: {
						organizationId: ORG_ID,
						userId: USERS.author,
					},
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: docId,
					limit: 2,
					cursor: page2.nextCursor ?? undefined,
				});
				expect(page3.items).toHaveLength(1);
				expect(page3.nextCursor).toBeNull();
			});
		});

		describe("getActiveDocumentAssistantConversation", () => {
			it("returns the caller's most recent non-archived row, ignoring archived rows and teammates' rows", async () => {
				const archived = await createDocumentAssistantConversation({
					tenantFilter: {
						organizationId: ORG_ID,
						userId: USERS.author,
					},
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: docId,
					projectId,
					agentId: "document_generator",
				});
				await archiveDocumentAssistantConversation({
					id: archived.join.id,
				});

				const teammate = await createDocumentAssistantConversation({
					tenantFilter: {
						organizationId: ORG_ID,
						userId: USERS.teammate,
					},
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: docId,
					projectId,
					agentId: "document_generator",
				});

				const expected = await createDocumentAssistantConversation({
					tenantFilter: {
						organizationId: ORG_ID,
						userId: USERS.author,
					},
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: docId,
					projectId,
					agentId: "document_generator",
				});

				const active = await getActiveDocumentAssistantConversation({
					tenantFilter: {
						organizationId: ORG_ID,
						userId: USERS.author,
					},
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: docId,
				});

				expect(active?.id).toBe(expected.join.id);
				expect(active?.id).not.toBe(archived.join.id);
				expect(active?.id).not.toBe(teammate.join.id);
				expect(active?.conversation.id).toBe(expected.conversation.id);
			});

			it("returns null when the caller has no conversation for this document", async () => {
				const result = await getActiveDocumentAssistantConversation({
					tenantFilter: {
						organizationId: ORG_ID,
						userId: USERS.author,
					},
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: "nope",
				});
				expect(result).toBeNull();
			});
		});

		describe("setDocumentAssistantConversationVisibility", () => {
			it("updates visibility when the row is unlocked", async () => {
				const { join } = await createDocumentAssistantConversation({
					tenantFilter: {
						organizationId: ORG_ID,
						userId: USERS.author,
					},
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: docId,
					projectId,
					agentId: "document_generator",
					visibility: "SHARED",
				});

				const updated =
					await setDocumentAssistantConversationVisibility({
						id: join.id,
						visibility: "PRIVATE",
						expectUnlocked: true,
					});
				expect(updated.visibility).toBe("PRIVATE");
			});

			it("throws DocumentAssistantVisibilityLockedError once visibilityLockedAt is set", async () => {
				const { join } = await createDocumentAssistantConversation({
					tenantFilter: {
						organizationId: ORG_ID,
						userId: USERS.author,
					},
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: docId,
					projectId,
					agentId: "document_generator",
				});
				await db.documentAssistantConversation.update({
					where: { id: join.id },
					data: { visibilityLockedAt: new Date() },
				});

				await expect(
					setDocumentAssistantConversationVisibility({
						id: join.id,
						visibility: "PRIVATE",
						expectUnlocked: true,
					}),
				).rejects.toBeInstanceOf(
					DocumentAssistantVisibilityLockedError,
				);
			});

			it("bypasses the lock when expectUnlocked is false", async () => {
				const { join } = await createDocumentAssistantConversation({
					tenantFilter: {
						organizationId: ORG_ID,
						userId: USERS.author,
					},
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: docId,
					projectId,
					agentId: "document_generator",
				});
				await db.documentAssistantConversation.update({
					where: { id: join.id },
					data: { visibilityLockedAt: new Date() },
				});

				const updated =
					await setDocumentAssistantConversationVisibility({
						id: join.id,
						visibility: "PRIVATE",
						expectUnlocked: false,
					});
				expect(updated.visibility).toBe("PRIVATE");
			});
		});

		describe("archive + delete", () => {
			it("archive stamps archivedAt and ARCHIVES the underlying AgentConversation", async () => {
				const { join, conversation } =
					await createDocumentAssistantConversation({
						tenantFilter: {
							organizationId: ORG_ID,
							userId: USERS.author,
						},
						documentRefKind: "PROJECT_DOCUMENT",
						documentRefId: docId,
						projectId,
						agentId: "document_generator",
					});

				await archiveDocumentAssistantConversation({ id: join.id });

				const refreshed =
					await db.documentAssistantConversation.findUnique({
						where: { id: join.id },
					});
				const refreshedConv = await db.agentConversation.findUnique({
					where: { id: conversation.id },
				});
				expect(refreshed?.archivedAt).not.toBeNull();
				expect(refreshedConv?.status).toBe("ARCHIVED");
			});

			it("delete-by-conversationId removes both the AgentConversation and the join row via FK cascade", async () => {
				const { join, conversation } =
					await createDocumentAssistantConversation({
						tenantFilter: {
							organizationId: ORG_ID,
							userId: USERS.author,
						},
						documentRefKind: "PROJECT_DOCUMENT",
						documentRefId: docId,
						projectId,
						agentId: "document_generator",
					});

				await deleteDocumentAssistantConversationByConversationId({
					conversationId: conversation.id,
				});

				const stillThere = await db.agentConversation.findUnique({
					where: { id: conversation.id },
				});
				const joinThere =
					await db.documentAssistantConversation.findUnique({
						where: { id: join.id },
					});
				expect(stillThere).toBeNull();
				expect(joinThere).toBeNull();
			});
		});

		describe("countDocumentAssistantConversationsInLast24h", () => {
			it("counts only rows created within the 24h rolling window", async () => {
				const fresh = await createDocumentAssistantConversation({
					tenantFilter: {
						organizationId: ORG_ID,
						userId: USERS.author,
					},
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: docId,
					projectId,
					agentId: "document_generator",
				});
				const stale = await createDocumentAssistantConversation({
					tenantFilter: {
						organizationId: ORG_ID,
						userId: USERS.author,
					},
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: docId,
					projectId,
					agentId: "document_generator",
				});

				// Backdate `stale` past the 24h window.
				const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
				await db.documentAssistantConversation.update({
					where: { id: stale.join.id },
					data: { createdAt: longAgo },
				});

				const count =
					await countDocumentAssistantConversationsInLast24h({
						userId: USERS.author,
						documentRefKind: "PROJECT_DOCUMENT",
						documentRefId: docId,
					});

				expect(count).toBe(1);
				// Touch reference so the lint rule for "use unused var" stays happy.
				expect(fresh.join.id).toBeDefined();
			});
		});

		describe("canSubscribeToDocumentAssistantConversation", () => {
			const mk = (userId: string, visibility: "SHARED" | "PRIVATE") =>
				createDocumentAssistantConversation({
					tenantFilter: { organizationId: ORG_ID, userId },
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: docId,
					projectId,
					agentId: "document_generator",
					visibility,
				});

			it("lets the owner subscribe to their own PRIVATE conversation", async () => {
				const { conversation } = await mk(USERS.author, "PRIVATE");
				await expect(
					canSubscribeToDocumentAssistantConversation({
						conversationId: conversation.id,
						userId: USERS.author,
					}),
				).resolves.toBe(true);
			});

			it("lets a teammate subscribe to a SHARED conversation", async () => {
				const { conversation } = await mk(USERS.author, "SHARED");
				await expect(
					canSubscribeToDocumentAssistantConversation({
						conversationId: conversation.id,
						userId: USERS.teammate,
					}),
				).resolves.toBe(true);
			});

			it("does NOT let a teammate subscribe to a teammate's PRIVATE conversation", async () => {
				const { conversation } = await mk(USERS.author, "PRIVATE");
				await expect(
					canSubscribeToDocumentAssistantConversation({
						conversationId: conversation.id,
						userId: USERS.teammate,
					}),
				).resolves.toBe(false);
			});

			it("does NOT let another tenant reach an org SHARED conversation (XOR isolation)", async () => {
				const { conversation } = await mk(USERS.author, "SHARED");
				await expect(
					canSubscribeToDocumentAssistantConversation({
						conversationId: conversation.id,
						userId: USERS.otherTenant,
					}),
				).resolves.toBe(false);
			});

			it("returns false for a conversation with no document-assistant join (standalone agent chat)", async () => {
				const standalone = await db.agentConversation.create({
					data: {
						userId: USERS.author,
						organizationId: ORG_ID,
						agentId: "orchestrator",
					},
				});
				await expect(
					canSubscribeToDocumentAssistantConversation({
						conversationId: standalone.id,
						userId: USERS.author,
					}),
				).resolves.toBe(false);
			});
		});
	},
);
