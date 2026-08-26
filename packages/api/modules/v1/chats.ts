/**
 * v1 Chats routes
 * GET /chats list AI chat sessions
 * GET /chats/:id get chat session details
 * POST /chats create chat
 * PATCH /chats/:id rename (or update title)
 * DELETE /chats/:id delete chat
 * POST /chats/:id/messages send a user message; runs the model
 * synchronously and returns the assistant reply
 */
import {
	convertToModelMessages,
	generateChatTitle,
	generateText,
	getAIModelWithMetadata,
} from "@repo/ai";
import {
	createAiChat,
	deleteAiChatForTenant,
	getAiChatByIdForTenant,
	getAiChatsByOrganizationId,
	getAiChatsByUserId,
	hasProjectAccess,
	updateAiChatForTenant,
} from "@repo/database";
import { AiUsageLimitExceededError } from "@repo/payments";
import type { Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import {
	badRequest,
	forbidden,
	notFound,
	ok,
	resolveV1Context,
} from "./helpers";

function mapChat(c: {
	id: string;
	title?: string | null;
	userId: string | null;
	organizationId?: string | null;
	createdAt: Date;
	updatedAt: Date;
}) {
	return {
		id: c.id,
		title: c.title ?? null,
		userId: c.userId ?? null,
		organizationId: c.organizationId ?? null,
		createdAt: c.createdAt.toISOString(),
		updatedAt: c.updatedAt.toISOString(),
	};
}

type StoredMessage = {
	id?: string;
	role: "user" | "assistant" | "system";
	parts?: Array<{ type: string; text?: string; [k: string]: unknown }>;
	content?: string;
	[k: string]: unknown;
};

/** Coerce the AiChat.messages JSON column into a UIMessage-shaped array. */
function readStoredMessages(value: unknown): StoredMessage[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value as StoredMessage[];
}

export function registerChatRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	app.get("/chats", requireScope("chats:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
		const offset = Number(c.req.query("offset") ?? 0);

		const chats = ctx.organizationId
			? await getAiChatsByOrganizationId({
					organizationId: ctx.organizationId,
					userId: ctx.userId,
					limit,
					offset,
				})
			: await getAiChatsByUserId({
					userId: ctx.userId,
					limit,
					offset,
				});

		return c.json(ok(chats.map(mapChat), { total: chats.length }));
	});

	app.get("/chats/:id", requireScope("chats:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const chat = await getAiChatByIdForTenant({
			id: c.req.param("id")!,
			userId: ctx.userId,
			organizationId: ctx.organizationId,
		});

		if (!chat) {
			return c.json(notFound("Chat"), 404);
		}
		return c.json(ok(mapChat(chat)));
	});

	/**
	 * POST /chats
	 * Creates a new AI chat session in the tenant context.
	 */
	app.post("/chats", requireScope("chats:write"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		let body: { title?: string; projectId?: string };
		try {
			body = await c.req.json();
		} catch {
			body = {};
		}

		const title = body.title?.trim();
		if (title && title.length > 200) {
			return c.json(
				badRequest("title must be 200 characters or fewer"),
				400,
			);
		}

		if (body.projectId) {
			const canAccess = await hasProjectAccess(
				body.projectId,
				ctx.userId,
				ctx.organizationId ?? undefined,
			);
			if (!canAccess) {
				return c.json(forbidden("No access to project"), 403);
			}
		}

		const chat = await createAiChat({
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? undefined,
			title: title || undefined,
			projectId: body.projectId,
		});

		return c.json(ok(mapChat(chat)), 201);
	});

	/**
	 * PATCH /chats/:id
	 * Updates a chat. Currently supports renaming via `title`.
	 */
	app.patch("/chats/:id", requireScope("chats:write"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		let body: { title?: string | null };
		try {
			body = await c.req.json();
		} catch {
			return c.json(badRequest("Invalid JSON body"), 400);
		}

		const updates: { title?: string | null } = {};
		if (body.title !== undefined) {
			if (body.title === null) {
				updates.title = null;
			} else {
				const trimmed = body.title.trim();
				if (!trimmed) {
					return c.json(badRequest("title cannot be empty"), 400);
				}
				if (trimmed.length > 200) {
					return c.json(
						badRequest("title must be 200 characters or fewer"),
						400,
					);
				}
				updates.title = trimmed;
			}
		}

		if (Object.keys(updates).length === 0) {
			return c.json(badRequest("No supported fields to update"), 400);
		}

		const updated = await updateAiChatForTenant({
			id: c.req.param("id")!,
			userId: ctx.userId,
			organizationId: ctx.organizationId,
			...updates,
		});

		if (!updated) {
			return c.json(notFound("Chat"), 404);
		}
		return c.json(ok(mapChat(updated)));
	});

	/**
	 * DELETE /chats/:id
	 * Deletes a chat the tenant owns.
	 */
	app.delete("/chats/:id", requireScope("chats:write"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const deleted = await deleteAiChatForTenant({
			id: c.req.param("id")!,
			userId: ctx.userId,
			organizationId: ctx.organizationId,
		});

		if (!deleted) {
			return c.json(notFound("Chat"), 404);
		}
		return c.json(ok({ id: c.req.param("id"), deleted: true }));
	});

	/**
	 * POST /chats/:id/messages
	 * Appends a user message, runs the model synchronously, persists the
	 * assistant reply, and returns it. Non-streaming on purpose — v1 SDK
	 * consumers wait for the turn to complete. Title is auto-generated on
	 * the first exchange (same behavior as the in-app chat).
	 */
	app.post("/chats/:id/messages", requireScope("chats:write"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		let body: { content?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json(badRequest("Invalid JSON body"), 400);
		}

		const content = body.content?.trim();
		if (!content) {
			return c.json(badRequest("content is required"), 400);
		}
		if (content.length > 100_000) {
			return c.json(
				badRequest("content must be under 100,000 characters"),
				400,
			);
		}

		const chatId = c.req.param("id")!;
		const chat = await getAiChatByIdForTenant({
			id: chatId,
			userId: ctx.userId,
			organizationId: ctx.organizationId,
		});
		if (!chat) {
			return c.json(notFound("Chat"), 404);
		}

		const existing = readStoredMessages(chat.messages);
		const userMessage: StoredMessage = {
			id: `msg_${Date.now()}_user`,
			role: "user",
			parts: [{ type: "text", text: content }],
		};
		const inputMessages = [...existing, userMessage];

		let modelResult: Awaited<ReturnType<typeof getAIModelWithMetadata>>;
		try {
			modelResult = await getAIModelWithMetadata(
				{ taskType: "CHAT" },
				{
					userId: ctx.userId,
					organizationId: chat.organizationId ?? undefined,
				},
			);
		} catch (err) {
			// AI usage-limit chokepoint hit a HARD limit. Surface the structured
			// payload so external API consumers see the rich error envelope and
			// can render the same toast contract on their side.
			if (err instanceof AiUsageLimitExceededError) {
				return c.json(
					{
						error: {
							message: err.message,
							code: "AI_USAGE_LIMIT_EXCEEDED",
							data: {
								limitId: err.limitId,
								dimension: err.dimension,
								window: err.window,
								used: err.used.toString(),
								max: err.max.toString(),
								manageLimitsUrl: err.manageLimitsUrl,
							},
						},
					},
					429,
				);
			}
			return c.json(
				{
					error: {
						message:
							err instanceof Error
								? err.message
								: "No AI provider configured",
						code: "AI_GATEWAY_MISSING",
					},
				},
				400,
			);
		}

		const { model: aiModel, trackUsage } = modelResult;
		trackUsage();

		let assistantText = "";
		try {
			const modelMessages = await convertToModelMessages(
				inputMessages as Parameters<typeof convertToModelMessages>[0],
			);
			const { text } = await generateText({
				model: aiModel,
				messages: modelMessages,
			});
			assistantText = text;
		} catch (err) {
			// AI usage-limit chokepoint can also be hit during the
			// generateText call itself (e.g., a different limit applies
			// at invocation time). Mirror the same structured-envelope
			// response as the model-resolution catch above.
			if (err instanceof AiUsageLimitExceededError) {
				return c.json(
					{
						error: {
							message: err.message,
							code: "AI_USAGE_LIMIT_EXCEEDED",
							data: {
								limitId: err.limitId,
								dimension: err.dimension,
								window: err.window,
								used: err.used.toString(),
								max: err.max.toString(),
								manageLimitsUrl: err.manageLimitsUrl,
							},
						},
					},
					429,
				);
			}
			return c.json(
				{
					error: {
						message:
							err instanceof Error
								? err.message
								: "Model invocation failed",
					},
				},
				500,
			);
		}

		const assistantMessage: StoredMessage = {
			id: `msg_${Date.now()}_assistant`,
			role: "assistant",
			parts: [{ type: "text", text: assistantText }],
		};

		// First-turn title generation, matching ai.addMessageToChat behavior.
		let nextTitle: string | undefined;
		if (!chat.title && existing.length === 0) {
			try {
				nextTitle = await generateChatTitle(content, {
					userId: ctx.userId,
					organizationId: chat.organizationId ?? undefined,
					projectId: chat.projectId ?? undefined,
				});
			} catch {
				nextTitle =
					content.length > 50
						? `${content.slice(0, 50)}...`
						: content;
			}
		}

		await updateAiChatForTenant({
			id: chatId,
			userId: ctx.userId,
			organizationId: ctx.organizationId,
			messages: [...inputMessages, assistantMessage],
			...(nextTitle ? { title: nextTitle } : {}),
		});

		return c.json(
			ok({
				chatId,
				assistantMessage: {
					id: assistantMessage.id,
					role: "assistant" as const,
					content: assistantText,
				},
			}),
		);
	});
}
