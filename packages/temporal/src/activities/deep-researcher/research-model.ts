import { getAiModel } from "../orchestrator/utils/model-selector";

/** Who a research step runs for: its tenant and, when it has one, its project. */
interface ResearchScope {
	userId: string;
	organizationId?: string;
	/** The run's project: its usage limits apply and its usage is counted. */
	projectId?: string;
}

/** The model a research step without tools calls, in the run's scope. */
export function researchModel(scope: ResearchScope) {
	return getAiModel(
		scope.userId,
		scope.organizationId,
		false,
		undefined,
		undefined,
		{ projectId: scope.projectId },
	);
}
