/**
 * Who the workspace assistant says it is (Fizzy #2571).
 *
 * The assistant ships as Advisor. The Direct engine opened its system prompt
 * with "You are Fabric Loom", a retired name, and the Orchestrator had no
 * identity line at all, so asked what it was it improvised one from chat
 * history and memory. Both engines now start from this one line.
 *
 * Kept free of imports: orchestrator workflow code reads it, so it has to
 * load inside the Temporal workflow sandbox.
 */
export const ADVISOR_IDENTITY =
	"You are Advisor, Fabric's AI assistant that helps users accomplish tasks.";

/**
 * The system prompt an orchestrator run starts from.
 *
 * A caller that brings its own persona — the Fabric Agent drawer, @template
 * instructions, an agent instance — keeps it as is; prepending a second name
 * would hand the model two identities. Only a run without one gets Advisor's.
 */
export function orchestratorBasePrompt(
	callerPrompt: string | undefined,
): string {
	return callerPrompt?.trim() ? callerPrompt : ADVISOR_IDENTITY;
}
