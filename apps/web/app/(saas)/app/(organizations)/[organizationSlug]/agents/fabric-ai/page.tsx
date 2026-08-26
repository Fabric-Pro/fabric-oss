import { getOrchestratorPreferences } from "@repo/database";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";
import FabricAIClient from "../../../../agents/fabric-ai/FabricAIClient";

/**
 * Organization-scoped Loom (Fabric AI) page.
 *
 * Mirrors the (account) variant's SSR `initialData` pattern: fetches
 * orchestrator preferences server-side and passes them to `FabricAIClient`
 * so the saved chatMode + reasoningMode arrive with the HTML and the first
 * paint already shows the correct active mode tab — no flash, no fetch
 * wait. The url's `[organizationSlug]` is resolved to the org id here
 * (rather than relying on `session.activeOrganizationId`) so SSR is
 * deterministic on cold loads where the session hasn't yet been updated
 * by the client-side ActiveOrganizationProvider.
 */
export default async function OrganizationFabricAIPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const { organizationSlug } = await params;
	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	const session = await getSession();
	let initialPreferences = null;
	if (session?.user?.id) {
		const prefs = await getOrchestratorPreferences(
			session.user.id,
			organization.id,
		);
		initialPreferences = prefs
			? {
					exists: true,
					enabledMcpConfigIds: prefs.enabledMcpConfigIds,
					enabledAgentIds: prefs.enabledAgentIds,
					enabledWorkspaceIds: prefs.enabledWorkspaceIds,
					autonomyLevel: prefs.autonomyLevel,
					chatMode: prefs.chatMode,
					reasoningMode: prefs.reasoningMode,
					uiMode: prefs.uiMode,
				}
			: {
					exists: false,
					enabledMcpConfigIds: [],
					enabledAgentIds: [],
					enabledWorkspaceIds: [],
					autonomyLevel: "BALANCED" as const,
					chatMode: "orchestrator" as const,
					reasoningMode: "balanced" as const,
					uiMode: "simple" as const,
				};
	}

	return <FabricAIClient initialPreferences={initialPreferences} />;
}
