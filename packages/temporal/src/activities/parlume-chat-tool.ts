import {
	buildFabricContextUrl,
	buildFabricDocumentUrl,
	buildFabricProjectTabUrl,
	buildFabricStoryUrl,
	db,
	type FabricProjectTab,
	getProjectAccessContext,
	withVisibleStories,
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
const ACCESS_DENIED_ERROR = "Project not found or access denied.";
const MAX_POSTS_PER_TURN = 3;
const MAX_LINKS_PER_POST = 10;

const OVERVIEW = { tab: "overview", title: "Overview" } as const;
const DAILY_BRIEF = { tab: "daily-brief", title: "Daily Brief" } as const;
const MEETING_DIGEST = {
	tab: "meeting-digest",
	title: "Meeting Digest",
} as const;
const RELEASE_NOTES = { tab: "release-notes", title: "Release Notes" } as const;
const TESTING = { tab: "test-cases", title: "Testing" } as const;
const ROADMAP = { tab: "stories", title: "Roadmap" } as const;
const CONTEXT = { tab: "context", title: "Context" } as const;
const INSTRUCTIONS = {
	tab: "coding-instructions",
	title: "Coding instructions",
} as const;
const TABS: Record<string, { tab: FabricProjectTab; title: string }> = {
	overview: OVERVIEW,
	"daily brief": DAILY_BRIEF,
	"daily-brief": DAILY_BRIEF,
	brief: DAILY_BRIEF,
	"meeting digest": MEETING_DIGEST,
	"meeting-digest": MEETING_DIGEST,
	digest: MEETING_DIGEST,
	"release notes": RELEASE_NOTES,
	"release-notes": RELEASE_NOTES,
	testing: TESTING,
	"test cases": TESTING,
	"test-cases": TESTING,
	roadmap: ROADMAP,
	stories: ROADMAP,
	backlog: ROADMAP,
	decisions: { tab: "decisions", title: "Decisions" },
	documents: { tab: "documents", title: "Documents" },
	context: CONTEXT,
	sources: CONTEXT,
	instructions: INSTRUCTIONS,
	"coding instructions": INSTRUCTIONS,
	"coding-instructions": INSTRUCTIONS,
};
const TAB_NAMES =
	"overview, daily brief, meeting digest, release notes, documents, decisions, context, roadmap, testing or instructions";

/** "the Coding Instructions page" names the "coding instructions" tab. */
function tabFor(ref: string) {
	const name = ref
		.toLowerCase()
		.replace(/^the\s+/, "")
		.replace(/\s+(?:page|tab)$/, "")
		.trim();
	return TABS[name];
}

const linkSchema = z.object({
	kind: z
		.enum([
			"work_item",
			"document",
			"source",
			"project_tab",
			"instructions_repository",
		])
		.describe(
			`work_item: a feature or bug. document: a project document. source: a Context source. project_tab: ${TAB_NAMES} (instructions is the project's Coding Instructions in Fabric). instructions_repository: the repository the project's Coding Instructions sync from.`,
		),
	ref: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe(
			`work_item: an identifier such as F-123, or an id. document: its id or exact title. source: its id. project_tab: ${TAB_NAMES}. instructions_repository: leave out.`,
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
type MeetingLinks = {
	resolved: ResolvedLink[];
	unresolved: Array<{ ref: string; reason: string }>;
};
type Resolution =
	| { ok: true; title: string; url: string }
	| { ok: false; reason: string };

const NOT_FOUND = (kind: string): Resolution => ({
	ok: false,
	reason: `No such ${kind} in this project.`,
});

/**
 * A repository's address as a browser opens it: https only, no credentials,
 * and without the `.git` a clone address ends with. Null for anything else.
 */
function repositoryWebUrl(repositoryUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(repositoryUrl);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password) {
		return null;
	}
	url.pathname = url.pathname.replace(/\.git$/, "");
	url.search = "";
	url.hash = "";
	return url.toString();
}

async function resolveLink(
	link: ChatLink,
	project: { projectId: string; organizationId: string | null },
): Promise<Resolution> {
	const ref = link.ref?.trim() ?? "";
	const { projectId, organizationId } = project;
	if (!ref && link.kind !== "instructions_repository") {
		return { ok: false, reason: "Name the item to link in ref." };
	}
	switch (link.kind) {
		case "work_item": {
			const row =
				(await resolveProjectFeatureRef(ref, projectId)) ??
				(await db.userStory.findFirst({
					where: withVisibleStories({ id: ref, projectId }),
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
			const tab = tabFor(ref);
			if (!tab) {
				return { ok: false, reason: `Use ${TAB_NAMES}.` };
			}
			return {
				ok: true,
				title: tab.title,
				url: await buildFabricProjectTabUrl({
					projectId,
					tab: tab.tab,
					organizationId,
				}),
			};
		}
		case "instructions_repository": {
			const sync = await db.projectInstructionRepositorySync.findUnique({
				where: { projectId },
				select: {
					repositoryIntegration: {
						select: {
							repositoryUrl: true,
							repositoryOwner: true,
							repositoryName: true,
						},
					},
				},
			});
			const repository = sync?.repositoryIntegration;
			const url = repository
				? repositoryWebUrl(repository.repositoryUrl)
				: null;
			if (!repository || !url) {
				return {
					ok: false,
					reason: "This project's Coding Instructions do not sync from a repository. Link project_tab instructions instead.",
				};
			}
			const name = [repository.repositoryOwner, repository.repositoryName]
				.filter(Boolean)
				.join("/");
			return {
				ok: true,
				title: name
					? `Coding instructions repository · ${name}`
					: "Coding instructions repository",
				url,
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
 * The exact address of each item, from the meeting's own project and after an
 * access check. Null when the inviter can no longer read the project.
 */
async function resolveMeetingLinks(
	context: ParlumeActionContext,
	links: ChatLink[],
): Promise<MeetingLinks | null> {
	const access = await getProjectAccessContext(
		context.projectId,
		context.userId,
	);
	if (!access) {
		return null;
	}
	const project = {
		projectId: context.projectId,
		organizationId: access.organizationId,
	};
	const resolved: ResolvedLink[] = [];
	const unresolved: Array<{ ref: string; reason: string }> = [];
	for (const link of links) {
		const ref = link.ref ?? link.kind;
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
				ref,
				title: link.label?.trim() || outcome.title,
				url: outcome.url,
			});
		} else {
			unresolved.push({ ref, reason: outcome.reason });
		}
	}
	return { resolved, unresolved };
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
		const links = await resolveMeetingLinks(context, input.links ?? []);
		if (!links) {
			return {
				sent: false,
				error: ACCESS_DENIED_ERROR,
			};
		}
		const { resolved, unresolved } = links;
		if (!text && resolved.length === 0) {
			return {
				sent: false,
				error: "Nothing was sent: none of the links could be found. Say so, with the reason given for each.",
				links: [],
				unresolved,
			};
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
 * to a work item, a summary, anything; and look up exact addresses for an
 * answer that is itself posted to the chat. Links are resolved here, from the
 * meeting's own project and after an access check, so the address the model
 * returns is exact and cannot point outside the project. Allowed in every
 * mode: neither changes anything in Fabric.
 */
export function createParlumeMeetingChatTool(context: ParlumeActionContext) {
	return {
		post_to_meeting_chat: tool({
			description:
				"Write a message in the meeting's chat. Use it when a participant asks you to share, post, send or write something in the chat, or asks for a link. Pass links (with identifiers like F-123) to include exact full addresses; pass text for anything else they asked you to write. Never read an address aloud.",
			inputSchema,
			execute: createParlumeMeetingChatPoster(context),
		}),
		get_meeting_links: tool({
			description:
				"Look up the exact full address of Fabric items in this meeting's project: work items, documents, Context sources, project tabs such as Coding Instructions, or the repository the Coding Instructions sync from. Use it whenever your answer includes a link, and copy each address exactly.",
			inputSchema: z.object({
				links: z.array(linkSchema).min(1).max(MAX_LINKS_PER_POST),
			}),
			execute: async ({ links }) =>
				(await resolveMeetingLinks(context, links)) ?? {
					error: ACCESS_DENIED_ERROR,
				},
		}),
	};
}
