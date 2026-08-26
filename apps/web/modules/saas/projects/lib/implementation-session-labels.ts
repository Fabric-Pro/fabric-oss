export type ExecutionChannel = "BACKGROUND_AGENTS" | "LOCAL_AGENTS";

export type ExecutionProvider = "BACKGROUND_AGENTS" | "KANBAN_LOCAL";

export function getExecutionChannelLabel(channel?: string | null): string {
	switch (channel) {
		case "LOCAL_AGENTS":
			return "Local execution";
		default:
			return "Remote execution";
	}
}

export function getExecutionProviderLabel(provider?: string | null): string {
	switch (provider) {
		case "KANBAN_LOCAL":
			return "Local development";
		default:
			return "Background Agents";
	}
}

export function getExecutionProviderPlatformLabel(
	provider?: string | null,
): string {
	switch (provider) {
		case "KANBAN_LOCAL":
			return "Fabric Kanban";
		default:
			return "Background Agents";
	}
}

export function getExecutionProviderDescription(
	provider?: string | null,
): string {
	switch (provider) {
		case "KANBAN_LOCAL":
			return "Runs in your checked-out repository through Fabric Kanban. Run fabric-kanban locally to pull queued work.";
		default:
			return "Runs implementation remotely through Fabric-managed Background Agents. No local setup needed.";
	}
}

export type ImplementationRecommendationInput = {
	hasRepositoryContext: boolean;
	openTaskCount: number;
	focusedTaskId?: string | null;
	implementationDefaultChannel?: ExecutionChannel | null;
	implementationDefaultProvider?: ExecutionProvider | null;
};

export type ImplementationRecommendation = {
	channel: ExecutionChannel;
	provider: ExecutionProvider;
	reason: string;
};

export function getImplementationRecommendation(
	input: ImplementationRecommendationInput,
): ImplementationRecommendation {
	if (!input.hasRepositoryContext) {
		return {
			channel: "BACKGROUND_AGENTS",
			provider: "BACKGROUND_AGENTS",
			reason: "Direct implementation needs a connected repository. Until one is configured, Weave is the better starting point for planning and orchestration.",
		};
	}

	return {
		channel: "BACKGROUND_AGENTS",
		provider: "BACKGROUND_AGENTS",
		reason: "Background Agents are the recommended remote path for direct implementation. Choose local development only when Fabric Agent should launch work inside your checked-out repository.",
	};
}
