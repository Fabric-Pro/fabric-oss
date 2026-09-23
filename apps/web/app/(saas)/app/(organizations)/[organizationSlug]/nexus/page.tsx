import { fetchChatAgentSelectionForUser } from "@repo/api/modules/users/procedures/chat-agent-selection/server-fetch";
import { isFeatureEnabled } from "@repo/database";
import { unifiedChatHrefFromNexusQuery } from "@saas/agents/lib/fabric-agent-links";
import { CopilotPage } from "@saas/ai/components/CopilotPage";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

export default async function NexusPage({
	params,
	searchParams,
}: {
	params: Promise<{ organizationSlug: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { organizationSlug } = await params;
	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	// Retired into the unified agent interface (#2040). The page stays on
	// disk because the flag is the rollback lever. Redirects within the same
	// organization so the user keeps their workspace; a saved agent link
	// (`?agent=`) opens that agent there, and `?c=` is dropped rather than
	// forwarded — see `unifiedChatHrefFromNexusQuery`.
	if (await isFeatureEnabled("UNIFIED_AGENT_INTERFACE")) {
		redirect(
			unifiedChatHrefFromNexusQuery(
				`/app/${organizationSlug}`,
				await searchParams,
			),
		);
	}

	// SSR `initialData` for the agent picker, so the saved chips arrive with
	// the HTML instead of popping in after a client round-trip. Both fetches
	// are React-cached so the auth call is free here.
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
