/** SDK workflow tests stub persistence; database guard behavior has separate tests. */
export function withCodingLifecycleActivities(
	activities: Record<string, (...args: any[]) => any>,
) {
	return {
		...activities,
		...(activities.findStaleWeaveSessions
			? {
					findStaleWeaveSessionsWithRuntime:
						activities.findStaleWeaveSessions,
				}
			: {}),
		...(activities.syncCodingRunArtifacts
			? {
					syncRemoteCodingRunArtifacts:
						activities.syncCodingRunArtifacts,
				}
			: {}),
		updateCodingRunStatusGuardedActivity: async ({
			workflowId,
			expectedStatuses,
			...input
		}: any) => activities.updateCodingRunStatusActivity(input),
		recordCodingRunRecoveryActivity: async (input: any) => {
			if (input.eventType === "cancellation_unknown") {
				await activities.updateCodingRunStatusActivity({
					codingRunId: input.codingRunId,
					status: "AWAITING_REVIEW",
				});
			}
			await activities.addCodingRunEventActivity({
				codingRunId: input.codingRunId,
				eventType: input.eventType,
				payload: input.payload,
			});
		},
	};
}
