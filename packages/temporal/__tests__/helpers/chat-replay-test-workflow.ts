import { proxyActivities } from "@temporalio/workflow";

const { exampleOutput } = proxyActivities<{
	exampleOutput(): Promise<{ response: string }>;
}>({ startToCloseTimeout: "1 minute" });
/** Synthetic command sequence used to verify interceptor history compatibility. */
export async function orchestratorExecutionWorkflow() {
	return [await exampleOutput(), await exampleOutput()];
}
