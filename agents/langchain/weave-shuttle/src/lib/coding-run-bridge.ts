export interface StartWeaveCodingRunInput {
	planId: string;
	prompt: string;
	category: string;
	executionProvider?: "BACKGROUND_AGENTS" | "KANBAN_LOCAL" | "VIBE_WORKSPACE";
	/** Category-based model override from ProjectWeaveConfig.categoryRouting */
	modelOverride?: string;
	userId: string;
	organizationId: string | null;
	projectContext?: {
		projectName?: string;
		techStack?: string;
		description?: string;
	};
	timeoutMs?: number;
}

export interface WeaveCodingRunResult {
	codingRunId: string;
	workflowId: string;
	status: "completed" | "failed" | "cancelled" | "running";
	pullRequestUrl?: string;
	summary: string;
}

function getFabricInternalBaseUrl(): string {
	return (
		process.env.FABRIC_INTERNAL_URL ||
		process.env.RUNTIME_API_URL ||
		process.env.NEXT_PUBLIC_APP_URL ||
		"http://localhost:3000"
	);
}

export async function startWeaveCodingRunAndWait(
	input: StartWeaveCodingRunInput,
): Promise<WeaveCodingRunResult> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		throw new Error(
			"AGENT_SERVICE_SECRET must be set for the Shuttle coding-run bridge",
		);
	}

	const response = await fetch(
		`${getFabricInternalBaseUrl()}/api/internal/weave-coding-run`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Agent-Service-Token": secret,
			},
			body: JSON.stringify(input),
		},
	);

	const data = (await response.json()) as
		| WeaveCodingRunResult
		| { error?: string };
	if (!response.ok) {
		throw new Error(
			("error" in data && data.error) ||
				`Internal coding-run bridge failed (${response.status})`,
		);
	}

	return data as WeaveCodingRunResult;
}
