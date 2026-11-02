import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import type { ConversationDetail } from "../../../../lib/conversation-list";

vi.mock("../../../../../../../../../packages/database/prisma/client", () => ({
	db: {},
}));
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: { id: "user-example", name: "Example user", image: null },
	}),
}));
vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: null,
		isOrganizationAdmin: false,
	}),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-example",
		organizationSlug: "example-org",
		basePath: "/app/example-org",
		isOrgContext: true,
	}),
	useOrganizationId: () => "org-example",
	useEffectiveOrganizationId: (organizationId?: string | null) =>
		organizationId ?? "org-example",
	useOrganizationSlug: () => "example-org",
	useContextPath: (path: string) => `/app/example-org/${path}`,
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));
vi.mock("@saas/agents/components/FabricAgentLauncher", () => ({
	useFabricAgentLauncher: () => ({
		applyToDocument: null,
		launchContext: null,
		isOpen: false,
	}),
	useOptionalFabricAgentLauncher: () => null,
	useRegisterFabricAgentContext: () => undefined,
}));

import { TiptapEditorRegistryProvider } from "@saas/projects/components/excalidraw-auto-insert/TiptapEditorRegistry";
import { FabricDirectChat } from "../../FabricDirectChat";
import { FabricTemporalOrchestratorChat } from "../../FabricTemporalOrchestratorChat";

export function createEngineView(
	mode: "direct" | "orchestrator",
	conversationId?: string,
	conversation?: ConversationDetail,
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return {
		client,
		element: (
			<QueryClientProvider client={client}>
				<TiptapEditorRegistryProvider>
					{mode === "direct" ? (
						<FabricDirectChat
							reasoningMode="balanced"
							organizationId="org-example"
							activeConversationId={conversationId}
							activeConversation={conversation}
						/>
					) : (
						<FabricTemporalOrchestratorChat
							reasoningMode="balanced"
							organizationId="org-example"
							activeConversationId={conversationId}
							activeConversation={conversation}
						/>
					)}
				</TiptapEditorRegistryProvider>
			</QueryClientProvider>
		),
	};
}
