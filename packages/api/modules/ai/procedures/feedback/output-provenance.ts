import { getAiOutputProvenance } from "@repo/database";
import { logger } from "@repo/logs";

export async function resolveOutputProvenance(
	input: {
		subjectType: string;
		subjectId: string;
		projectId?: string | null;
	},
	organizationId: string | null | undefined,
	userId: string,
) {
	let provenance: Awaited<ReturnType<typeof getAiOutputProvenance>> = null;
	if (input.subjectType === "copilot-message" && organizationId) {
		try {
			provenance = await getAiOutputProvenance({
				organizationId,
				userId,
				subjectType: input.subjectType,
				subjectId: input.subjectId,
			});
		} catch (error) {
			const diagnostics =
				error !== null && typeof error === "object"
					? (error as { name?: unknown; code?: unknown })
					: {};
			// Allow only scalar diagnostic fields; message, stack and subject stay out.
			logger.warn("[ai.feedback] Failed to look up output provenance", {
				...(typeof diagnostics.name === "string" && {
					name: diagnostics.name,
				}),
				...((typeof diagnostics.code === "string" ||
					typeof diagnostics.code === "number") && {
					code: diagnostics.code,
				}),
			});
		}
	}

	const matchingProvenance =
		provenance?.projectId === (input.projectId ?? null) ? provenance : null;

	return matchingProvenance;
}
