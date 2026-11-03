/** Synthetic workflow for testing engine admission only; no model or tools. */
export async function deploymentExecutionWorkflow() {
	return { verified: true };
}

export const nativeDeploymentExecutionWorkflow = deploymentExecutionWorkflow;
