import { createSandboxClient } from "@repo/sandbox";
import type { ExecuteCodeRequest } from "@repo/sandbox/dynamic-worker";

export async function executeDynamicWorkerCode(
	input: Omit<ExecuteCodeRequest, "inputs"> & {
		inputs?: ExecuteCodeRequest["inputs"];
		userId: string;
		organizationId?: string;
	},
) {
	const { userId, organizationId, ...options } = input;
	return createSandboxClient().executeCode(userId, organizationId, {
		...options,
		inputs: options.inputs ?? {},
	});
}
