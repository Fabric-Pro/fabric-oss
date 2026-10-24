import {
	buildFabricContextUrl,
	buildFabricDocumentUrl,
	buildFabricProjectTabUrl,
	buildFabricStoryUrl,
	db,
	type FabricProjectTab,
	getProjectAccessContext,
} from "@repo/database";
import { tool } from "ai";
import { z } from "zod";
import type { ParlumeActionContext } from "./parlume-actions";
import { PARLUME_CHAT_POST_CHARS } from "./parlume-chat-reply";
import { parlumeActivityLog } from "./parlume-log";
import { postParlumeMeetingChat } from "./parlume-voice";
import { resolveProjectFeatureRef } from "./shared/project-feature-reads";

const CHAT_UNAVAILABLE_ERROR =
	"This meeting's chat is not available to Parlume. Say the content aloud instead.";
const MAX_POSTS_PER_TURN = 3;
const MAX_LINKS_PER_POST = 10;

const TABS: Record<string, FabricProjectTab> = {
	roadmap: "stories",
	stories: "stories",
	backlog: "stories",
	decisions: "decisions",
	documents: "documents",
	context: "context",
	sources: "context",
};

const linkSchema = z.object({
	kind: z
		.enum(["work_item", "document", "source", "project_tab"])
		.describe(
			"work_item: a feature or bug. document: a project document. source: a Context source. project_tab: roadmap, decisions, documents or context.",
		),
	ref: z
		.string()
		.min(1)
		.max(200)
		.describe(
			"work_item: an identifier such as F-123, or an id. document: its id or exact title. source: its id. project_tab: roadmap, decisions, documents or context.",
		),
	label: z
		.string()
		.max(120)
		.optional()
		.describe("Optional text to show instead of the item's own title."),
});

const inputSchema = z.object({
	text: z
		.string()
		.max(3_500)
		.optional()
		.describe(
			"Plain text to post, exactly as the participant asked. URLs in it are posted as written.",
		),
	links: z
		.array(linkSchema)
		.max(MAX_LINKS_PER_POST)
		.optional()
		.describe(
			"Fabric items to link. Each becomes a line with its title and full address.",
		),
});

type ChatLink = z.infer<typeof linkSchema>;
type ResolvedLink = { ref: string; title: string; url: string };
type Resolution =
	| { ok: true; title: string; url: string }
	| { ok: false; reason: string };

const NOT_FOUND = (kind: string): Resolution => ({
	ok: false,
	reason: `No such ${kind} in this project.`,
});

async function resolveLink(
	link: ChatLink,
	project: { projectId: string; organizationId: string | null },
): Promise<Resolution> {
	const ref = link.ref.trim();
	const { projectId, organizationId } = project;
	switch (link.kind) {
		case "work_item": {
			const row =
				(await resolveProjectFeatureRef(ref, projectId)) ??
				(await db.userStory.findFirst({
					where: { id: ref, projectId },
					select: {
						id: true,
						identifier: true,
						kind: true,
						title: true,
					},
				})) ??
				undefined;
			if (!row) {
				return NOT_FOUND("work item");
			}
			return {
				ok: true,
				title: `${row.identifier} · ${row.title}`,
				url: await buildFabricStoryUrl({
					projectId,
					storyId: row.id,
					organizationId,
				}),
			};
		}
		case "document": {
			const byId = await db.projectDocument.findFirst({
				where: { id: ref, projectId },
				select: { id: true, title: true },
			});
			const rows = byId
				? [byId]
				: await db.projectDocument.findMany({
						where: {
							projectId,
							title: { equals: ref, mode: "insensitive" },
						},
						select: { id: true, title: true },
						take: 2,
					});
			if (rows.length === 0) {
				return NOT_FOUND("document");
			}
			if (rows.length > 1) {
				return {
					ok: false,
					reason: "More than one document has that title; use its id.",
				};
			}
			return {
				ok: true,
				title: rows[0].title,
				url: await buildFabricDocumentUrl({
					projectId,
					documentId: rows[0].id,
					organizationId,
				}),
			};
		}
		case "source": {
			const row = await db.projectContext.findFirst({
				where: { id: ref, projectId },
				select: {
					id: true,
					sourceTitle: true,
					originalFilename: true,
				},
			});
			if (!row) {
				return NOT_FOUND("source");
			}
			return {
				ok: true,
				title: row.sourceTitle ?? row.originalFilename ?? "Source",
				url: await buildFabricContextUrl({
					projectId,
					contextId: row.id,
					organizationId,
				}),
			};
		}
		case "project_tab": {
			const tab = TABS[ref.toLowerCase()];
			if (!tab) {
				return {
					ok: false,
					reason: "Use roadmap, decisions, documents or context.",
				};
			}
			return {
				ok: true,
				title: ref.charAt(0).toUpperCase() + ref.slice(1).toLowerCase(),
				url: await buildFabricProjectTabUrl({
					projectId,
					tab,
					organizationId,
				}),
			};
		}
		default: {
			const unreachable: never = link.kind;
			return unreachable;
		}
	}
}

/**
 * Lays the message out: the participant's text, then one link per line. When
 * it does not fit the chat, the text is shortened first and links are dropped
 * from the end only if they alone are too long; a link is never cut in half.
 */
function composeMessage(
	text: string | undefined,
	links: ResolvedLink[],
): { message: string; dropped: ResolvedLink[] } {
	const kept = [...links];
	const dropped: ResolvedLink[] = [];
	const block = () =>
		kept.map((link) => `${link.title} — ${link.url}`).join("\n");
	while (kept.length > 0 && block().length > PARLUME_CHAT_POST_CHARS) {
		dropped.unshift(kept.pop() as ResolvedLink);
	}
	const lines = block();
	const room = PARLUME_CHAT_POST_CHARS - lines.length - (lines ? 2 : 0);
	const body = text?.trim() ?? "";
	const shown =
		body.length > room ? `${body.slice(0, Math.max(0, room - 1))}…` : body;
	return {
		message: [room > 0 ? shown : "", lines].filter(Boolean).join("\n\n"),
		dropped,
	};
}

/**
 * Sends one message to the meeting's chat for the current turn: resolves the
 * links, composes the message, sends it, and reports what was sent. `sent`
 * means the meeting provider queued it (`delivery: "queued"`); the bridge
 * confirms separately whether it appeared. At most three posts per turn; the
 * count lives in this closure, so each turn starts from zero.
 */
export function createParlumeMeetingChatPoster(context: ParlumeActionContext) {
	let posts = 0;
	return async (input: z.infer<typeof inputSchema>) => {
		if (posts >= MAX_POSTS_PER_TURN) {
			return {
				sent: false,
				error: `At most ${MAX_POSTS_PER_TURN} chat posts per answer.`,
			};
		}
		const text = input.text?.trim();
		if (!text && !input.links?.length) {
			return {
				sent: false,
				error: "Give some text or at least one link to send.",
			};
		}
		const access = await getProjectAccessContext(
			context.projectId,
			context.userId,
		);
		if (!access) {
			return {
				sent: false,
				error: "Project not found or access denied.",
			};
		}
		const project = {
			projectId: context.projectId,
			organizationId: access.organizationId,
		};
		const resolved: ResolvedLink[] = [];
		const unresolved: Array<{ ref: string; reason: string }> = [];
		for (const link of input.links ?? []) {
			let outcome: Resolution;
			try {
				outcome = await resolveLink(link, project);
			} catch {
				outcome = {
					ok: false,
					reason: "The address could not be built.",
				};
			}
			if (outcome.ok) {
				resolved.push({
					ref: link.ref,
					title: link.label?.trim() || outcome.title,
					url: outcome.url,
				});
			} else {
				unresolved.push({
					ref: link.ref,
					reason: outcome.reason,
				});
			}
		}
		if (!text && resolved.length === 0) {
			return { sent: false, links: [], unresolved };
		}
		const { message, dropped } = composeMessage(text, resolved);
		for (const link of dropped) {
			unresolved.push({
				ref: link.ref,
				reason: "Too long for one chat message.",
			});
		}
		posts++;
		const result = await postParlumeMeetingChat({
			sessionId: context.sessionId,
			turnId: context.turnId,
			message,
		});
		parlumeActivityLog(result.sent ? "info" : "warn", "chat.posted", {
			sessionId: context.sessionId,
			turnId: context.turnId,
			sent: result.sent,
			delivery: result.sent ? "queued" : null,
			reason: result.sent ? null : result.reason,
			tag: result.sent ? result.tag : null,
			post: posts,
			chars: message.length,
			links: resolved.length - dropped.length,
			unresolved: unresolved.length,
		});
		if (!result.sent) {
			return result.reason === "chat_unavailable"
				? {
						sent: false,
						delivered: false,
						reason: "chat_unavailable",
						error: CHAT_UNAVAILABLE_ERROR,
					}
				: {
						sent: false,
						error: "The chat message could not be sent.",
						unresolved,
					};
		}
		return {
			sent: true,
			delivery: "queued",
			tag: result.tag,
			links: resolved
				.filter((link) => !dropped.includes(link))
				.map(({ ref, title, url }) => ({ ref, title, url })),
			unresolved,
		};
	};
}

/**
 * Lets the agent write in the meeting's chat when a participant asks: a link
 * to a work item, a summary, anything. Links are resolved here, from the
 * meeting's own project and after an access check, so the address the model
 * returns is exact and cannot point outside the project. Allowed in every
 * mode: it changes nothing in Fabric.
 */
export function createParlumeMeetingChatTool(context: ParlumeActionContext) {
	return {
		post_to_meeting_chat: tool({
			description:
				"Write a message in the meeting's chat. Use it when a participant asks you to share, post, send or write something in the chat, or asks for a link. Pass links (with identifiers like F-123) to include exact full addresses; pass text for anything else they asked you to write. Never read an address aloud.",
			inputSchema,
			execute: createParlumeMeetingChatPoster(context),
		}),
	};
}
