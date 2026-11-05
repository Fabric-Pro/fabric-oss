import { ORPCError } from "@orpc/server";
import type { AgentPreviewDraft } from "@repo/temporal/agent-preview-contracts";
/** Supplied only by the authenticated transport; never accepted in caller input. */
export type AgentPreviewSelectionPolicy = (
	draft: Pick<AgentPreviewDraft, "workspaceIds" | "skillIds">,
) => unknown;
export function agentPreviewSelectionScopePolicy(
	scopes: readonly string[],
): AgentPreviewSelectionPolicy {
	return (draft) => {
		for (const [selected, scope] of [
			[draft.workspaceIds.length > 0, "workspaces:read"],
			[draft.skillIds.length > 0, "skills:read"],
		] as const) {
			if (selected && !scopes.includes(scope) && !scopes.includes("*")) {
				throw new ORPCError("FORBIDDEN", {
					message: `Preview selections require the declared ${scope} scope.`,
					data: { code: "INSUFFICIENT_SCOPE", scope },
				});
			}
		}
	};
}
