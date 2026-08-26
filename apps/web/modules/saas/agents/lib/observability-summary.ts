export interface AgentObservabilityMetrics {
	displayName: string;
	conversationCount: number;
	messagesLast7d: number;
	activeDaysLast30d: number;
	lastUsedAt?: string | null;
	status: string;
	pendingApprovals: number;
}

export function generateAgentObservabilitySummary(
	metrics: AgentObservabilityMetrics,
): string {
	const parts: string[] = [];

	if (metrics.conversationCount === 0) {
		parts.push(`${metrics.displayName} has not been used yet.`);
	} else {
		parts.push(
			`${metrics.displayName} has handled ${metrics.conversationCount} conversation${metrics.conversationCount === 1 ? "" : "s"} overall.`,
		);
	}

	if (metrics.messagesLast7d > 0) {
		parts.push(
			`Usage in the last 7 days is active, with ${metrics.messagesLast7d} message${metrics.messagesLast7d === 1 ? "" : "s"} recorded.`,
		);
	} else {
		parts.push("No messages were recorded in the last 7 days.");
	}

	if (metrics.activeDaysLast30d > 0) {
		parts.push(
			`The agent was active on ${metrics.activeDaysLast30d} day${metrics.activeDaysLast30d === 1 ? "" : "s"} in the last 30 days.`,
		);
	}

	if (metrics.pendingApprovals > 0) {
		parts.push(
			`${metrics.pendingApprovals} workflow approval${metrics.pendingApprovals === 1 ? " is" : "s are"} still pending and may be slowing execution.`,
		);
	}

	if (metrics.status !== "ACTIVE") {
		parts.push(
			`Current registry status is ${metrics.status.toLowerCase()}.`,
		);
	}

	if (metrics.lastUsedAt) {
		parts.push(
			`Last observed activity was ${new Date(metrics.lastUsedAt).toLocaleString()}.`,
		);
	}

	return parts.join(" ");
}
