import { fetchChatAgentSelectionForUser } from "@repo/api/modules/users/procedures/chat-agent-selection/server-fetch";
import { isFeatureEnabled } from "@repo/database";
import { CopilotPage } from "@saas/ai/components/CopilotPage";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

export default async function NexusPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const { organizationSlug } = await params;
	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	// Retired into the unified agent interface (#2040) — see the (account)
	// variant for why the page stays on disk and why `?c=` is dropped rather
	// than forwarded. Redirects within the same organization so the user
	// keeps their workspace.
	if (await isFeatureEnabled("UNIFIED_AGENT_INTERFACE")) {
		redirect(`/app/${organizationSlug}/agents/fabric-ai`);
	}

	// SSR `initialData` for the agent picker — see the (account) variant
	// for rationale. Both fetches are React-cached so the auth call is
	// free here.
	const session = await getSession();
	const initialPersistedSelection = session?.user?.id
		? await fetchChatAgentSelectionForUser(session.user.id, organization.id)
		: null;

	return (
		<div className="flex flex-col h-full overflow-hidden">
			<CopilotPage
				organizationId={organization.id}
				organizationSlug={organizationSlug}
				initialPersistedSelection={initialPersistedSelection}
			/>
		</div>
	);
}
