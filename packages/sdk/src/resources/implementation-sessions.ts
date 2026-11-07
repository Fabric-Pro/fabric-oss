import type { FabricHttpClient } from "../client.js";

export interface ImplementationSession {
	id: string;
	projectId: string;
	storyId: string;
	taskId: string | null;
	status: string;
	kind: string;
	createdAt: string;
	startedAt: string | null;
	mergedAt: string | null;
	pullRequestNumber: number | null;
	deliveryEvidence: "PR_MERGED" | "PR_OPENED" | "NO_MERGE_EVIDENCE";
	deployment: "UNKNOWN";
	externalAgentCost: "NOT_REPORTED";
}
export interface StartImplementationOptions {
	/** Stable UUID; reuse the exact request after a timeout. Changed payload conflicts. */
	requestId: string;
	storyId: string;
	taskId?: string | null;
	kind?: "IMPLEMENT" | "SPIKE";
	spikeQuestion?: string;
	serverId?: string;
	llmConnection?: string;
	model?: string;
	targetMachine?: string;
	fallbackPolicy?:
		| "subscription_harnesses"
		| "org_paid_api"
		| "pause_on_limit";
	org?: string;
}
function path(projectId: string, id?: string, org?: string) {
	return `/projects/${encodeURIComponent(projectId)}/implementation-sessions${id ? `/${encodeURIComponent(id)}` : ""}${org ? `?org=${encodeURIComponent(org)}` : ""}`;
}
/** Mutations are sent once, even with client-wide retries enabled. Inspect an
 * uncertain outcome first; legacy follow-ups have no durable prompt receipt. */
export function implementationSessionMethods(http: FabricHttpClient) {
	return {
		listImplementationSessions(
			projectId: string,
			options: {
				org?: string;
				storyId?: string;
				cursor?: string;
				limit?: number;
			} = {},
		): Promise<{
			sessions: ImplementationSession[];
			hasMore: boolean;
			nextCursor?: string;
		}> {
			const params = new URLSearchParams();
			if (options.org) {
				params.set("org", options.org);
			}
			if (options.cursor) {
				params.set("cursor", options.cursor);
			}
			if (options.storyId) {
				params.set("storyId", options.storyId);
			}
			if (options.limit !== undefined) {
				params.set("limit", String(options.limit));
			}
			return http.get(
				`${path(projectId)}${params.size ? `?${params}` : ""}`,
			);
		},
		getImplementationSession(
			projectId: string,
			id: string,
			options: { org?: string } = {},
		): Promise<ImplementationSession> {
			return http.get(path(projectId, id, options.org));
		},
		startImplementationSession(
			projectId: string,
			options: StartImplementationOptions,
		): Promise<{
			codingRunId: string;
			workflowId: string;
			status: string;
			dispatchUnconfirmed?: boolean;
			inspectionRequired?: boolean;
			message?: string;
		}> {
			const { org, ...input } = options;
			return http.post(path(projectId, undefined, org), input, {
				retry: { maxRetries: 0 },
			});
		},
		cancelImplementationSession(
			projectId: string,
			id: string,
			options: { org?: string } = {},
		): Promise<{ status: string }> {
			return http.post(
				`${path(projectId, id)}/cancel${options.org ? `?org=${encodeURIComponent(options.org)}` : ""}`,
				{},
				{ retry: { maxRetries: 0 } },
			);
		},
		followUpImplementationSession(
			projectId: string,
			id: string,
			options: { message: string; promptId: string; org?: string },
		): Promise<{ sent: boolean; messageId?: string }> {
			const { org, ...input } = options;
			return http.post(
				`${path(projectId, id)}/follow-up${org ? `?org=${encodeURIComponent(org)}` : ""}`,
				input,
				{ retry: { maxRetries: 0 } },
			);
		},
		getImplementationMessages(
			projectId: string,
			id: string,
			options: { org?: string } = {},
		): Promise<{
			available: boolean;
			messages: Array<{
				id: string;
				role: "user" | "assistant";
				content: string;
			}>;
			truncated: boolean;
		}> {
			return http.get(
				`${path(projectId, id)}/messages${options.org ? `?org=${encodeURIComponent(options.org)}` : ""}`,
			);
		},
	};
}
