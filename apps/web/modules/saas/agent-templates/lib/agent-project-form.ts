import { readAgentProjectBinding } from "@repo/database/prisma/queries/lib/agent-project-binding";

/** Invalid persisted scope needs deliberate rebinding, never a guessed project. */
export function agentProjectFormState(
	instructions: unknown,
	connections: unknown,
) {
	try {
		return {
			projectId:
				readAgentProjectBinding(instructions, connections) ?? null,
			needsReview: false,
		};
	} catch {
		return { projectId: null, needsReview: true };
	}
}
