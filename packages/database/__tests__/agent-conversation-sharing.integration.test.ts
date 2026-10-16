/**
 * Who may read and write a shared Fabric Agent session, against a real
 * Postgres.
 *
 * The unit suites check the query predicates and the policy SQL as text. These
 * cases run the policies: with a role that RLS applies to, a teammate reads a
 * session its owner shared and a private one stays hidden, and a teammate can
 * neither update nor delete the shared one.
 *
 * Runs against DATABASE_URL (RUN_DB_INTEGRATION=1) after migrations and
 * `pnpm --filter @repo/database apply:rls`.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../prisma/generated/client";
import {
	getAgentConversationForViewer,
	listAgentConversationsForViewer,
	setAgentConversationVisibility,
} from "../prisma/queries/agent-conversation-sharing";
import {
	ConversationNotFoundError,
	continueConversationInNewChat,
	ParentConversationNotFoundError,
	saveConversationTurn,
} from "../prisma/queries/agent-conversations";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";
import { asRlsRole, ensureRlsTestRole } from "./_helpers/rls-role";

const IDS = {
	org: "acshare-org",
	otherOrg: "acshare-other-org",
	me: "acshare-me",
	ana: "acshare-ana",
	mine: "acshare-c-mine",
	anaPrivate: "acshare-c-ana-private",
	anaShared: "acshare-c-ana-shared",
	elsewhere: "acshare-c-elsewhere",
};
const AGENT = "fabric-workspace-assistant";

function client(): PrismaClient {
	return new PrismaClient({
		adapter: new PrismaPg({
			connectionString: process.env.DATABASE_URL ?? "",
		}),
	});
}

/**
 * Setup opens the first connections and writes the fixtures; on a busy machine
 * that outlasts the 10 s default for a hook.
 */
const HOOK_TIMEOUT_MS = 60_000;

/** Fixture writes and assertions; the statements under test use the shared `db`. */
const fixtures = client();

const conversationIds = Object.values(IDS).filter((id) =>
	id.startsWith("acshare-c-"),
);

describe.skipIf(!hasReachableDatabaseUrl())(
	"Shared Fabric Agent sessions (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			for (const [id, name] of [
				[IDS.me, "Me Myself"],
				[IDS.ana, "Ana"],
			] as const) {
				await fixtures.user.upsert({
					where: { id },
					update: {},
					create: {
						id,
						name,
						email: `${id}@example.com`,
						emailVerified: true,
						createdAt: now,
						updatedAt: now,
					},
				});
			}
			for (const id of [IDS.org, IDS.otherOrg]) {
				await fixtures.organization.upsert({
					where: { id },
					update: {},
					create: { id, name: id, slug: id, createdAt: now },
				});
			}
			await ensureRlsTestRole();
		}, HOOK_TIMEOUT_MS);

		beforeEach(async () => {
			await fixtures.agentConversation.deleteMany({
				where: { parentConversationId: { in: conversationIds } },
			});
			await fixtures.agentConversation.deleteMany({
				where: { id: { in: conversationIds } },
			});
			await fixtures.agentConversation.createMany({
				data: [
					{
						id: IDS.mine,
						userId: IDS.me,
						organizationId: IDS.org,
						agentId: AGENT,
						title: "My session",
					},
					{
						id: IDS.anaPrivate,
						userId: IDS.ana,
						organizationId: IDS.org,
						agentId: AGENT,
						title: "Ana private",
					},
					{
						id: IDS.anaShared,
						userId: IDS.ana,
						organizationId: IDS.org,
						agentId: AGENT,
						title: "Ana shared",
						visibility: "ORGANIZATION",
					},
					{
						id: IDS.elsewhere,
						userId: IDS.ana,
						organizationId: IDS.otherOrg,
						agentId: AGENT,
						title: "Ana in another organization",
						visibility: "ORGANIZATION",
					},
				],
			});
		});

		afterAll(async () => {
			await fixtures.agentConversation.deleteMany({
				where: { parentConversationId: { in: conversationIds } },
			});
			await fixtures.agentConversation.deleteMany({
				where: { id: { in: conversationIds } },
			});
			await fixtures.organization.deleteMany({
				where: { id: { in: [IDS.org, IDS.otherOrg] } },
			});
			await fixtures.user.deleteMany({
				where: { id: { in: [IDS.me, IDS.ana] } },
			});
			await fixtures.$disconnect();
			const { db } = await import("../prisma/client");
			await db.$disconnect();
		}, HOOK_TIMEOUT_MS);

		describe("the queries", () => {
			it("lists the viewer's own sessions as mine and the organization's shared ones as shared", async () => {
				const mine = await listAgentConversationsForViewer({
					userId: IDS.me,
					organizationId: IDS.org,
					agentId: AGENT,
					scope: "mine",
					limit: 50,
				});
				const shared = await listAgentConversationsForViewer({
					userId: IDS.me,
					organizationId: IDS.org,
					agentId: AGENT,
					scope: "shared",
					limit: 50,
				});

				expect(mine.items.map((i) => i.id)).toEqual([IDS.mine]);
				expect(shared.items.map((i) => i.id)).toEqual([IDS.anaShared]);
				expect(shared.items[0]).toMatchObject({
					isOwn: false,
					owner: { id: IDS.ana, name: "Ana" },
				});
			});

			it("opens a shared session, and not a private one or another organization's", async () => {
				const open = (id: string) =>
					getAgentConversationForViewer({
						id,
						userId: IDS.me,
						organizationId: IDS.org,
					});

				expect(await open(IDS.anaShared)).toMatchObject({
					isOwn: false,
				});
				expect(await open(IDS.anaPrivate)).toBeNull();
				expect(await open(IDS.elsewhere)).toBeNull();
			});

			it("lets only the owner change who can read a session", async () => {
				await expect(
					setAgentConversationVisibility({
						id: IDS.anaPrivate,
						userId: IDS.me,
						organizationId: IDS.org,
						visibility: "ORGANIZATION",
					}),
				).rejects.toBeInstanceOf(ConversationNotFoundError);

				const shared = await setAgentConversationVisibility({
					id: IDS.mine,
					userId: IDS.me,
					organizationId: IDS.org,
					visibility: "ORGANIZATION",
				});

				expect(shared.visibility).toBe("ORGANIZATION");
			});
		});

		describe("the policy (needs apply:rls)", () => {
			const asMember = (userId: string, tenantId = IDS.org) => ({
				type: "organization" as const,
				tenantId,
				userId,
			});

			it("is installed next to the owner's policy", async () => {
				const policies = await fixtures.$queryRaw<
					Array<{ policyname: string; cmd: string }>
				>`SELECT policyname::text, cmd::text FROM pg_policies WHERE tablename = 'agent_conversation'`;

				expect(
					policies.map((p) => [p.policyname, p.cmd]),
					"run `pnpm --filter @repo/database apply:rls`",
				).toEqual(
					expect.arrayContaining([
						["tenant_isolation", "ALL"],
						["organization_shared_read", "SELECT"],
					]),
				);
			});

			it("shows a member their own sessions and the shared ones, not a private one of another member", async () => {
				const seen = await asRlsRole(asMember(IDS.me), (tx) =>
					tx.agentConversation.findMany({
						where: { id: { in: conversationIds } },
					}),
				);

				expect(seen.map((c) => c.id).sort()).toEqual(
					[IDS.mine, IDS.anaShared].sort(),
				);
			});

			it("shows nothing of the organization to a member of another one", async () => {
				const seen = await asRlsRole(
					asMember(IDS.me, IDS.otherOrg),
					(tx) =>
						tx.agentConversation.findMany({
							where: { id: { in: conversationIds } },
						}),
				);

				expect(seen.map((c) => c.id)).toEqual([IDS.elsewhere]);
			});

			it("does not let a teammate update or delete a shared session", async () => {
				const outcome = await asRlsRole(
					asMember(IDS.me),
					async (tx) => ({
						updated: await tx.agentConversation.updateMany({
							where: { id: IDS.anaShared },
							data: { title: "hijacked" },
						}),
						deleted: await tx.agentConversation.deleteMany({
							where: { id: IDS.anaShared },
						}),
					}),
				);

				expect(outcome.updated.count).toBe(0);
				expect(outcome.deleted.count).toBe(0);
				const row = await fixtures.agentConversation.findUniqueOrThrow({
					where: { id: IDS.anaShared },
				});
				expect(row.title).toBe("Ana shared");
			});

			it("still lets the owner update their shared session", async () => {
				const outcome = await asRlsRole(asMember(IDS.ana), (tx) =>
					tx.agentConversation.updateMany({
						where: { id: IDS.anaShared },
						data: { title: "renamed" },
					}),
				);

				expect(outcome.count).toBe(1);
			});

			it("lets a member read a shared session and create their own continuation of it, and refuses one in another member's name", async () => {
				const outcome = await asRlsRole(
					asMember(IDS.me),
					async (tx) => {
						const parent = await tx.agentConversation.findFirst({
							where: { id: IDS.anaShared },
						});
						const own = await tx.agentConversation.create({
							data: {
								userId: IDS.me,
								organizationId: IDS.org,
								agentId: AGENT,
								visibility: "PRIVATE",
								parentConversationId: parent?.id,
							},
						});
						return { parent, own };
					},
				);

				expect(outcome.parent?.id).toBe(IDS.anaShared);
				expect(outcome.own).toMatchObject({
					userId: IDS.me,
					parentConversationId: IDS.anaShared,
				});
				await expect(
					asRlsRole(asMember(IDS.me), (tx) =>
						tx.agentConversation.create({
							data: {
								userId: IDS.ana,
								organizationId: IDS.org,
								agentId: AGENT,
								parentConversationId: IDS.anaShared,
							},
						}),
					),
				).rejects.toThrow();
			});
		});

		describe("continuing a session in a new chat", () => {
			const continueFor = (
				parentConversationId: string,
				userId = IDS.me,
			) =>
				continueConversationInNewChat({
					userId,
					organizationId: IDS.org,
					parentConversationId,
					ownSummary: "PROGRESS SO FAR",
				});

			it("continues a shared session of another member as the caller's own private chat", async () => {
				const created = await continueFor(IDS.anaShared);

				expect(created).toMatchObject({
					userId: IDS.me,
					organizationId: IDS.org,
					visibility: "PRIVATE",
					parentConversationId: IDS.anaShared,
					title: "Ana shared (continued)",
				});
				const stored =
					await fixtures.agentConversation.findUniqueOrThrow({
						where: { id: created.id },
					});
				expect(stored.userId).toBe(IDS.me);
			});

			it("continues the caller's own session", async () => {
				const created = await continueFor(IDS.mine);

				expect(created).toMatchObject({
					userId: IDS.me,
					parentConversationId: IDS.mine,
				});
			});

			it("does not continue another member's private session or another organization's", async () => {
				await expect(
					continueFor(IDS.anaPrivate),
				).rejects.toBeInstanceOf(ParentConversationNotFoundError);
				await expect(continueFor(IDS.elsewhere)).rejects.toBeInstanceOf(
					ParentConversationNotFoundError,
				);
				expect(
					await fixtures.agentConversation.count({
						where: {
							parentConversationId: { not: null },
							userId: IDS.me,
						},
					}),
				).toBe(0);
			});
		});

		describe("saving a turn into a session", () => {
			const turn = (executionId: string) => ({
				messages: [
					{
						id: `q-${executionId}`,
						role: "user" as const,
						content: "A question from the teammate",
						timestamp: "2026-10-15T10:00:00.000Z",
					},
					{
						id: `a-${executionId}`,
						role: "assistant" as const,
						content: "An answer",
						timestamp: "2026-10-15T10:00:05.000Z",
					},
				],
				execution: { id: executionId },
			});

			const saveFor = (conversationId: string, userId: string) =>
				saveConversationTurn({
					id: conversationId,
					userId,
					organizationId: IDS.org,
					...turn(`exec-${userId}-${conversationId}`),
				});

			const storedOf = async (id: string) => {
				const row = await fixtures.agentConversation.findUniqueOrThrow({
					where: { id },
					select: { messages: true, metadata: true },
				});
				return { messages: row.messages, metadata: row.metadata };
			};

			it("refuses a teammate's turn into a session its owner shared, and writes nothing to it", async () => {
				const before = await storedOf(IDS.anaShared);

				await expect(
					saveFor(IDS.anaShared, IDS.me),
				).rejects.toBeInstanceOf(ConversationNotFoundError);

				expect(await storedOf(IDS.anaShared)).toEqual(before);
			});

			it("refuses a turn into another member's private session and into another organization's, and writes nothing to either", async () => {
				const beforePrivate = await storedOf(IDS.anaPrivate);
				const beforeElsewhere = await storedOf(IDS.elsewhere);

				await expect(
					saveFor(IDS.anaPrivate, IDS.me),
				).rejects.toBeInstanceOf(ConversationNotFoundError);
				await expect(
					saveFor(IDS.elsewhere, IDS.me),
				).rejects.toBeInstanceOf(ConversationNotFoundError);

				expect(await storedOf(IDS.anaPrivate)).toEqual(beforePrivate);
				expect(await storedOf(IDS.elsewhere)).toEqual(beforeElsewhere);
			});

			it("still saves the owner's turn into their own shared session, so the refusal above is the owner check and not a broken save", async () => {
				const saved = await saveFor(IDS.anaShared, IDS.ana);

				expect(saved.addedMessages).toBe(2);
				const { messages } = await storedOf(IDS.anaShared);
				expect(Array.isArray(messages) ? messages : []).toHaveLength(2);
			});
		});
	},
);
