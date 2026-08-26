import { getOrchestratorPreferences } from "@repo/database";
import { getSession } from "@saas/auth/lib/server";
import FabricAIClient from "./FabricAIClient";

/**
 * Server wrapper for the Loom (Fabric AI) page. Fetches the user's
 * orchestrator preferences during SSR and passes them as `initialData` to
 * the client component's React Query hydration. Eliminates the ~200ms
 * mode-tab flash on first paint — the saved chatMode + reasoningMode arrive
 * with the HTML, so the first render that paints any active highlight
 * already paints the correct one.
 *
 * Tenant resolution: the active org is read from the Better Auth session
 * (`session.session.activeOrganizationId`), matching how the procedure
 * resolves tenant via `tenantProtectedProcedure`. The `getOrchestratorPreferences`
 * query already does the per-org "" fallback for legacy rows (PR #823).
 */
export default async function FabricAIPage() {
	const session = await getSession();

	let initialPreferences = null;
	if (session?.user?.id) {
		const activeOrgId = session.session?.activeOrganizationId ?? null;
		const prefs = await getOrchestratorPreferences(
			session.user.id,
			activeOrgId,
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
