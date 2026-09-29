import { createHash, createHmac, randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { resolveOpenAiApiKey } from "@repo/ai";
import { db, getBuiltInToolConfig, isFeatureEnabled } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	armParlumeMeetingBridge,
	getParlumeBridgeSettings,
	isTeamsMeetingUrl,
	leaveParlumeMeetingBot,
	startParlumeMeetingBot,
} from "../../lib/parlume-meeting-baas";

const projectInput = z.object({ projectId: z.string() });
const PARLUME_MAX_DURATION_MS = 4 * 60 * 60 * 1000;

function digestStreamToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function callbackSecret(serviceSecret: string, sessionId: string): string {
	return createHmac("sha256", serviceSecret)
		.update(`parlume-callback:${sessionId}`)
		.digest("base64url");
}

const sessionSelect = {
	id: true,
	agentInstanceSId: true,
	status: true,
	wakePhrase: true,
	toolsReadOnly: true,
	lastError: true,
	joinedAt: true,
	hardStopAt: true,
	leaveRequestedAt: true,
	endedAt: true,
	transcriptContextId: true,
	createdAt: true,
	updatedAt: true,
} as const;

async function requireParlumeProject(projectId: string) {
	const project = await db.project.findFirst({
		where: { id: projectId },
		select: { id: true, organizationId: true },
	});
	if (!project?.organizationId) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}
	if (!(await isFeatureEnabled("PARLUME_MEETINGS", project.organizationId))) {
		throw new ORPCError("NOT_FOUND", {
			message: "Parlume meeting invitations are not enabled.",
		});
	}
	return { id: project.id, organizationId: project.organizationId };
}

function isBoundToProject(
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

export const listParlumeAgentsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_MEMBERS_MANAGE))
	.route({
		method: "GET",
		path: "/projects/{projectId}/parlume/agents",
		tags: ["Projects", "Parlume"],
		summary: "List project-bound Fabric Agents eligible for Parlume",
	})
	.input(projectInput)
	.handler(async ({ input, context }) => {
		const project = await requireParlumeProject(input.projectId);
		const candidates = await db.agentTemplateInstance.findMany({
			where: {
				organizationId: project.organizationId,
				userId: context.user.id,
				status: "ACTIVE",
				toolConnections: {
					path: ["project-context", "projectId"],
					equals: input.projectId,
				},
			},
			select: {
				sId: true,
				name: true,
				description: true,
				version: true,
				toolConnections: true,
			},
			orderBy: { version: "desc" },
		});
		const agents = new Map<
			string,
			{
				sId: string;
				name: string;
				description: string | null;
				version: number;
			}
		>();
		for (const candidate of candidates) {
			if (
				isBoundToProject(candidate.toolConnections, input.projectId) &&
				!agents.has(candidate.sId)
			) {
				agents.set(candidate.sId, {
					sId: candidate.sId,
					name: candidate.name,
					description: candidate.description,
					version: candidate.version,
				});
			}
		}

		const operatorReady =
			Boolean(getParlumeBridgeSettings()) &&
			Boolean(
				await resolveOpenAiApiKey({
					userId: context.user.id,
					organizationId: project.organizationId,
				}),
			);
		return {
			agents: [...agents.values()],
			operatorReady,
		};
	});

export const listParlumeSessionsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/parlume/sessions",
		tags: ["Projects", "Parlume"],
		summary: "List Parlume meeting invitation status",
	})
	.input(projectInput)
	.handler(async ({ input }) => {
		await requireParlumeProject(input.projectId);
		const sessions = await db.parlumeMeetingSession.findMany({
			where: { projectId: input.projectId },
			select: sessionSelect,
			orderBy: { createdAt: "desc" },
			take: 20,
		});
		const contexts = await db.projectContext.findMany({
			where: {
				projectId: input.projectId,
				id: {
					in: sessions
						.map((session) => session.transcriptContextId)
						.filter((id): id is string => id !== null),
				},
			},
			select: { id: true, metadata: true },
		});
		const notesByContextId = new Map(
			contexts.map((context) => {
				const metadata = context.metadata;
				const details =
					metadata &&
					typeof metadata === "object" &&
					!Array.isArray(metadata)
						? metadata
						: null;
				const notes =
					details && typeof details.parlumeNotes === "string"
						? details.parlumeNotes
						: null;
				const status =
					details && typeof details.parlumeNotesStatus === "string"
						? details.parlumeNotesStatus
						: null;
				return [context.id, { notes, status }] as const;
			}),
		);
		return {
			sessions: sessions.map((session) => {
				const notes = session.transcriptContextId
					? notesByContextId.get(session.transcriptContextId)
					: null;
				return {
					...session,
					notes: notes?.notes ?? null,
					notesStatus: notes?.status ?? null,
				};
			}),
		};
	});

export const startParlumeSessionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_MEMBERS_MANAGE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/parlume/sessions",
		tags: ["Projects", "Parlume"],
		summary: "Invite Parlume to a Teams meeting by link",
	})
	.input(
		projectInput.extend({
			agentInstanceSId: z.string(),
			meetingUrl: z.string().url(),
		}),
	)
	.handler(async ({ input, context }) => {
		const project = await requireParlumeProject(input.projectId);
		if (!isTeamsMeetingUrl(input.meetingUrl)) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Enter a Microsoft Teams meeting link.",
			});
		}

		const settings = getParlumeBridgeSettings();
		if (!settings) {
			throw new ORPCError("CONFLICT", {
				message:
					"Parlume is not ready for invitations in this environment. Ask an operator to configure its media bridge.",
			});
		}

		const agent = await requireProjectAgent({
			projectId: input.projectId,
			organizationId: project.organizationId,
			agentInstanceSId: input.agentInstanceSId,
			userId: context.user.id,
		});
		if (
			!(await resolveOpenAiApiKey({
				userId: context.user.id,
				organizationId: project.organizationId,
			}))
		) {
			throw new ORPCError("CONFLICT", {
				message:
					"Parlume needs a Fabric OpenAI voice key before it can join. Ask an operator to configure speech for this organization.",
			});
		}
		const streamToken = randomBytes(32).toString("base64url");
		const hardStopAt = new Date(Date.now() + PARLUME_MAX_DURATION_MS);
		const session = await db.parlumeMeetingSession.create({
			data: {
				projectId: input.projectId,
				organizationId: project.organizationId,
				userId: context.user.id,
				agentInstanceSId: agent.sId,
				agentInstanceVersionId: agent.id,
				agentInstanceVersion: agent.version,
				streamTokenDigest: digestStreamToken(streamToken),
				hardStopAt,
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
				sessionId: session.id,
				meetingUrl: input.meetingUrl,
				streamToken,
				callbackSecret: callbackSecret(
					settings.serviceSecret,
					session.id,
				),
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
					await leaveParlumeMeetingBot({ settings, providerBotId });
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
			recordAuditFromRequest(context, {
				action: "project.parlume.session_started",
				category: "project",
				organizationId: project.organizationId,
				projectId: input.projectId,
				resource: { type: "parlume_meeting_session", id: session.id },
				metadata: {
					agentInstanceSId: agent.sId,
					agentInstanceVersion: agent.version,
					toolsReadOnly: true,
					hardStopAt: hardStopAt.toISOString(),
				},
			});
			return { session: started };
		} catch {
			if (providerBotId) {
				try {
					await leaveParlumeMeetingBot({ settings, providerBotId });
				} catch {
					// The persisted FAILED state below is the operator's signal to
					// reconcile a bot that could not be cleaned up after a DB error.
				}
			}
			const markedFailed = await db.parlumeMeetingSession.updateMany({
				where: { id: session.id, status: "PENDING" },
				data: {
					status: "FAILED",
					lastError:
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
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Parlume could not join the meeting.",
			});
		}
	});

export const stopParlumeSessionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_MEMBERS_MANAGE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/parlume/sessions/{sessionId}/stop",
		tags: ["Projects", "Parlume"],
		summary: "Ask Parlume to leave a Teams meeting",
	})
	.input(projectInput.extend({ sessionId: z.string() }))
	.handler(async ({ input, context }) => {
		const project = await requireParlumeProject(input.projectId);
		const session = await db.parlumeMeetingSession.findFirst({
			where: { id: input.sessionId, projectId: input.projectId },
			select: { id: true, providerBotId: true, status: true },
		});
		if (!session) {
			throw new ORPCError("NOT_FOUND", {
				message: "Parlume session not found",
			});
		}
		if (session.status === "ENDED" || session.status === "FAILED") {
			return {
				session: await db.parlumeMeetingSession.findUniqueOrThrow({
					where: { id: session.id },
					select: sessionSelect,
				}),
			};
		}

		const leaving = await db.parlumeMeetingSession.update({
			where: { id: session.id },
			data: { status: "LEAVING", leaveRequestedAt: new Date() },
			select: sessionSelect,
		});
		if (!session.providerBotId) {
			// The start request can still be waiting for Meeting BaaS. It sees
			// LEAVING, leaves the newly-created bot, then marks this row ENDED.
			return { session: leaving };
		}
		const settings = getParlumeBridgeSettings();
		try {
			if (!settings) {
				throw new Error("Parlume bridge configuration is unavailable.");
			}
			await leaveParlumeMeetingBot({
				settings,
				providerBotId: session.providerBotId,
			});
			const stopped = await db.parlumeMeetingSession.update({
				where: { id: session.id },
				data: { status: "LEAVING", lastError: null },
				select: sessionSelect,
			});
			recordAuditFromRequest(context, {
				action: "project.parlume.session_stopped",
				category: "project",
				organizationId: project.organizationId,
				projectId: input.projectId,
				resource: { type: "parlume_meeting_session", id: session.id },
			});
			return { session: stopped };
		} catch {
			await db.parlumeMeetingSession.update({
				where: { id: session.id },
				data: {
					status: "STOP_FAILED",
					lastError:
						"Parlume could not leave the meeting. Retry stop.",
				},
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Parlume could not leave the meeting.",
			});
		}
	});
