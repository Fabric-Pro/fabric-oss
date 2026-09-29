import { db, getBuiltInToolConfig, hasProjectAccess } from "@repo/database";
import { logger } from "@repo/logs";
import { executeAgentTurn } from "./agent-execution-core";
import {
	buildExecutionContext,
	type DeploymentConfig,
} from "./deployment-execution";
import {
	requestParlumeMeetingStop,
	speakParlumeResponse,
} from "./parlume-voice";
import { retrieveProjectContextsActivity } from "./project-metadata";
import { buildProjectContextBlock } from "./shared/project-context-block";

const MAX_PARLUME_HISTORY_TURNS = 4;
const MAX_LIVE_TRANSCRIPT_CHARS = 20_000;
const LIVE_TRANSCRIPT_WINDOW_MS = 10 * 60 * 1000;

export async function failParlumeMeetingTurn(params: {
	turnId: string;
	error: string;
}): Promise<void> {
	const turn = await db.parlumeMeetingTurn.findUnique({
		where: { id: params.turnId },
		select: { sessionId: true },
	});
	if (!turn) {
		return;
	}
	await db.$transaction([
		db.parlumeMeetingTurn.updateMany({
			where: {
				id: params.turnId,
				status: { in: ["PENDING", "RUNNING"] },
			},
			data: {
				status: "FAILED",
				error: params.error,
				completedAt: new Date(),
			},
		}),
		db.parlumeMeetingSession.updateMany({
			where: { id: turn.sessionId, activeTurnId: params.turnId },
			data: { activeTurnId: null },
		}),
	]);
}

function asToolConnections(
	value: unknown,
): Record<string, Record<string, unknown>> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, entry]) =>
			entry && typeof entry === "object" && !Array.isArray(entry)
				? [[key, entry as Record<string, unknown>]]
				: [],
		),
	);
}

export async function executeParlumeMeetingTurn(params: {
	turnId: string;
}): Promise<void> {
	const turn = await db.parlumeMeetingTurn.findUnique({
		where: { id: params.turnId },
		select: {
			id: true,
			status: true,
			requestText: true,
			session: {
				select: {
					id: true,
					projectId: true,
					organizationId: true,
					userId: true,
					agentInstanceSId: true,
					agentInstanceVersionId: true,
					status: true,
					toolsReadOnly: true,
				},
			},
		},
	});
	if (!turn || turn.status === "COMPLETED" || turn.status === "FAILED") {
		return;
	}

	const fail = async (error: string) => {
		await db.$transaction([
			db.parlumeMeetingTurn.update({
				where: { id: params.turnId },
				data: { status: "FAILED", error, completedAt: new Date() },
			}),
			db.parlumeMeetingSession.updateMany({
				where: { id: turn.session.id, activeTurnId: params.turnId },
				data: { activeTurnId: null },
			}),
		]);
	};

	if (turn.session.status !== "ACTIVE" || !turn.session.toolsReadOnly) {
		await fail(
			"Parlume meeting is no longer available for read-only turns.",
		);
		return;
	}

	const hasAccess = await hasProjectAccess(
		turn.session.projectId,
		turn.session.userId,
		turn.session.organizationId,
	);
	if (!hasAccess) {
		await fail("The inviter no longer has access to this project.");
		await db.parlumeMeetingSession.updateMany({
			where: { id: turn.session.id, status: "ACTIVE" },
			data: {
				status: "LEAVING",
				leaveRequestedAt: new Date(),
				captureStoppedAt: new Date(),
				lastError: "The inviter no longer has access to this project.",
			},
		});
		try {
			await requestParlumeMeetingStop({ sessionId: turn.session.id });
		} catch (error) {
			logger.error(
				"[Parlume] Could not request a stop after access revocation",
				{
					sessionId: turn.session.id,
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
		}
		return;
	}

	const instance = await db.agentTemplateInstance.findFirst({
		where: {
			id: turn.session.agentInstanceVersionId,
			sId: turn.session.agentInstanceSId,
			organizationId: turn.session.organizationId,
			status: { in: ["ACTIVE", "ARCHIVED"] },
		},
		include: {
			template: true,
			mcpServerConfigurations: {
				where: { isEnabled: true },
				select: { mcpConfigId: true },
			},
			integrationConfigurations: {
				where: { isEnabled: true },
				select: {
					integrationId: true,
					integrationType: true,
					allowedResources: true,
				},
			},
		},
	});
	if (!instance || instance.userId !== turn.session.userId) {
		await fail(
			"The selected Parlume agent version is no longer available.",
		);
		return;
	}
	const activeAgent = await db.agentTemplateInstance.findFirst({
		where: {
			sId: turn.session.agentInstanceSId,
			organizationId: turn.session.organizationId,
			userId: turn.session.userId,
			status: "ACTIVE",
		},
		orderBy: { version: "desc" },
		select: { toolConnections: true },
	});
	if (
		!activeAgent ||
		getBuiltInToolConfig(
			asToolConnections(activeAgent.toolConnections),
			"project-context",
		)?.projectId !== turn.session.projectId
	) {
		await fail("The selected agent is no longer active in this project.");
		return;
	}

	const toolConnections = asToolConnections(instance.toolConnections);
	const projectBinding = getBuiltInToolConfig(
		toolConnections,
		"project-context",
	)?.projectId;
	if (projectBinding !== turn.session.projectId) {
		await fail("The selected agent is no longer bound to this project.");
		return;
	}

	const config: DeploymentConfig = {
		deploymentId: `parlume-${turn.session.id}`,
		template: {
			id: instance.template.id,
			name: instance.template.name,
			slug: instance.template.slug,
			displayName: instance.template.displayName,
			description: instance.template.description,
			instructions: instance.template.instructions,
			knowledgeSources: [],
			tools: [],
			suggestedModel: instance.template.suggestedModel,
		},
		instance: {
			id: instance.id,
			name: instance.name,
			description: instance.description,
			customInstructions: instance.customInstructions as Record<
				string,
				unknown
			> | null,
			modelOverride: instance.modelOverride,
			modelConfig: instance.modelConfig as Record<string, unknown> | null,
		},
		integrationConfigurations: instance.integrationConfigurations,
		mcpConfigIds: instance.mcpServerConfigurations.map(
			({ mcpConfigId }) => mcpConfigId,
		),
		toolConnections,
		// Workspace RAG and agent memory are not project-scoped. Parlume uses
		// only the project retrieval below for an anonymous meeting attendee.
		workspaceIds: [],
	};

	await db.parlumeMeetingTurn.update({
		where: { id: turn.id },
		data: { status: "RUNNING", startedAt: new Date(), error: null },
	});

	try {
		const [context, projectBlock, projectRag, recentSegments] =
			await Promise.all([
				buildExecutionContext({
					config,
					input: { message: turn.requestText },
					userId: turn.session.userId,
					organizationId: turn.session.organizationId,
					loadAgentMemory: false,
				}),
				buildProjectContextBlock(turn.session.projectId, {
					userId: turn.session.userId,
					organizationId: turn.session.organizationId,
				}),
				retrieveProjectContextsActivity(
					turn.requestText,
					turn.session.projectId,
					turn.session.userId,
					turn.session.organizationId,
					6,
				),
				db.parlumeMeetingSegment.findMany({
					where: {
						sessionId: turn.session.id,
						createdAt: {
							gte: new Date(
								Date.now() - LIVE_TRANSCRIPT_WINDOW_MS,
							),
						},
					},
					select: { text: true, speakerName: true },
					orderBy: { createdAt: "desc" },
					take: 200,
				}),
			]);
		if (context.projectId !== turn.session.projectId) {
			await fail(
				"The agent execution context is not bound to this project.",
			);
			return;
		}

		const history = await db.parlumeMeetingTurn.findMany({
			where: {
				sessionId: turn.session.id,
				status: "COMPLETED",
				id: { not: turn.id },
			},
			select: { requestText: true, responseText: true },
			orderBy: { completedAt: "desc" },
			take: MAX_PARLUME_HISTORY_TURNS,
		});
		const conversationHistory = history
			.reverse()
			.flatMap(({ requestText, responseText }) =>
				responseText
					? [
							{ role: "user" as const, content: requestText },
							{
								role: "assistant" as const,
								content: responseText,
							},
						]
					: [],
			);
		const latestSegments = [];
		let liveTranscriptLength = 0;
		for (const segment of recentSegments) {
			const line = segment.speakerName
				? `${segment.speakerName}: ${segment.text}`
				: segment.text;
			if (
				liveTranscriptLength + line.length + 1 >
				MAX_LIVE_TRANSCRIPT_CHARS
			) {
				break;
			}
			latestSegments.push(line);
			liveTranscriptLength += line.length + 1;
		}
		const liveTranscript = latestSegments.reverse().join("\n");

		const result = await executeAgentTurn({
			systemPrompt: [
				context.systemPrompt,
				projectBlock,
				"You are replying aloud in a project meeting. Be concise. Voice actions that change content or external systems are unavailable; participants must perform those actions in Fabric separately.",
			]
				.filter(Boolean)
				.join("\n\n"),
			userMessage: turn.requestText,
			knowledgeContext: [
				projectRag.context,
				liveTranscript
					? `## Recent meeting transcript\n${liveTranscript}`
					: null,
			]
				.filter(Boolean)
				.join("\n\n"),
			mcpConfigIds: [],
			integrationConfigurations: [],
			model: context.model,
			userId: turn.session.userId,
			organizationId: turn.session.organizationId,
			projectId: turn.session.projectId,
			maxIterations: 4,
			conversationHistory,
			executionId: `parlume-${turn.id}`,
			agentInstanceId: context.agentInstanceId,
			callingAgentId: context.agentInstanceId,
			currentDepth: 0,
			meetingReadOnly: true,
		});
		if (!result.success) {
			await fail(result.error || "Parlume agent execution failed.");
			return;
		}
		await speakParlumeResponse({
			sessionId: turn.session.id,
			userId: turn.session.userId,
			organizationId: turn.session.organizationId,
			response: result.response,
		});
		await db.$transaction([
			db.parlumeMeetingTurn.update({
				where: { id: turn.id },
				data: {
					status: "COMPLETED",
					responseText: result.response,
					completedAt: new Date(),
				},
			}),
			db.parlumeMeetingSession.updateMany({
				where: { id: turn.session.id, activeTurnId: turn.id },
				data: { activeTurnId: null },
			}),
		]);
	} catch (error) {
		logger.error("[Parlume] Meeting turn failed", {
			turnId: turn.id,
			error: error instanceof Error ? error.message : String(error),
		});
		await fail("Parlume agent execution failed.");
	}
}
