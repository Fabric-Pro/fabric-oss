import {
	ActivityCancellationType,
	proxyActivities,
} from "@temporalio/workflow";
import type * as activities from "../activities/agent-test-assessment";
export interface AgentTestAssessmentInput {
	testRunId: string;
	userId: string;
	organizationId: string;
}
const assessment = proxyActivities<typeof activities>({
	startToCloseTimeout: "40 minutes",
	heartbeatTimeout: "20 seconds",
	cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
	retry: { maximumAttempts: 3, initialInterval: "1s" },
});
const failureCodes = new Set([
	"AGENT_TEST_EXECUTION_FAILED",
	"AGENT_TEST_NO_TEXT",
	"AGENT_TEST_EFFECT_UNCONFIRMED",
	"AGENT_TEST_CONFIG_CHANGED",
	"AGENT_TEST_IDENTITY_INVALID",
	"AGENT_TEST_FORBIDDEN",
]);
/** Only a bounded known failure type crosses into retained product metadata. */
function failureCode(error: unknown): string {
	let cause = error;
	for (
		let depth = 0;
		depth < 5 && cause && typeof cause === "object";
		depth++
	) {
		const failure = cause as { type?: unknown; cause?: unknown };
		if (
			typeof failure.type === "string" &&
			failureCodes.has(failure.type)
		) {
			return failure.type;
		}
		cause = failure.cause;
	}
	return "ASSESSMENT_UNAVAILABLE";
}
/** Native execution owns work and recovery. This observer waits for its recorded run, then saves exact-text checks. */
export async function agentTestAssessmentWorkflow(
	input: AgentTestAssessmentInput,
) {
	try {
		return await assessment.assessAgentTestRun(input);
	} catch (error) {
		return await assessment.failAgentTestAssessment({
			...input,
			errorCode: failureCode(error),
		});
	}
}
