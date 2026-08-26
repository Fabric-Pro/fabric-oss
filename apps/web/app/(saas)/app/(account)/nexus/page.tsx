import { fetchChatAgentSelectionForUser } from "@repo/api/modules/users/procedures/chat-agent-selection/server-fetch";
import { isFeatureEnabled } from "@repo/database";
import { CopilotPage } from "@saas/ai/components/CopilotPage";
import { getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

export default async function NexusPage() {
	// Nexus is retired into the unified agent interface (#2040). The page
	// itself is deliberately left in place rather than deleted: the flag is a
	// rollback lever, and turning it off has to actually restore the old
	// surface. Deletion follows once the unified interface has carried
	// parallel multi-model tagging for a release.
	//
	// `?c=` is dropped rather than forwarded. Both routes use that parameter
	// against DIFFERENT tables — here it names an `AiChat` row, on the unified
	// surface an `AgentConversation` — so forwarding it would silently open an
	// empty conversation. Landing on a fresh chat is the honest outcome.
	if (await isFeatureEnabled("UNIFIED_AGENT_INTERFACE")) {
		redirect("/app/agents/fabric-ai");
	}

	// SSR `initialData` for the agent picker — eliminates the ~210ms blank-
	// then-pop on first render. The user's saved chips arrive with the
	// HTML, so React Query mounts already populated and never has to wait
	// on a client-side round-trip. Same data the GET endpoint returns —
	// `fetchChatAgentSelectionForUser` is what `get.ts` delegates to.
	const session = await getSession();
	const initialPersistedSelection = session?.user?.id
		? await fetchChatAgentSelectionForUser(session.user.id, null)
		: null;

	return (
		<div className="flex flex-col h-full overflow-hidden">
			<CopilotPage
				organizationId={null}
				initialPersistedSelection={initialPersistedSelection}
			/>
		</div>
	);
}
