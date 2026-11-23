import { createHash, randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
	db,
	getBuiltInToolConfig,
	type Prisma,
	resolveWorkflowIntegrationForProvider,
} from "@repo/database";
import type { ParlumeMeetingSessionStatus } from "@repo/database/prisma/generated/enums";
import {
	executeMicrosoftTeamsTool,
	extractChannelThreadId,
	isShortTeamsMeetingUrl,
	teamsMeetingIdentity,
	teamsMeetingJoinUrl,
} from "@repo/integrations/microsoft";
import { z } from "zod";
import {
	type AuditRequestContext,
	recordAuditFromRequest,
} from "../../../lib/audit";
import {
	armParlumeMeetingBridge,
	getParlumeBridgeSettings,
	isTeamsMeetingUrl,
	leaveParlumeMeetingBot,
	ParlumeBridgeUnavailableError,
	ParlumeProviderError,
	startParlumeMeetingBot,
} from "./parlume-attendee";
import { parlumeChatTagStart } from "./parlume-chat-tags";
import { parlumeLog } from "./parlume-log";
import {
	findParlumeMeetingSessions,
	parlumeMeetingKey,
} from "./parlume-meeting-sessions";
import { notifyParlumeJoinFailure } from "./parlume-notices";
import {
	attendeeSourceToStored,
	resolveParlumeAttendeeSettings,
} from "./parlume-provider-settings";
import {
	PARLUME_VOICE_REQUIRED,
	resolveParlumeVoiceEngine,
} from "./parlume-readiness";
import type { ParlumeSuggestionAudience } from "./parlume-suggestion-audience";

const PARLUME_MAX_DURATION_MS = 4 * 60 * 60 * 1000;

/**
 * Parlume answers only while it can check everyone in the meeting, which it
 * does through the inviter's Microsoft Teams connection.
 */
const PARLUME_TEAMS_REQUIRED =
	"Parlume checks who is in the meeting through your Microsoft Teams connection. Connect Microsoft Teams in Settings → Integrations, then invite Parlume again.";
const PARLUME_TEAMS_RECONNECT =
	"Parlume could not use your Microsoft Teams connection to check who is in the meeting. Reconnect Microsoft Teams in Settings → Integrations, then invite Parlume again.";
export const FABRIC_AGENT_KIND = "FABRIC_AGENT";
export const TEMPLATE_INSTANCE_KIND = "TEMPLATE_INSTANCE";
export const FABRIC_AGENT_LABEL = "Fabric Agent — this project";

export type ParlumeAgentKind =
	| typeof FABRIC_AGENT_KIND
	| typeof TEMPLATE_INSTANCE_KIND;

function assertNever(value: never): never {
	throw new Error(`Unsupported Parlume agent kind: ${value}`);
}

const MEETING_ASSISTANT_SETTINGS = "Settings → Meeting assistant";

/** Why an invitation is refused when no meeting bot is configured. */
export const PARLUME_MEETING_BOT_REQUIRED = `Parlume has no meeting bot configured. Add an Attendee API key in ${MEETING_ASSISTANT_SETTINGS}.`;

/** Why an invitation is refused when the operator's media bridge is missing. */
export const PARLUME_PLATFORM_REQUIRED =
	"Parlume is not ready for invitations in this environment. Ask the Fabric operator to configure its media bridge.";

/**
 * What the person who invited Parlume is told when the start fails. Attendee's
 * own reason is bounded and carries no key; anything else stays generic (null),
 * since its message can name internals.
 */
function startFailureMessage(error: unknown): string | null {
	if (error instanceof ParlumeProviderError) {
		if (error.status === 401 || error.status === 403) {
			return `Attendee rejected the meeting bot's API key. Check it in ${MEETING_ASSISTANT_SETTINGS}.`;
		}
		return `Attendee refused the invitation (HTTP ${error.status})${error.detail ? `: ${error.detail}` : "."}`;
	}
	if (error instanceof ParlumeBridgeUnavailableError) {
		return "Parlume's media bridge is unavailable. Ask the Fabric operator to check it.";
	}
	return null;
}

/**
 * Why a start is refused while Parlume's bot is already in that meeting and
 * its session cannot be handed back. The refusal goes on to say why.
 */
export const PARLUME_ALREADY_IN_MEETING = "Parlume is already in this meeting.";

/** The session states in which Parlume's bot is in a meeting or on its way. */
const LIVE_SESSION_STATUSES = [
	"PENDING",
	"JOINING",
	"ACTIVE",
	"LEAVING",
] as const;

/**
 * Two starts for one meeting at once wait for each other on this advisory
 * lock class, keyed by the meeting, so the second sees the first's session.
 */
const PARLUME_START_ADVISORY_CLASS = 0x50726c6d;

/**
 * What a start gets while a session of the organization is live in its
 * meeting: null when that session is handed back, so a second invitation
 * from the project lands on the Parlume page of the bot already there, or
 * why the start is refused. A session that is leaving cannot take the
 * invitation, and one of another project is not this project's to show.
 */
function refusalForLiveSession(
	live: { status: ParlumeMeetingSessionStatus; projectId: string },
	projectId: string,
): string | null {
	if (live.projectId !== projectId) {
		return `${PARLUME_ALREADY_IN_MEETING} It was invited from another project.`;
	}
	switch (live.status) {
		case "PENDING":
		case "JOINING":
		case "ACTIVE":
			return null;
		case "LEAVING":
			return `${PARLUME_ALREADY_IN_MEETING} Its session is leaving; invite Parlume again once it has left.`;
		case "FINALIZING":
		case "STOP_FAILED":
		case "ENDED":
		case "FAILED":
			return PARLUME_ALREADY_IN_MEETING;
		default: {
			const unreachable: never = live.status;
			return unreachable;
		}
	}
}

/**
 * Match the original linked invitation first. A numeric short link can also
 * match the exact canonical identity Microsoft resolved, within this project.
 */
async function findLinkedSeriesId(
	projectId: string,
	meetingUrl: string,
	canonicalMeetingUrl: string | null,
): Promise<string | null> {
	const series = await db.projectLinkedMeeting.findFirst({
		where: {
			projectId,
			deactivatedAt: null,
			joinUrl: { equals: meetingUrl.trim(), mode: "insensitive" },
		},
		select: { id: true },
	});
	if (series) {
		return series.id;
	}
	const identity = canonicalMeetingUrl
		? teamsMeetingIdentity(canonicalMeetingUrl)
		: null;
	if (!identity) {
		return null;
	}
	const candidates = await db.projectLinkedMeeting.findMany({
		where: { projectId, deactivatedAt: null },
		select: { id: true, joinUrl: true },
	});
	const joinUrl = teamsMeetingJoinUrl(meetingUrl);
	const shortUrl =
		joinUrl && isShortTeamsMeetingUrl(joinUrl) ? joinUrl : null;
	const matches = candidates.filter(
		(candidate) =>
			teamsMeetingIdentity(candidate.joinUrl) === identity ||
			(shortUrl && teamsMeetingJoinUrl(candidate.joinUrl) === shortUrl),
	);
	if (matches.length > 1) {
		throw new ORPCError("CONFLICT", {
			message:
				"Several linked meeting records identify this Teams meeting. Use the full linked meeting invitation.",
		});
	}
	return matches[0]?.id ?? null;
}

async function resolveShortInvitation(
	input: StartParlumeMeetingSessionInput,
): Promise<{ joinUrl: string; integrationId: string } | null> {
	const meetingUrl = teamsMeetingJoinUrl(input.meetingUrl);
	if (!meetingUrl || !isShortTeamsMeetingUrl(meetingUrl)) {
		return null;
	}
	try {
		const integration = await resolveWorkflowIntegrationForProvider(
			"MICROSOFT_GRAPH",
			input.userId,
			input.organizationId,
		);
		if (!integration) {
			return null;
		}
		const result = z
			.object({ joinUrl: z.string() })
			.parse(
				await executeMicrosoftTeamsTool(
					"parlume_channel",
					{ kind: "canonical", meetingUrl },
					input.userId,
					input.organizationId,
					integration.id,
				),
			);
		return { joinUrl: result.joinUrl, integrationId: integration.id };
	} catch {
		// Unresolved identity is explicit in channel status; ordinary meeting
		// audio and provider chat still work without Graph consent.
		return null;
	}
}

/**
 * A session of this linked series whose bot is in the meeting or on its way,
 * whoever started it. An unresolved short invitation cannot be associated
 * with a linked series safely and is not checked through this identity.
 */
export async function findLiveParlumeSession(
	linkedMeetingId: string,
	client: Prisma.TransactionClient = db,
) {
	return client.parlumeMeetingSession.findFirst({
		where: { linkedMeetingId, status: { in: [...LIVE_SESSION_STATUSES] } },
		select: { id: true, status: true, projectId: true },
	});
}

/**
 * The organization's session that is live in the same meeting, if any: its
 * linked series, or the meeting its join link names. Two bots in one meeting
 * each count the other as a guest they cannot confirm, and both leave. Runs
 * in the transaction that creates the session, after the meeting's locks,
 * so of two starts at once only the first creates one and the second finds
 * it. The partial unique index on the stored meeting key backs this up.
 */
async function findLiveSessionUnderLock(
	tx: Prisma.TransactionClient,
	meeting: {
		organizationId: string;
		meetingKey: string | null;
		meetingUrl: string | null;
		linkedMeetingId: string | null;
	},
) {
	const keys = [
		meeting.linkedMeetingId && `series:${meeting.linkedMeetingId}`,
		meeting.meetingKey &&
			`meeting:${meeting.organizationId}:${meeting.meetingKey}`,
	]
		.filter((key): key is string => Boolean(key))
		.sort();
	// One at a time and in one order, so two starts cannot hold one each.
	for (const key of keys) {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PARLUME_START_ADVISORY_CLASS}::int, hashtext(${key}))`;
	}
	return (
		(meeting.linkedMeetingId
			? await findLiveParlumeSession(meeting.linkedMeetingId, tx)
			: null) ??
		(meeting.meetingUrl
			? (
					await findParlumeMeetingSessions(
						{
							organizationId: meeting.organizationId,
							meetingUrl: meeting.meetingUrl,
						},
						{ take: 20, statuses: LIVE_SESSION_STATUSES },
						tx,
					)
				)[0]
			: undefined) ??
		null
	);
}

function digestSessionToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export const sessionSelect = {
	id: true,
	agentKind: true,
	agentLabel: true,
	agentInstanceSId: true,
	status: true,
	wakePhrase: true,
	toolsReadOnly: true,
	suggestionsEnabled: true,
	suggestionAudience: true,
	endReason: true,
	lastError: true,
	channelChatStatus: true,
	channelChatError: true,
	joinedAt: true,
	pausedAt: true,
	pausedBy: true,
	confidential: true,
	confidentialSince: true,
	confidentialBy: true,
	hardStopAt: true,
	leaveRequestedAt: true,
	endedAt: true,
	transcriptContextId: true,
	transcriptDeletedAt: true,
	trigger: true,
	linkedMeeting: { select: { subject: true } },
	createdAt: true,
	updatedAt: true,
} as const;

export function isBoundToProject(
	toolConnections: unknown,
	projectId: string,
): boolean {
	return (
		getBuiltInToolConfig(toolConnections, "project-context")?.projectId ===
		projectId
	);
}

async function requireProjectAgent(input: {
	projectId: string;
	organizationId: string;
	userId: string;
	agentInstanceSId: string;
}) {
	const agent = await db.agentTemplateInstance.findFirst({
		where: {
			sId: input.agentInstanceSId,
			organizationId: input.organizationId,
			userId: input.userId,
			status: "ACTIVE",
		},
		orderBy: { version: "desc" },
		select: {
			id: true,
			sId: true,
			name: true,
			version: true,
			toolConnections: true,
		},
	});
	if (!agent || !isBoundToProject(agent.toolConnections, input.projectId)) {
		throw new ORPCError("NOT_FOUND", {
			message: "Project-bound Fabric Agent not found.",
		});
	}
	return agent;
}

async function resolveParlumeAgentSelection(input: {
	projectId: string;
	organizationId: string;
	userId: string;
	agentKind?: ParlumeAgentKind;
	agentInstanceSId?: string;
}) {
	const agentKind = input.agentKind ?? TEMPLATE_INSTANCE_KIND;
	switch (agentKind) {
		case FABRIC_AGENT_KIND:
			if (input.agentInstanceSId) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"The built-in Fabric Agent cannot be combined with a custom agent.",
				});
			}
			return {
				agentKind,
				agentLabel: FABRIC_AGENT_LABEL,
				agentInstanceSId: null,
				agentInstanceVersionId: null,
				agentInstanceVersion: null,
			};
		case TEMPLATE_INSTANCE_KIND: {
			if (!input.agentInstanceSId) {
				throw new ORPCError("BAD_REQUEST", {
					message: "Choose a custom Fabric Agent.",
				});
			}
			const agent = await requireProjectAgent({
				projectId: input.projectId,
				organizationId: input.organizationId,
				agentInstanceSId: input.agentInstanceSId,
				userId: input.userId,
			});
			return {
				agentKind,
				agentLabel: agent.name,
				agentInstanceSId: agent.sId,
				agentInstanceVersionId: agent.id,
				agentInstanceVersion: agent.version,
			};
		}
		default:
			return assertNever(agentKind);
	}
}

export interface StartParlumeMeetingSessionInput {
	projectId: string;
	/** The project's organization, already resolved and authorized by the caller. */
	organizationId: string;
	/** Whose permissions, voice provider and agents the session runs with. */
	userId: string;
	meetingUrl: string;
	agentKind?: ParlumeAgentKind;
	agentInstanceSId?: string;
	toolsReadOnly: boolean;
	suggestionsEnabled: boolean;
	/** Where suggestions and the recap go; MEETING means every participant sees them. */
	suggestionAudience: ParlumeSuggestionAudience;
	trigger: "MANUAL" | "AUTO";
	/**
	 * The linked series and occurrence an automatic join is for. A manual
	 * invitation leaves both out; its series is found from the meeting link.
	 */
	linkedMeetingId?: string;
	occurrenceStart?: Date;
	/**
	 * An automatic join's calendar invitation named someone outside the
	 * organization: the meeting counts as having a guest from the start.
	 */
	externalInvitees?: boolean;
	/**
	 * An automatic join's invitees from inside the organization, lower-cased:
	 * they may read the meeting's transcript.
	 */
	inviteeEmails?: string[];
}

/**
 * Create a Parlume session and send its bot into the meeting: the one start
 * path for an invitation a person makes and for a linked series' auto-join.
 *
 * The caller has already authorized `userId` on the project and checked the
 * Parlume flag. Every refusal and failure is an `ORPCError` whose message
 * says what to fix; a refusal happens before any session row exists, a
 * failure after the row was created and marked FAILED. Anything else that
 * escapes (a database outage) is not a decision about the meeting.
 *
 * An automatic join's session row carries its series and occurrence, which a
 * unique index makes one per occurrence: a second start for the same
 * occurrence fails the create with Prisma's P2002 before any bot exists.
 * A manual invitation to a linked series' meeting records that series too,
 * so neither path sends a second bot into a meeting one is already in.
 *
 * While the project's session is live in the meeting and not leaving, a
 * start sends no bot and returns that session with `alreadyInMeeting`, so a
 * second invitation lands on the same Parlume page.
 */
export async function startParlumeMeetingSession(
	input: StartParlumeMeetingSessionInput,
	auditContext: AuditRequestContext,
) {
	if (!isTeamsMeetingUrl(input.meetingUrl)) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Enter a Microsoft Teams meeting link.",
		});
	}
	const canonicalInvitation = await resolveShortInvitation(input);
	const linkedMeetingId =
		input.linkedMeetingId ??
		(await findLinkedSeriesId(
			input.projectId,
			input.meetingUrl,
			canonicalInvitation?.joinUrl ?? null,
		));

	const settings = getParlumeBridgeSettings();
	if (!settings) {
		throw new ORPCError("CONFLICT", {
			message: PARLUME_PLATFORM_REQUIRED,
		});
	}
	const attendee = await resolveParlumeAttendeeSettings(
		input.organizationId,
	).catch((error: unknown) => {
		parlumeLog("error", "start.attendee_settings_invalid", {
			error: error instanceof Error ? error.message : String(error),
		});
		throw new ORPCError("CONFLICT", {
			message: `Parlume's meeting bot settings could not be read. Check them in ${MEETING_ASSISTANT_SETTINGS}.`,
		});
	});
	if (!attendee) {
		throw new ORPCError("CONFLICT", {
			message: PARLUME_MEETING_BOT_REQUIRED,
		});
	}
	const teams = await resolveWorkflowIntegrationForProvider(
		"MICROSOFT_GRAPH",
		input.userId,
		input.organizationId,
	);
	if (!teams) {
		throw new ORPCError("CONFLICT", { message: PARLUME_TEAMS_REQUIRED });
	}
	// One cheap call: a connection whose token no longer works could check
	// no one, and Parlume would leave at the first join.
	try {
		await executeMicrosoftTeamsTool(
			"parlume_channel",
			{ kind: "me" },
			input.userId,
			input.organizationId,
			teams.id,
		);
	} catch {
		throw new ORPCError("CONFLICT", { message: PARLUME_TEAMS_RECONNECT });
	}

	const agent = await resolveParlumeAgentSelection({
		projectId: input.projectId,
		organizationId: input.organizationId,
		agentKind: input.agentKind,
		agentInstanceSId: input.agentInstanceSId,
		userId: input.userId,
	});
	if (
		!(await resolveParlumeVoiceEngine({
			userId: input.userId,
			organizationId: input.organizationId,
		}))
	) {
		throw new ORPCError("CONFLICT", {
			message: PARLUME_VOICE_REQUIRED,
		});
	}
	const streamToken = randomBytes(32).toString("base64url");
	const callbackToken = randomBytes(32).toString("base64url");
	// A link that names no meeting is not stored: kept as the web client's
	// bare path, it would continue the tags of every meeting stored that way.
	const chatMeetingUrl = teamsMeetingJoinUrl(
		canonicalInvitation?.joinUrl ?? input.meetingUrl,
	);
	const chatTagStart = chatMeetingUrl
		? await parlumeChatTagStart({
				organizationId: input.organizationId,
				meetingUrl: chatMeetingUrl,
			})
		: 1;
	const meetingKey = chatMeetingUrl
		? parlumeMeetingKey(chatMeetingUrl)
		: null;
	const hardStopAt = new Date(Date.now() + PARLUME_MAX_DURATION_MS);
	const claim = await db.$transaction(async (tx) => {
		const live = await findLiveSessionUnderLock(tx, {
			organizationId: input.organizationId,
			meetingKey,
			meetingUrl: chatMeetingUrl,
			linkedMeetingId,
		});
		if (live) {
			const refusal = refusalForLiveSession(live, input.projectId);
			if (refusal) {
				throw new ORPCError("CONFLICT", { message: refusal });
			}
			return { id: live.id, alreadyInMeeting: true };
		}
		const created = await tx.parlumeMeetingSession.create({
			data: {
				projectId: input.projectId,
				organizationId: input.organizationId,
				userId: input.userId,
				agentKind: agent.agentKind,
				agentLabel: agent.agentLabel,
				agentInstanceSId: agent.agentInstanceSId,
				agentInstanceVersionId: agent.agentInstanceVersionId,
				agentInstanceVersion: agent.agentInstanceVersion,
				streamTokenDigest: digestSessionToken(streamToken),
				callbackTokenDigest: digestSessionToken(callbackToken),
				attendeeSource: attendeeSourceToStored(attendee.source),
				toolsReadOnly: input.toolsReadOnly,
				suggestionsEnabled: input.suggestionsEnabled,
				suggestionAudience: input.suggestionAudience,
				hardStopAt,
				trigger: input.trigger,
				linkedMeetingId,
				occurrenceStart: input.occurrenceStart ?? null,
				externalInvitees: input.externalInvitees ?? false,
				inviteeEmails: input.inviteeEmails ?? [],
				meetingUrl: chatMeetingUrl,
				meetingKey,
				channelIntegrationId:
					canonicalInvitation &&
					extractChannelThreadId(canonicalInvitation.joinUrl)
						? canonicalInvitation.integrationId
						: null,
				channelChatStatus:
					chatMeetingUrl &&
					(extractChannelThreadId(chatMeetingUrl) ||
						isShortTeamsMeetingUrl(chatMeetingUrl))
						? "PENDING"
						: "ATTENDEE",
			},
			select: { id: true },
		});
		return { id: created.id, alreadyInMeeting: false };
	});
	if (claim.alreadyInMeeting) {
		parlumeLog("info", "start.already_in_meeting", {
			sessionId: claim.id,
			trigger: input.trigger,
		});
		return {
			session: await db.parlumeMeetingSession.findUniqueOrThrow({
				where: { id: claim.id },
				select: sessionSelect,
			}),
			alreadyInMeeting: true,
		};
	}
	const session = { id: claim.id };

	let providerBotId: string | null = null;
	try {
		await armParlumeMeetingBridge({
			settings,
			sessionId: session.id,
			hardStopAt,
			chatTagStart,
		});
		providerBotId = await startParlumeMeetingBot({
			settings,
			attendee,
			sessionId: session.id,
			meetingUrl: input.meetingUrl,
			streamToken,
			callbackToken,
			hardStopAt,
		});
		// A stop can arrive while the provider is creating the bot. Claim the
		// transition only from PENDING: a concurrent stop moves the row to
		// LEAVING, and the bot must then leave before we report it ended.
		const claimed = await db.parlumeMeetingSession.updateMany({
			where: { id: session.id, status: "PENDING" },
			data: { providerBotId, status: "JOINING" },
		});
		if (claimed.count === 0) {
			try {
				await leaveParlumeMeetingBot({ attendee, providerBotId });
				await db.parlumeMeetingSession.update({
					where: { id: session.id },
					data: {
						providerBotId,
						status: "LEAVING",
					},
				});
			} catch {
				await db.parlumeMeetingSession.update({
					where: { id: session.id },
					data: {
						providerBotId,
						status: "STOP_FAILED",
						lastError:
							"Parlume could not leave the meeting. Retry stop.",
					},
				});
			}
			return {
				session: await db.parlumeMeetingSession.findUniqueOrThrow({
					where: { id: session.id },
					select: sessionSelect,
				}),
				alreadyInMeeting: false,
			};
		}
		const started = await db.parlumeMeetingSession.findUniqueOrThrow({
			where: { id: session.id },
			select: sessionSelect,
		});
		recordAuditFromRequest(auditContext, {
			action: "project.parlume.session_started",
			category: "project",
			organizationId: input.organizationId,
			projectId: input.projectId,
			resource: { type: "parlume_meeting_session", id: session.id },
			metadata: {
				agentKind: agent.agentKind,
				agentLabel: agent.agentLabel,
				...(agent.agentInstanceSId
					? {
							agentInstanceSId: agent.agentInstanceSId,
							agentInstanceVersion: agent.agentInstanceVersion,
						}
					: {}),
				toolsReadOnly: input.toolsReadOnly,
				suggestionsEnabled: input.suggestionsEnabled,
				suggestionAudience: input.suggestionAudience,
				hardStopAt: hardStopAt.toISOString(),
				...(input.trigger === "AUTO"
					? {
							trigger: input.trigger,
							onBehalfOfUserId: input.userId,
							linkedMeetingId: input.linkedMeetingId,
							occurrenceStart:
								input.occurrenceStart?.toISOString(),
						}
					: {}),
			},
		});
		parlumeLog("info", "session.started", {
			sessionId: session.id,
			botId: providerBotId,
			agentKind: agent.agentKind,
			toolsReadOnly: input.toolsReadOnly,
			trigger: input.trigger,
			hardStopAt: hardStopAt.toISOString(),
		});
		return { session: started, alreadyInMeeting: false };
	} catch (error) {
		parlumeLog("error", "start.failed", {
			sessionId: session.id,
			botId: providerBotId,
			error: error instanceof Error ? error.message : String(error),
		});
		if (providerBotId) {
			try {
				await leaveParlumeMeetingBot({ attendee, providerBotId });
			} catch {
				// The persisted FAILED state below is the operator's signal to
				// reconcile a bot that could not be cleaned up after a DB error.
			}
		}
		const failureMessage = startFailureMessage(error);
		const markedFailed = await db.parlumeMeetingSession.updateMany({
			where: { id: session.id, status: "PENDING" },
			data: {
				status: "FAILED",
				endReason: "START_FAILED",
				lastError:
					failureMessage ??
					"Parlume could not start. Retry after checking its operator configuration.",
				endedAt: new Date(),
			},
		});
		// A person who invited Parlume reads the refusal on the page; an
		// automatic join has nobody watching, so its enabler is told.
		if (markedFailed.count > 0 && input.trigger === "AUTO") {
			await notifyParlumeJoinFailure(session.id);
		}
		if (markedFailed.count === 0 && !providerBotId) {
			// A stop arrived before the provider returned an id and provider
			// creation failed, so there is no bot left for the start request to
			// reconcile. Finish the requested stop rather than stranding it in
			// LEAVING forever.
			await db.parlumeMeetingSession.updateMany({
				where: { id: session.id, status: "LEAVING" },
				data: { status: "ENDED", endedAt: new Date() },
			});
		}
		throw new ORPCError(
			error instanceof ParlumeProviderError
				? "BAD_GATEWAY"
				: "INTERNAL_SERVER_ERROR",
			{
				message:
					failureMessage ?? "Parlume could not join the meeting.",
			},
		);
	}
}
