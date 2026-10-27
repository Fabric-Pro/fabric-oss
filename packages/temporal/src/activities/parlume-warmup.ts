import { getAIModelWithMetadata, getAISpeechModel } from "@repo/ai";
import { db } from "@repo/database";
import { collectMcpToolsActivity } from "./direct-chat/mcp-tools";
import { generateMemoryContextActivity } from "./direct-chat/memory-context";
import { loadParlumeAgent } from "./parlume-agent";
import { parlumeActivityLog } from "./parlume-log";
import { loadFabricPlatformTools } from "./shared/fabric-platform-mcp";
import { TurnTimings } from "./shared/turn-timing";

/**
 * Runs the first steps of a spoken turn once, when the bot has just been
 * admitted, so the first question does not pay for them: the agent and its
 * tool configuration are read from the database, the model and the speech
 * route are resolved (provider keys read and decrypted), the lazily loaded
 * project-context module is imported, the inviter's memory is searched once,
 * and Fabric's own tools are listed from Fabric MCP. It reads only. Nothing is
 * cached for the turn to reuse, because a turn must see the agent's
 * configuration as it is when the question is asked.
 *
 * Best effort: a step that fails is logged and skipped, and the activity
 * never throws, so a failed warm-up cannot affect the meeting.
 */
export async function warmParlumeSession(params: {
	sessionId: string;
	/** Minted by the web route like a turn's, so Fabric's tools can be listed. */
	actingGrant?: string;
}): Promise<void> {
	const timings = new TurnTimings();
	const failed: string[] = [];
	const step = async (name: string, run: () => Promise<unknown>) => {
		try {
			await timings.time(name, run);
		} catch {
			failed.push(name);
		}
	};
	let live = false;
	try {
		const session = await timings.time("sessionLoadMs", () =>
			db.parlumeMeetingSession.findUnique({
				where: { id: params.sessionId },
				select: {
					id: true,
					status: true,
					agentKind: true,
					agentInstanceSId: true,
					projectId: true,
					organizationId: true,
					userId: true,
				},
			}),
		);
		if (
			session &&
			(session.status === "ACTIVE" || session.status === "JOINING")
		) {
			live = true;
			await Promise.all([
				step("agentLoadMs", async () => {
					const agent = await loadParlumeAgent(session);
					if (agent.kind === "FABRIC_AGENT") {
						const { actingGrant } = params;
						await Promise.all([
							collectMcpToolsActivity(
								session.userId,
								session.organizationId,
								agent.enabledMcpConfigIds,
							),
							actingGrant
								? step("fabricToolsMs", () =>
										listFabricTools({
											...session,
											actingGrant,
										}),
									)
								: null,
						]);
					}
				}),
				step("modelResolveMs", () =>
					getAIModelWithMetadata(
						{
							taskType: "TOOL_CALLING",
							complexity: "medium",
							requiresToolCalling: true,
							usageLogging: "aggregate",
						},
						{
							userId: session.userId,
							organizationId: session.organizationId,
							projectId: session.projectId,
							featureKey: "parlume",
							conversationId: session.id,
						},
					),
				),
				step("speechRouteMs", () =>
					getAISpeechModel({
						userId: session.userId,
						organizationId: session.organizationId,
					}),
				),
				step(
					"projectBlockImportMs",
					() => import("./shared/project-context-block"),
				),
				// One embedding and one search for a fixed query: the inviter's
				// memory search took two seconds on a meeting's first question.
				step("memoryMs", () =>
					generateMemoryContextActivity(
						"meeting",
						session.userId,
						session.organizationId ?? undefined,
					),
				),
			]);
		}
		parlumeActivityLog("info", "session.warmed", {
			sessionId: params.sessionId,
			live,
			failed,
			timings: timings.snapshot().values,
		});
	} catch (error) {
		parlumeActivityLog("warn", "session.warm_failed", {
			sessionId: params.sessionId,
			error:
				error instanceof Error
					? `${error.name}: ${error.message}`.slice(0, 300)
					: "Unknown error",
		});
	}
}

/**
 * Lists Fabric's MCP tools as the inviter once, as a turn does, and closes the
 * connection: listing them took a meeting's first turn 2.5 seconds.
 */
async function listFabricTools(session: {
	id: string;
	userId: string;
	organizationId: string;
	projectId: string;
	actingGrant: string;
}): Promise<void> {
	const tools = await loadFabricPlatformTools(
		{
			userId: session.userId,
			organizationId: session.organizationId,
			actingGrant: session.actingGrant,
			projectId: session.projectId,
			conversationId: session.id,
			sourceRunType: "direct-chat",
		},
		{ portal: { offer: false } },
	);
	await tools?.close();
}
