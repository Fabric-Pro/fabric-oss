import { proxyActivities } from "@temporalio/workflow";
import { getActivator } from "@temporalio/workflow/lib/global-attributes";

const { runAgentIteration } = proxyActivities<{
	runAgentIteration(): Promise<{ response: string }>;
}>({ startToCloseTimeout: "1 minute" });
/** Synthetic legacy output sequence; older workers publish this prefix without journal metadata. */
export async function orchestratorExecutionWorkflow(
	assertLegacyReplay = false,
) {
	const unjournaledPrefix = await runAgentIteration();
	// Test-only SDK introspection verifies the query reconstructed during offline replay.
	const status =
		getActivator().queryHandlers.get("chatReplayStatus")?.handler;
	if (
		assertLegacyReplay &&
		status &&
		!(status() as { unavailable: boolean }).unavailable
	) {
		throw new Error("Legacy output must disable replay");
	}
	return [unjournaledPrefix, await runAgentIteration()];
}
