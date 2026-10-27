import { ORPCError } from "@orpc/server";
import { db, isFeatureEnabled } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { leaveParlumeMeetingBot } from "../../lib/parlume-attendee";
import { finalizeParlumeSession } from "../../lib/parlume-finalization";
import { parlumeLog } from "../../lib/parlume-log";
import { resolveParlumeAttendeeSettings } from "../../lib/parlume-provider-settings";
import {
	getParlumeReadiness,
	isParlumeReady,
} from "../../lib/parlume-readiness";
import {
	FABRIC_AGENT_KIND,
	FABRIC_AGENT_LABEL,
	isBoundToProject,
	sessionSelect,
	startParlumeMeetingSession,
	TEMPLATE_INSTANCE_KIND,
} from "../../lib/parlume-start";
import { sweepOverdueParlumeSessions } from "../../lib/parlume-sweep";

const projectInput = z.object({ projectId: z.string() });
const SESSIONS_PAGE_SIZE = 5;

type ParlumeAgentOption = {
	label: string;
	description: string | null;
} & (
	| {
			kind: typeof FABRIC_AGENT_KIND;
			agentInstanceSId: null;
			version: null;
	  }
	| {
			kind: typeof TEMPLATE_INSTANCE_KIND;
			agentInstanceSId: string;
			version: number;
			sId: string;
			name: string;
	  }
);

export async function requireParlumeProject(projectId: string) {
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

const startSessionInput = projectInput
	.extend({
		agentKind: z
			.enum([FABRIC_AGENT_KIND, TEMPLATE_INSTANCE_KIND])
			.optional(),
		agentInstanceSId: z.string().optional(),
		meetingUrl: z.string().url(),
		toolsReadOnly: z.boolean().default(true),
		suggestionsEnabled: z.boolean().default(true),
	})
	.superRefine((input, context) => {
		const agentKind = input.agentKind ?? TEMPLATE_INSTANCE_KIND;
		if (agentKind === FABRIC_AGENT_KIND && input.agentInstanceSId) {
			context.addIssue({
				code: "custom",
				path: ["agentInstanceSId"],
				message:
					"The built-in Fabric Agent cannot be combined with a custom agent.",
			});
		}
		if (agentKind === TEMPLATE_INSTANCE_KIND && !input.agentInstanceSId) {
			context.addIssue({
				code: "custom",
				path: ["agentInstanceSId"],
				message: "Choose a custom Fabric Agent.",
			});
		}
	});

export const listParlumeAgentsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_MEMBERS_MANAGE))
	.route({
		method: "GET",
		path: "/projects/{projectId}/parlume/agents",
		tags: ["Projects", "Parlume"],
		summary: "List project-bound Fabric Agents eligible for Parlume",
	})
	.input(projectInput.extend({ includeBuiltIn: z.boolean().optional() }))
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
		const agents = new Map<string, (typeof candidates)[number]>();
		for (const candidate of candidates) {
			if (
				isBoundToProject(candidate.toolConnections, input.projectId) &&
				!agents.has(candidate.sId)
			) {
				agents.set(candidate.sId, candidate);
			}
		}

		const readiness = await getParlumeReadiness({
			userId: context.user.id,
			organizationId: project.organizationId,
		});
		const customAgents = [...agents.values()].map<ParlumeAgentOption>(
			(agent) => ({
				kind: TEMPLATE_INSTANCE_KIND,
				label: agent.name,
				name: agent.name,
				description: agent.description,
				agentInstanceSId: agent.sId,
				sId: agent.sId,
				version: agent.version,
			}),
		);
		const builtInAgent: ParlumeAgentOption = {
			kind: FABRIC_AGENT_KIND,
			label: FABRIC_AGENT_LABEL,
			description:
				"Uses this project's current knowledge and Fabric Agent behavior.",
			agentInstanceSId: null,
			version: null,
		};
		return {
			agents: input.includeBuiltIn
				? [builtInAgent, ...customAgents]
				: customAgents,
			operatorReady: isParlumeReady(readiness),
			readiness,
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
	.input(
		projectInput.extend({
			before: z
				.object({ id: z.string(), createdAt: z.coerce.date() })
				.optional(),
		}),
	)
	.handler(async ({ input }) => {
		await requireParlumeProject(input.projectId);
		// The sweep is project-wide, not page-relative, so the first page's
		// request covers it.
		if (!input.before) {
			await sweepOverdueParlumeSessions(input.projectId);
		}
		const [rows, total] = await Promise.all([
			db.parlumeMeetingSession.findMany({
				where: {
					projectId: input.projectId,
					...(input.before
						? {
								OR: [
									{
										createdAt: {
											lt: input.before.createdAt,
										},
									},
									{
										createdAt: input.before.createdAt,
										id: { lt: input.before.id },
									},
								],
							}
						: {}),
				},
				select: {
					...sessionSelect,
					_count: { select: { turns: true } },
				},
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				take: SESSIONS_PAGE_SIZE + 1,
			}),
			// The project's whole session count, for the page's tab and spend
			// summary; later pages do not repeat it.
			input.before
				? Promise.resolve(null)
				: db.parlumeMeetingSession.count({
						where: { projectId: input.projectId },
					}),
		]);
		const sessions = rows.slice(0, SESSIONS_PAGE_SIZE);
		const last = sessions.at(-1);
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
			sessions: sessions.map(({ _count, ...session }) => {
				const notes = session.transcriptContextId
					? notesByContextId.get(session.transcriptContextId)
					: null;
				return {
					...session,
					requestCount: _count.turns,
					notes: notes?.notes ?? null,
					notesStatus: notes?.status ?? null,
				};
			}),
			total,
			nextCursor:
				rows.length > SESSIONS_PAGE_SIZE && last
					? { id: last.id, createdAt: last.createdAt }
					: null,
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
	.input(startSessionInput)
	.handler(async ({ input, context }) => {
		const project = await requireParlumeProject(input.projectId);
		return startParlumeMeetingSession(
			{
				projectId: input.projectId,
				organizationId: project.organizationId,
				userId: context.user.id,
				meetingUrl: input.meetingUrl,
				agentKind: input.agentKind,
				agentInstanceSId: input.agentInstanceSId,
				toolsReadOnly: input.toolsReadOnly,
				suggestionsEnabled: input.suggestionsEnabled,
				trigger: "MANUAL",
			},
			context,
		);
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
			select: {
				id: true,
				providerBotId: true,
				status: true,
				streamClosedAt: true,
				streamGeneration: true,
			},
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

		const leaveClaimed = await db.parlumeMeetingSession.updateMany({
			where: {
				id: session.id,
				streamGeneration: session.streamGeneration,
				status: {
					in: [
						"PENDING",
						"JOINING",
						"ACTIVE",
						"LEAVING",
						"STOP_FAILED",
					],
				},
			},
			data: {
				status: "LEAVING",
				endReason: "STOPPED",
				leaveRequestedAt: new Date(),
			},
		});
		parlumeLog("info", "stop.requested", {
			sessionId: session.id,
			botId: session.providerBotId,
			status: session.status,
			claimed: leaveClaimed.count > 0,
		});
		const leaving = await db.parlumeMeetingSession.findUniqueOrThrow({
			where: { id: session.id },
			select: sessionSelect,
		});
		if (leaveClaimed.count === 0 || !session.providerBotId) {
			// The start request can still be waiting for the provider. It sees
			// LEAVING, leaves the newly-created bot, then marks this row ENDED.
			return { session: leaving };
		}
		try {
			const attendee = await resolveParlumeAttendeeSettings(
				project.organizationId,
			);
			if (!attendee) {
				throw new Error(
					"Parlume provider configuration is unavailable.",
				);
			}
			const leaveResult = await leaveParlumeMeetingBot({
				attendee,
				providerBotId: session.providerBotId,
			});
			const terminalFailure =
				leaveResult.kind === "TERMINAL" &&
				leaveResult.status === "failed";
			const terminalCompleted =
				leaveResult.kind === "TERMINAL" &&
				leaveResult.status === "completed";
			const terminalMarked = await db.parlumeMeetingSession.updateMany({
				where: {
					id: session.id,
					streamGeneration: session.streamGeneration,
					status: {
						in: ["JOINING", "ACTIVE", "LEAVING", "STOP_FAILED"],
					},
				},
				data: terminalFailure
					? {
							status: "FAILED",
							lastError: "Parlume meeting bot failed.",
							terminalCallbackAt: new Date(),
						}
					: {
							status: "LEAVING",
							lastError: null,
							...(terminalCompleted
								? { terminalCallbackAt: new Date() }
								: {}),
						},
			});
			const drained =
				terminalMarked.count > 0 && leaveResult.kind === "TERMINAL"
					? await db.parlumeMeetingSession.findFirst({
							where: {
								id: session.id,
								streamGeneration: session.streamGeneration,
								streamClosedAt: { not: null },
								status: { in: ["LEAVING", "FAILED"] },
							},
							select: { id: true },
						})
					: null;
			if (drained) {
				await finalizeParlumeSession(session.id, {
					...(terminalFailure ? { preserveFailure: true } : {}),
					expectedStreamGeneration: session.streamGeneration,
				});
			}
			const stopped = await db.parlumeMeetingSession.findUniqueOrThrow({
				where: { id: session.id },
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
			await db.parlumeMeetingSession.updateMany({
				where: {
					id: session.id,
					streamGeneration: session.streamGeneration,
					status: {
						in: ["JOINING", "ACTIVE", "LEAVING", "STOP_FAILED"],
					},
					finalizedAt: null,
				},
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
