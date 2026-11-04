import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import {
	appendWorkspaceDocumentChat,
	getWorkspaceDocumentChat,
} from "../prisma/queries/workspaces/document-chat";
import { createWorkspace } from "../prisma/queries/workspaces/workspaces";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const ids = {
	org: "docchat-org",
	otherOrg: "docchat-other-org",
	owner: "docchat-owner",
	reader: "docchat-reader",
};
let workspaceId: string;
const actor = (userId = ids.owner, organizationId = ids.org) => ({
	userId,
	organizationId,
	workspaceId,
});
const append = (question: string, userId = ids.owner) =>
	appendWorkspaceDocumentChat({
		...actor(userId),
		question,
		answer: `Answer: ${question}`,
		sources: [],
	});

describe.skipIf(
	process.env.RUN_DB_INTEGRATION !== "1" || !hasReachableDatabaseUrl(),
)("private workspace document chat against Postgres", () => {
	beforeAll(async () => {
		const now = new Date();
		for (const id of [ids.owner, ids.reader])
			await db.user.upsert({
				where: { id },
				update: {},
				create: {
					id,
					name: id,
					email: `${id}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
		for (const id of [ids.org, ids.otherOrg])
			await db.organization.upsert({
				where: { id },
				update: {},
				create: { id, name: id, slug: id, createdAt: now },
			});
		for (const userId of [ids.owner, ids.reader])
			await db.member.upsert({
				where: {
					organizationId_userId: { organizationId: ids.org, userId },
				},
				update: {},
				create: {
					id: `${userId}-member`,
					organizationId: ids.org,
					userId,
					role: "member",
					createdAt: now,
				},
			});
		const workspace = await createWorkspace({
			userId: ids.owner,
			organizationId: ids.org,
			name: "Document chat fixture",
		});
		workspaceId = workspace.id;
		await db.workspaceStakeholder.create({
			data: { workspaceId, userId: ids.reader, addedBy: ids.owner },
		});
	});
	beforeEach(async () => {
		await db.agentConversation.deleteMany({
			where: {
				organizationId: ids.org,
				agentId: "workspace-document-chat",
			},
		});
	});
	afterAll(async () => {
		await db.agentConversation.deleteMany({
			where: {
				organizationId: ids.org,
				agentId: "workspace-document-chat",
			},
		});
		if (workspaceId)
			await db.workspace.deleteMany({ where: { id: workspaceId } });
		await db.member.deleteMany({
			where: { organizationId: { in: [ids.org, ids.otherOrg] } },
		});
		await db.organization.deleteMany({
			where: { id: { in: [ids.org, ids.otherOrg] } },
		});
		await db.user.deleteMany({
			where: { id: { in: [ids.owner, ids.reader] } },
		});
	});
	it("restores a saved conversation and attaches it to the workspace chat count", async () => {
		await append("When does the rotation change?");
		const restored = await getWorkspaceDocumentChat(actor());
		expect(restored.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(restored.messages[1]?.content).toBe(
			"Answer: When does the rotation change?",
		);
		expect(
			await db.workspaceConversation.count({ where: { workspaceId } }),
		).toBe(1);
	});
	it("does not reveal a colleague's private transcript", async () => {
		await append("Private question");
		expect(
			(await getWorkspaceDocumentChat(actor(ids.reader))).messages,
		).toEqual([]);
		await append("Reader question", ids.reader);
		expect((await getWorkspaceDocumentChat(actor())).messages).toHaveLength(
			2,
		);
		expect(
			(await getWorkspaceDocumentChat(actor(ids.reader))).messages[0]
				?.content,
		).toBe("Reader question");
	});
	it("preserves both turns when requests append concurrently", async () => {
		await Promise.all([append("One"), append("Two"), append("Three")]);
		const messages = (await getWorkspaceDocumentChat(actor())).messages;
		expect(messages).toHaveLength(6);
		expect(
			messages
				.filter((message) => message.role === "user")
				.map((message) => message.content)
				.sort(),
		).toEqual(["One", "Three", "Two"]);
	});
	it("never overwrites another actor's row on a deterministic id conflict", async () => {
		const { id } = await getWorkspaceDocumentChat(actor());
		await db.agentConversation.create({
			data: {
				id,
				userId: ids.reader,
				organizationId: ids.org,
				agentId: "workspace-document-chat",
				messages: [
					{
						role: "assistant",
						content: "Colleague transcript",
						timestamp: new Date().toISOString(),
					},
				],
			},
		});
		await expect(append("Must not overwrite")).rejects.toThrow();
		expect(
			(await db.agentConversation.findUnique({ where: { id } }))?.userId,
		).toBe(ids.reader);
		expect(
			JSON.stringify(
				(await db.agentConversation.findUnique({ where: { id } }))
					?.messages,
			),
		).toContain("Colleague transcript");
	});

	it("refuses a wrong organization before reading or writing history", async () => {
		await append("Visible only in the hosting organization");
		await expect(
			getWorkspaceDocumentChat(actor(ids.owner, ids.otherOrg)),
		).rejects.toThrow("access denied");
		await expect(
			appendWorkspaceDocumentChat({
				...actor(ids.owner, ids.otherOrg),
				question: "Wrong tenant",
				answer: "Must not save",
				sources: [],
			}),
		).rejects.toThrow("access denied");
		expect((await getWorkspaceDocumentChat(actor())).messages).toHaveLength(
			2,
		);
	});
});
