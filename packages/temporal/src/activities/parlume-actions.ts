import { randomUUID } from "node:crypto";
import {
	buildParlumeActionUrl,
	canEditProject,
	db,
	hasProjectAccess,
} from "@repo/database";
import { BUILT_IN_TO_FABRIC_TOOLS } from "@repo/database/prisma/queries/lib/built-in-tool-map";
import { classifyReadOnlyToolAccess } from "@repo/utils/read-only-mode";
import {
	foreignProjectId,
	isFabricPortalProjectTool,
} from "../lib/fabric-portal-tools";
import {
	describeParlumeChange,
	parlumeActionArguments,
	parlumeFingerprint,
	parlumeToolFingerprint,
} from "./parlume-action-policy";
import { createParlumeMeetingChatTool } from "./parlume-chat-tool";
import { parlumeActivityLog } from "./parlume-log";
import {
	PARLUME_PROPOSAL_TTL_MS,
	parlumeProposalSpoken,
	parlumeProposalText,
} from "./parlume-proposal";
import { postParlumeProposal } from "./parlume-voice";
import {
	type AgentToolInvocation,
	type AgentToolRuntime,
	RUNTIME_TOOL_CONFIG_ID,
} from "./shared/agent-tool-runtime";
import { FABRIC_PLATFORM_CONFIG_ID } from "./shared/fabric-confirmation";

export interface ParlumeActionContext {
	turnId: string;
	sessionId: string;
	projectId: string;
	organizationId: string;
	userId: string;
	speakerId: string | null;
	speakerName: string | null;
	/** The request as asked, which a proposal quotes. */
	requestText: string;
	agentRevision: string;
	voiceGeneration: number;
	toolsReadOnly: boolean;
	signal?: AbortSignal;
	/** Where the tags of proposals this turn posted are collected. */
	proposalTags?: string[];
	/**
	 * A question a member asked on the Parlume page. Its answer and its
	 * proposals stay on the page: nothing is posted in the meeting, and the
	 * voice moving on to another request does not end it.
	 */
	pageOnly?: boolean;
}

/** Recorded for a change asked for by a speaker Teams gave no identity for. */
const UNATTRIBUTED_SPEAKER = "unattributed";

/** The built-in tools that read, or propose changes to, the project alone. */
const PROJECT_BUILT_IN_TOOLS: ReadonlySet<string> = new Set([
	...(BUILT_IN_TO_FABRIC_TOOLS["project-context"] ?? []),
	...(BUILT_IN_TO_FABRIC_TOOLS["create-story"] ?? []),
]);

/**
 * A meeting turn's ceiling is plain project read, whoever is in the meeting:
 * Fabric's own tools for the meeting's project, whose reads every project
 * reader has and whose changes are only proposed. Anything the inviter holds
 * above that is left out: organization-wide workflows, frames and pages,
 * connected servers and integrations, Databricks knowledge, workspaces, and
 * tools that spend (web search, images, code). The project's sources already
 * leave out raw meeting transcripts and confidential series for every turn.
 */
function mayUseInMeeting(source: AgentToolInvocation["source"]) {
	switch (source.configId) {
		case FABRIC_PLATFORM_CONFIG_ID:
			return isFabricPortalProjectTool(source.originalName);
		case "builtin":
			return PROJECT_BUILT_IN_TOOLS.has(source.originalName);
		default:
			return false;
	}
}

/**
 * Where a proposed change's tool comes from when a member can confirm it: Fabric's
 * own tools, which run again as that member. A connected server's tool would
 * still run with the inviter's connection.
 */
const CONFIRMABLE_SOURCES: ReadonlySet<string> = new Set([
	FABRIC_PLATFORM_CONFIG_ID,
	"builtin",
]);

async function sessionIsCurrent(
	context: ParlumeActionContext,
): Promise<boolean> {
	if (context.signal?.aborted) {
		return false;
	}
	const [session, access] = await Promise.all([
		db.parlumeMeetingSession.findFirst({
			where: {
				id: context.sessionId,
				projectId: context.projectId,
				organizationId: context.organizationId,
				userId: context.userId,
				status: "ACTIVE",
				...(context.pageOnly
					? {}
					: { voiceGeneration: context.voiceGeneration }),
			},
			select: { toolsReadOnly: true },
		}),
		context.toolsReadOnly
			? hasProjectAccess(
					context.projectId,
					context.userId,
					context.organizationId,
				)
			: canEditProject(context.projectId, context.userId),
	]);
	return Boolean(
		session && access && session.toolsReadOnly === context.toolsReadOnly,
	);
}

/**
 * Whether the call names a project other than the meeting's own. Fabric's own
 * tools and built-in tools take a `projectId` argument that a participant must
 * not be able to point elsewhere.
 */
function namesOtherProject(
	context: ParlumeActionContext,
	invocation: AgentToolInvocation,
): boolean {
	return foreignProjectId(invocation.args, context.projectId) !== null;
}

export function createParlumeToolRuntime(
	context: ParlumeActionContext,
): AgentToolRuntime {
	return {
		projectScope: {
			projectId: context.projectId,
			userId: context.userId,
			organizationId: context.organizationId,
		},
		abortSignal: context.signal,
		deferStoryDrafting: true,
		tools: createParlumeMeetingChatTool(context),
		invoke: async (invocation: AgentToolInvocation) => {
			if (!(await sessionIsCurrent(context))) {
				return {
					error: "The meeting request was interrupted or access changed. Ask again.",
				};
			}
			// Writing in the meeting chat changes nothing in Fabric, so it is
			// open to a read-only meeting.
			if (invocation.source.configId === RUNTIME_TOOL_CONFIG_ID) {
				return invocation.execute();
			}
			if (!mayUseInMeeting(invocation.source)) {
				return {
					error: "In a meeting I use only what every project member can read. Ask for this in the agent chat.",
				};
			}
			if (
				invocation.source.configId === FABRIC_PLATFORM_CONFIG_ID &&
				namesOtherProject(context, invocation)
			) {
				return {
					error: "This meeting can only use its own project.",
				};
			}
			if (
				invocation.delegates ||
				(invocation.source.access ??
					classifyReadOnlyToolAccess(
						invocation.source.originalName,
					)) === "READ"
			) {
				return invocation.execute();
			}
			if (context.toolsReadOnly) {
				return {
					error: "This meeting is read-only. Invite Parlume with actions enabled to request changes.",
				};
			}
			if (
				invocation.source.configId === "builtin" &&
				namesOtherProject(context, invocation)
			) {
				return {
					error: "This meeting can only change its own project.",
				};
			}
			return proposeParlumeAction(context, invocation);
		},
	};
}

/**
 * The proposal holds only what its tool sets. Left to itself, the agent
 * said what a request left out in some meetings and not in others.
 */
const PROPOSAL_LEAVES_OUT =
	"If the request also asked for something this proposal does not do, such as syncing the item to another tool, assigning it to someone or notifying people, add in that sentence that those parts are not done, naming each, ending it as in '…; syncing it to the tracker and assigning it to Sam are not done.'";

/**
 * Records a change a speaker asked for as a proposal, and posts it to the
 * meeting chat with its Confirm and Dismiss links. Nothing is changed: the
 * change runs only once a signed-in member with edit rights confirms it in
 * Fabric, and then as that member. The record is the claim that keeps one
 * call from being proposed twice in a turn.
 */
async function proposeParlumeAction(
	context: ParlumeActionContext,
	invocation: AgentToolInvocation,
) {
	if (!CONFIRMABLE_SOURCES.has(invocation.source.configId)) {
		return {
			changed: false,
			error: "This change goes through a connection that a member cannot confirm in Fabric, so it was not proposed. Ask for it in the agent chat.",
		};
	}
	let args: ReturnType<typeof parlumeActionArguments>;
	try {
		args = parlumeActionArguments(invocation.args);
	} catch (error) {
		return {
			error:
				error instanceof Error
					? error.message
					: "This action cannot be made by voice.",
		};
	}
	const invocationKey = parlumeFingerprint({ name: invocation.name, args });
	const actionId = randomUUID();
	const summary = describeParlumeChange(invocation.name, args);
	const created = await db.parlumeAction.createMany({
		data: {
			id: actionId,
			turnId: context.turnId,
			sessionId: context.sessionId,
			projectId: context.projectId,
			organizationId: context.organizationId,
			userId: context.userId,
			speakerId: context.speakerId ?? UNATTRIBUTED_SPEAKER,
			speakerName: context.speakerName,
			invocationKey,
			toolName: invocation.name,
			toolConfigId: invocation.source.configId,
			toolOriginalName: invocation.source.originalName,
			toolFingerprint: parlumeToolFingerprint(invocation),
			agentRevision: context.agentRevision,
			arguments: args,
			summary,
			status: "PROPOSED",
			expiresAt: new Date(Date.now() + PARLUME_PROPOSAL_TTL_MS),
		},
		skipDuplicates: true,
	});
	if (created.count === 0) {
		const earlier = await db.parlumeAction.findUnique({
			where: {
				turnId_invocationKey: { turnId: context.turnId, invocationKey },
			},
		});
		return {
			alreadyProposed: true,
			changed: false,
			status: earlier?.status.toLowerCase(),
			instruction:
				"This exact change was already proposed in this turn. Do not propose it again.",
		};
	}
	// A page question's proposal waits on the page, with its Confirm and
	// Dismiss buttons, and is never posted in the meeting.
	const posted = context.pageOnly
		? ({ sent: false, reason: "page" } as const)
		: await postProposal(context, {
				actionId,
				summary,
				args,
			});
	parlumeActivityLog(posted.sent ? "info" : "warn", "action.proposed", {
		sessionId: context.sessionId,
		turnId: context.turnId,
		actionId,
		toolName: invocation.name,
		posted: posted.sent,
		tag: posted.sent ? posted.tag : null,
	});
	if (posted.sent) {
		await db.parlumeAction.update({
			where: { id: actionId },
			data: { chatTag: posted.tag, presentedAt: new Date() },
		});
		context.proposalTags?.push(posted.tag);
	}
	return {
		proposed: true,
		changed: false,
		instruction: posted.sent
			? `This change was not made. It is proposed as ${posted.tag} in the meeting chat, where a signed-in project member confirms it in Fabric. Say in one sentence that ${posted.tag} waits for a member to confirm it in Fabric. ${PROPOSAL_LEAVES_OUT} Do not call this tool again in this turn.`
			: `This change was not made. It waits on the Parlume page in Fabric, where a signed-in project member confirms it. Say so in one sentence. ${PROPOSAL_LEAVES_OUT} Do not call this tool again in this turn.`,
	};
}

async function postProposal(
	context: ParlumeActionContext,
	proposal: {
		actionId: string;
		summary: string;
		args: Record<string, unknown>;
	},
) {
	try {
		const scope = {
			projectId: context.projectId,
			organizationId: context.organizationId,
			actionId: proposal.actionId,
		};
		const [project, confirmUrl, dismissUrl] = await Promise.all([
			db.project.findUnique({
				where: { id: context.projectId },
				select: { name: true },
			}),
			buildParlumeActionUrl(scope),
			buildParlumeActionUrl({ ...scope, intent: "dismiss" }),
		]);
		return await postParlumeProposal({
			sessionId: context.sessionId,
			turnId: context.turnId,
			voiceGeneration: context.voiceGeneration,
			actionId: proposal.actionId,
			message: parlumeProposalText({
				summary: proposal.summary,
				projectName: project?.name ?? "this project",
				asker: context.speakerName,
				request: context.requestText,
				args: proposal.args,
				confirmUrl,
				dismissUrl,
			}),
			spoken: parlumeProposalSpoken(proposal.summary),
			confirmUrl,
			dismissUrl,
		});
	} catch {
		return { sent: false, reason: "failed" } as const;
	}
}
