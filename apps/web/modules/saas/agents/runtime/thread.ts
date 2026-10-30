import type { Message } from "@ag-ui/client";
import { ORPCError } from "@orpc/client";
import {
	authorizeInputOrganization,
	Permissions,
} from "@repo/api/orpc/procedures";
import {
	type ConversationMessage,
	createAgentConversation,
	db,
	getAgentConversationById,
} from "@repo/database";
import type { RuntimeCaller } from "./engine";

/**
 * A runtime thread is an `AgentConversation`: the thread id IS the
 * conversation id. A run on an id no conversation has yet creates the
 * caller's conversation under it; an id that names someone else's
 * conversation — another user's, or the same user's in another organization —
 * is never served.
 *
 * The id format is the one the chat routes accept for a client key; a
 * CopilotKit thread id (a UUID) and a stored conversation id (a cuid) both
 * match it.
 */
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export type ThreadAccess =
	/** The caller's conversation in the caller's organization. */
	| { kind: "owned" }
	/** No conversation has this id yet. */
	| { kind: "absent" }
	/** Someone else's, or not a valid thread id. */
	| { kind: "forbidden" };

/** Whether the caller may use this thread, by exact owner and tenant equality. */
export async function readThreadAccess(
	threadId: string,
	caller: Pick<RuntimeCaller, "userId" | "organizationId">,
): Promise<ThreadAccess> {
	if (!THREAD_ID_PATTERN.test(threadId)) {
		return { kind: "forbidden" };
	}
	const conversation = await db.agentConversation.findUnique({
		where: { id: threadId },
		select: { userId: true, organizationId: true },
	});
	if (!conversation) {
		return { kind: "absent" };
	}
	return conversation.userId === caller.userId &&
		conversation.organizationId === caller.organizationId
		? { kind: "owned" }
		: { kind: "forbidden" };
}

/**
 * Whether the caller's role in the organization grants `permission` — the
 * check the conversation procedures make before a conversation is created
 * (`AGENT_CREATE`) or written to (`AGENT_UPDATE`). An organization tie
 * without membership (a project guest) is refused here as it is there.
 */
async function mayWriteConversations(
	caller: RuntimeCaller,
	permission:
		| typeof Permissions.AGENT_CREATE
		| typeof Permissions.AGENT_UPDATE,
): Promise<boolean> {
	try {
		await authorizeInputOrganization(
			permission,
			caller.organizationId,
			{
				user: { id: caller.userId },
				session: { activeOrganizationId: caller.organizationId },
			},
			{ requireOrganization: true },
		);
		return true;
	} catch (error) {
		if (
			error instanceof ORPCError &&
			(error.code === "FORBIDDEN" || error.code === "UNAUTHORIZED")
		) {
			return false;
		}
		throw error;
	}
}

/**
 * The thread a run writes to: the caller's existing conversation, or a new
 * one created for the caller under the thread id. False when the thread is
 * someone else's or the caller may not write conversations here.
 */
export async function ensureThread(
	threadId: string,
	caller: RuntimeCaller,
	create: {
		agentId: string;
		title: string;
		metadata: Record<string, unknown>;
	},
): Promise<boolean> {
	const access = await readThreadAccess(threadId, caller);
	switch (access.kind) {
		case "forbidden":
			return false;
		case "owned":
			return mayWriteConversations(caller, Permissions.AGENT_UPDATE);
		case "absent":
			break;
		default: {
			const unhandled: never = access;
			throw new Error(
				`Unhandled thread access: ${JSON.stringify(unhandled)}`,
			);
		}
	}
	if (!(await mayWriteConversations(caller, Permissions.AGENT_CREATE))) {
		return false;
	}
	try {
		await createAgentConversation({
			id: threadId,
			userId: caller.userId,
			organizationId: caller.organizationId,
			agentId: create.agentId,
			title: create.title,
			metadata: create.metadata,
		});
		return true;
	} catch (error) {
		// Another request created it first: serve it only if it is the caller's.
		if ((await readThreadAccess(threadId, caller)).kind === "owned") {
			return true;
		}
		throw error;
	}
}

/** A conversation title from the first question, as the Direct chat names its own. */
export function threadTitle(question: string): string {
	return question.length > 50 ? `${question.slice(0, 50)}...` : question;
}

function storedMessages(value: unknown): ConversationMessage[] {
	return Array.isArray(value) ? value : [];
}

/** How many continuation generations below the thread's conversation are read. */
const CONTINUATION_DEPTH = 5;

/** The most continuation conversations one lookup reads, across all generations. */
const CONTINUATION_LIMIT = 20;

/**
 * Ids of every message saved under the thread: its own conversation's, and
 * those of the conversations continuing it (`parentConversationId`: a spill
 * at the turn cap, or a fork of it), up to `CONTINUATION_DEPTH` generations
 * and `CONTINUATION_LIMIT` conversations. An assistant's CopilotKit thread id
 * stays put across a spill (`assistant-thread.tsx`), so the turns after it are
 * saved in a continuation, not in the conversation the id names. Only the
 * caller's conversations in the caller's organization are read; an empty set
 * when the thread names none of them.
 */
export async function readThreadPersistedMessageIds(
	threadId: string,
	caller: Pick<RuntimeCaller, "userId" | "organizationId">,
): Promise<Set<string>> {
	const ids = new Set<string>();
	const own = await readThreadMessages(threadId, caller);
	if (!own) {
		return ids;
	}
	const addIds = (messages: ConversationMessage[]) => {
		for (const message of messages) {
			if (typeof message.id === "string") {
				ids.add(message.id);
			}
		}
	};
	addIds(own);
	let parents = [threadId];
	let read = 0;
	for (
		let depth = 0;
		depth < CONTINUATION_DEPTH &&
		parents.length > 0 &&
		read < CONTINUATION_LIMIT;
		depth++
	) {
		const continuations = await db.agentConversation.findMany({
			where: {
				parentConversationId: { in: parents },
				userId: caller.userId,
				organizationId: caller.organizationId,
			},
			select: { id: true, messages: true },
			orderBy: { createdAt: "asc" },
			take: CONTINUATION_LIMIT - read,
		});
		read += continuations.length;
		for (const continuation of continuations) {
			addIds(storedMessages(continuation.messages));
		}
		parents = continuations.map((continuation) => continuation.id);
	}
	return ids;
}

/**
 * The thread's saved messages (with the finished turn results the
 * conversation reader adds), or null when it is not the caller's.
 */
export async function readThreadMessages(
	threadId: string,
	caller: Pick<RuntimeCaller, "userId" | "organizationId">,
): Promise<ConversationMessage[] | null> {
	const conversation = await getAgentConversationById({
		id: threadId,
		userId: caller.userId,
		organizationId: caller.organizationId,
	});
	return conversation ? storedMessages(conversation.messages) : null;
}

/**
 * Saved messages in AG-UI's shape, for the `MESSAGES_SNAPSHOT` a connect
 * starts with: user and system text as they are, an answer with its tool
 * calls (each result as a tool message after it) and, where it was saved,
 * its reasoning before it. What the Direct chat keeps beside a message
 * (usage, model, limits, stream status, when it was stopped, how long it
 * reasoned, and each tool call's saved status, which AG-UI's tool calls do
 * not carry) rides along in `metadata.fabric`.
 */
export function threadSnapshotMessages(
	messages: ConversationMessage[],
): Message[] {
	return messages.flatMap(toAgUiMessages);
}

function toAgUiMessages(
	message: ConversationMessage & {
		reasoningText?: unknown;
		reasoningDurationMs?: unknown;
		streamStatus?: unknown;
		cancelledAt?: unknown;
	},
): Message[] {
	const toolStatus = Object.fromEntries(
		(message.toolCalls ?? []).flatMap((toolCall) =>
			toolCall.status ? [[toolCall.id, toolCall.status]] : [],
		),
	);
	const fabric = {
		timestamp: message.timestamp,
		...(message.metadata ? { metadata: message.metadata } : {}),
		...(typeof message.streamStatus === "string"
			? { streamStatus: message.streamStatus }
			: {}),
		...(typeof message.cancelledAt === "string"
			? { cancelledAt: message.cancelledAt }
			: {}),
		...(typeof message.reasoningDurationMs === "number"
			? { reasoningDurationMs: message.reasoningDurationMs }
			: {}),
		...(Object.keys(toolStatus).length > 0 ? { toolStatus } : {}),
	};
	switch (message.role) {
		case "user":
			return [
				{
					id: message.id,
					role: "user",
					content: message.content,
					metadata: { fabric },
				},
			];
		case "system":
			return [
				{
					id: message.id,
					role: "system",
					content: message.content,
					metadata: { fabric },
				},
			];
		case "assistant": {
			const reasoning: Message[] =
				typeof message.reasoningText === "string" &&
				message.reasoningText
					? [
							{
								id: `${message.id}:reasoning`,
								role: "reasoning",
								content: message.reasoningText,
							},
						]
					: [];
			const toolCalls = message.toolCalls ?? [];
			return [
				...reasoning,
				{
					id: message.id,
					role: "assistant",
					content: message.content,
					...(toolCalls.length > 0
						? {
								toolCalls: toolCalls.map((toolCall) => ({
									id: toolCall.id,
									type: "function" as const,
									function: {
										name: toolCall.name,
										arguments: JSON.stringify(
											toolCall.args ?? {},
										),
									},
								})),
							}
						: {}),
					metadata: { fabric },
				},
				...toolCalls
					.filter((toolCall) => toolCall.result !== undefined)
					.map(
						(toolCall): Message => ({
							id: `${toolCall.id}:result`,
							role: "tool",
							toolCallId: toolCall.id,
							content: toolCall.result ?? "",
							...(toolCall.status === "error"
								? { error: toolCall.result ?? "Tool failed" }
								: {}),
						}),
					),
			];
		}
		default: {
			// A role this reader does not know yet is left out rather than
			// failing the whole connect; a new declared role fails here at
			// compile time.
			const unhandled: never = message.role;
			console.warn("[Agent Runtime] Skipping a saved message", {
				role: unhandled,
			});
			return [];
		}
	}
}
