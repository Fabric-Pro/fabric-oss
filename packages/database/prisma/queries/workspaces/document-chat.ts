import { createHash } from "node:crypto";
import { z } from "zod";
import { db, Prisma } from "../../client";
import { getWorkspaceAccessContext } from "./workspaces";

const sourceSchema = z.object({
	filename: z.string(),
	pageNumber: z.number().optional(),
	chunkIndex: z.number(),
	score: z.number(),
	content: z.string(),
});
const messageSchema = z.object({
	role: z.enum(["user", "assistant"]),
	content: z.string(),
	timestamp: z.string(),
	sources: z.array(sourceSchema).optional(),
});
export type WorkspaceChatSource = z.infer<typeof sourceSchema>;
export type WorkspaceChatMessage = z.infer<typeof messageSchema>;
type Actor = { workspaceId: string; userId: string; organizationId: string };
const conversationId = (actor: Actor) =>
	`workspace-chat-${createHash("sha256")
		.update(
			JSON.stringify([
				actor.organizationId,
				actor.workspaceId,
				actor.userId,
			]),
		)
		.digest("hex")}`;
const messagesOf = (value: unknown): WorkspaceChatMessage[] =>
	Array.isArray(value)
		? value.flatMap((item) => {
				const parsed = messageSchema.safeParse(item);
				return parsed.success ? [parsed.data] : [];
			})
		: [];
export class WorkspaceDocumentChatAccessError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkspaceDocumentChatAccessError";
	}
}
async function authorize(actor: Actor) {
	const access = await getWorkspaceAccessContext(
		actor.workspaceId,
		actor.userId,
	);
	if (
		!actor.organizationId ||
		access?.organizationId !== actor.organizationId
	)
		throw new WorkspaceDocumentChatAccessError(
			"Workspace not found or access denied",
		);
}

/** A person's private document conversation; never another member's transcript. */
export async function getWorkspaceDocumentChat(actor: Actor) {
	await authorize(actor);
	const row = await db.agentConversation.findFirst({
		where: {
			id: conversationId(actor),
			userId: actor.userId,
			organizationId: actor.organizationId,
		},
		select: { id: true, messages: true },
	});
	return {
		id: row?.id ?? conversationId(actor),
		messages: messagesOf(row?.messages),
	};
}

/** Serialize appends so simultaneous document-chat requests cannot erase a turn. */
export async function appendWorkspaceDocumentChat(
	actor: Actor & {
		question: string;
		answer: string;
		sources: WorkspaceChatSource[];
	},
) {
	await authorize(actor);
	const id = conversationId(actor);
	return db.$transaction(async (tx) => {
		await tx.$executeRaw(
			Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`,
		);
		const row = await tx.agentConversation.findFirst({
			where: {
				id,
				userId: actor.userId,
				organizationId: actor.organizationId,
			},
			select: { messages: true },
		});
		const timestamp = new Date().toISOString();
		const turn: WorkspaceChatMessage[] = [
			{ role: "user", content: actor.question, timestamp },
			{
				role: "assistant",
				content: actor.answer,
				sources: actor.sources,
				timestamp,
			},
		];
		const messages = [...messagesOf(row?.messages), ...turn].slice(-100);
		if (row) {
			const updated = await tx.agentConversation.updateMany({
				where: {
					id,
					userId: actor.userId,
					organizationId: actor.organizationId,
				},
				data: { messages },
			});
			if (updated.count !== 1)
				throw new WorkspaceDocumentChatAccessError(
					"Workspace conversation is unavailable",
				);
		} else {
			// A conflicting id fails the unique constraint; it must never update another actor's row.
			await tx.agentConversation.create({
				data: {
					id,
					userId: actor.userId,
					organizationId: actor.organizationId,
					agentId: "workspace-document-chat",
					title: actor.question.slice(0, 100),
					messages,
				},
			});
		}
		await tx.workspaceConversation.upsert({
			where: {
				workspaceId_conversationId: {
					workspaceId: actor.workspaceId,
					conversationId: id,
				},
			},
			create: {
				workspaceId: actor.workspaceId,
				conversationId: id,
				attachedBy: actor.userId,
				allowedDocumentIds: [],
				accessLevel: "READ",
			},
			update: {},
		});
		return { id, messages };
	});
}
