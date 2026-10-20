export interface AiUsageOrigin {
	frameId?: string | null;
	workflowExecutionId?: string | null;
	workflowId?: string | null;
	originOrganizationSlug?: string | null;
	featureKey?: string | null;
	promptVersionId?: string | null;
}

export const AI_USAGE_ORIGIN_CSV_HEADERS = [
	"featureKey",
	"frameId",
	"workflowId",
	"workflowExecutionId",
	"promptVersionId",
];

export function aiUsageOriginCsvFields(origin: AiUsageOrigin): string[] {
	return [
		origin.featureKey ?? "",
		origin.frameId ?? "",
		origin.workflowId ?? "",
		origin.workflowExecutionId ?? "",
		origin.promptVersionId ?? "",
	];
}

export function aiUsageOriginLinks(origin: AiUsageOrigin) {
	const base = origin.originOrganizationSlug
		? `/app/${encodeURIComponent(origin.originOrganizationSlug)}`
		: null;
	return {
		frame:
			base && origin.frameId
				? `${base}/frames/${encodeURIComponent(origin.frameId)}`
				: null,
		workflow:
			base && origin.workflowId
				? `${base}/workflows/${encodeURIComponent(origin.workflowId)}`
				: null,
	};
}
