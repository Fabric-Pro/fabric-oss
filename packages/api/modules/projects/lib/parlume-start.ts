import { createHash, createHmac, randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { db, getBuiltInToolConfig } from "@repo/database";
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
import { parlumeLog } from "./parlume-log";
import { resolveParlumeAttendeeSettings } from "./parlume-provider-settings";
import {
	PARLUME_VOICE_REQUIRED,
	resolveParlumeVoiceEngine,
} from "./parlume-readiness";

const PARLUME_MAX_DURATION_MS = 4 * 60 * 60 * 1000;
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

/** Why a start is refused while Parlume's bot is already in that meeting. */
export const PARLUME_ALREADY_IN_MEETING = "Parlume is already in this meeting.";

/** The session states in which Parlume's bot is in a meeting or on its way. */
const LIVE_SESSION_STATUSES = [
	"PENDING",
	"JOINING",
	"ACTIVE",
	"LEAVING",
] as const;

/**
 * The project's linked series whose join link this meeting link is, compared
 * the way the auto-join planner matches calendar occurrences (case and
 * surrounding spaces ignored).
 */
async function findLinkedSeriesId(
	projectId: string,
	meetingUrl: string,
): Promise<string | null> {
	const series = await db.projectLinkedMeeting.findFirst({
		where: {
			projectId,
			deactivatedAt: null,
			joinUrl: { equals: meetingUrl.trim(), mode: "insensitive" },
		},
		select: { id: true },
	});
	return series?.id ?? null;
}

/**
 * A session of this linked series whose bot is in the meeting or on its way,
 * whoever started it. Sessions do not store their meeting link, so a meeting
 * that is not a linked series cannot be checked this way.
 */
export async function findLiveParlumeSession(linkedMeetingId: string) {
	return db.parlumeMeetingSession.findFirst({
		where: { linkedMeetingId, status: { in: [...LIVE_SESSION_STATUSES] } },
		select: { id: true, status: true },
	});
}

function digestStreamToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function callbackSecret(serviceSecret: string, sessionId: string): string {
	return createHmac("sha256", serviceSecret)
		.update(`parlume-callback:${sessionId}`)
		.digest("base64url");
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
	endReason: true,
	lastError: true,
	joinedAt: true,
	hardStopAt: true,
	leaveRequestedAt: true,
	endedAt: true,
	transcriptContextId: true,
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
	trigger: "MANUAL" | "AUTO";
	/**
	 * The linked series and occurrence an automatic join is for. A manual
	 * invitation leaves both out; its series is found from the meeting link.
	 */
	linkedMeetingId?: string;
	occurrenceStart?: Date;
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
	const linkedMeetingId =
		input.linkedMeetingId ??
		(await findLinkedSeriesId(input.projectId, input.meetingUrl));
	if (linkedMeetingId && (await findLiveParlumeSession(linkedMeetingId))) {
		throw new ORPCError("CONFLICT", {
			message: PARLUME_ALREADY_IN_MEETING,
		});
	}

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
	const hardStopAt = new Date(Date.now() + PARLUME_MAX_DURATION_MS);
	const session = await db.parlumeMeetingSession.create({
		data: {
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			agentKind: agent.agentKind,
			agentLabel: agent.agentLabel,
			agentInstanceSId: agent.agentInstanceSId,
			agentInstanceVersionId: agent.agentInstanceVersionId,
			agentInstanceVersion: agent.agentInstanceVersion,
			streamTokenDigest: digestStreamToken(streamToken),
			toolsReadOnly: input.toolsReadOnly,
			suggestionsEnabled: input.suggestionsEnabled,
			hardStopAt,
			trigger: input.trigger,
			linkedMeetingId,
			occurrenceStart: input.occurrenceStart ?? null,
		},
		select: { id: true },
	});

	let providerBotId: string | null = null;
	try {
		await armParlumeMeetingBridge({
			settings,
			sessionId: session.id,
			hardStopAt,
		});
		providerBotId = await startParlumeMeetingBot({
			settings,
			attendee,
			sessionId: session.id,
			meetingUrl: input.meetingUrl,
			streamToken,
			callbackSecret: callbackSecret(settings.serviceSecret, session.id),
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
		return { session: started };
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
