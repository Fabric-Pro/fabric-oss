export function exampleHistory(stage: "delayed" | "scheduled" | "started") {
	const events: Record<string, unknown>[] = [
		{
			eventId: "1",
			eventTime: "2026-01-01T00:00:00Z",
			eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED",
			workflowExecutionStartedEventAttributes: {
				workflowType: { name: "exampleWorkflow" },
				taskQueue: { name: "example-queue" },
				workflowTaskTimeout: "10s",
				originalExecutionRunId: "00000000-0000-4000-8000-000000000001",
				firstExecutionRunId: "00000000-0000-4000-8000-000000000001",
				firstWorkflowTaskBackoff: stage === "delayed" ? "600s" : "0s",
			},
		},
	];
	if (stage !== "delayed") {
		events.push({
			eventId: "2",
			eventTime: "2026-01-01T00:00:00Z",
			eventType: "EVENT_TYPE_WORKFLOW_TASK_SCHEDULED",
			workflowTaskScheduledEventAttributes: {
				taskQueue: { name: "example-queue" },
				startToCloseTimeout: "10s",
				attempt: 1,
			},
		});
	}
	if (stage === "started") {
		events.push({
			eventId: "3",
			eventTime: "2026-01-01T00:00:00Z",
			eventType: "EVENT_TYPE_WORKFLOW_TASK_STARTED",
			workflowTaskStartedEventAttributes: {
				scheduledEventId: "2",
				identity: "example-worker",
				requestId: "example-request",
			},
		});
	}
	return { events };
}
