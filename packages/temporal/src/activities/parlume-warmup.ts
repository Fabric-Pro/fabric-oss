import { getAIModelWithMetadata, getAISpeechModel } from "@repo/ai";
import { db } from "@repo/database";
import { collectMcpToolsActivity } from "./direct-chat/mcp-tools";
import { loadParlumeAgent } from "./parlume-agent";
import { parlumeActivityLog } from "./parlume-log";
import { TurnTimings } from "./shared/turn-timing";

/**
 * Runs the first steps of a spoken turn once, when the bot has just been
 * admitted, so the first question does not pay for them: the agent and its
 * tool configuration are read from the database, the model and the speech
 * route are resolved (provider keys read and decrypted), and the lazily
 * loaded project-context module is imported. It reads only. Nothing is
 * cached for the turn to reuse, because a turn must see the agent's
 * configuration as it is when the question is asked.
 *
 * Best effort: a step that fails is logged and skipped, and the activity
 * never throws, so a failed warm-up cannot affect the meeting.
 */
export async function warmParlumeSession(params: {
	sessionId: string;
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
						await collectMcpToolsActivity(
							session.userId,
							session.organizationId,
							agent.enabledMcpConfigIds,
						);
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
