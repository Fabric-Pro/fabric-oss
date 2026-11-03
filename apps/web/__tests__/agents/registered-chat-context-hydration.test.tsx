// @vitest-environment node

import {
	agentChatAiConfigQueryOptions,
	registeredAgentChatQueryOptions,
} from "@saas/agents/lib/agent-chat-queries";
import { ActiveOrganizationProvider } from "@saas/organizations/components/ActiveOrganizationProvider";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import {
	activeOrganizationQueryKey,
	organizationListQueryKey,
} from "@saas/organizations/lib/api";
import { OrganizationGuestProvider } from "@saas/organizations/lib/organization-guest-context";
import { createQueryClient } from "@shared/lib/query-client";
import {
	dehydrate,
	HydrationBoundary,
	type QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../../app/(saas)/app/(organizations)/[organizationSlug]/agents/[agentId]/chat/page";

const m = vi.hoisted(() => ({
	registry: vi.fn(),
	config: vi.fn(),
	serverRegistry: vi.fn(),
	serverConfig: vi.fn(),
	organization: vi.fn(),
	fullOrganization: vi.fn(),
	organizationList: vi.fn(),
	setActive: vi.fn(),
	send: vi.fn(),
	chat: vi.fn(),
}));

let serverClient: QueryClient;
let renderClient: QueryClient;

vi.mock("@saas/auth/lib/server", () => ({
	getActiveOrganization: m.organization,
}));
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		session: { userId: "user-example", activeOrganizationId: "org-route" },
		user: { id: "user-example" },
	}),
}));
vi.mock("@repo/auth/client", () => ({
	authClient: {
		organization: {
			getFullOrganization: m.fullOrganization,
			list: m.organizationList,
			setActive: m.setActive,
		},
	},
}));
vi.mock("@repo/auth/lib/helper", () => ({
	isOrganizationAdmin: () => false,
}));
vi.mock("@saas/shared/lib/catalog-request-timing", () => ({
	logChatRequestTiming: vi.fn(),
	measureCatalogRequestPhase: (
		_phase: string,
		operation: () => Promise<unknown>,
	) => operation(),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@repo/api/modules/agents/lib/agent-chat-server-client", () => ({
	createAgentChatServerClient: () => ({
		getRegisteredAgent: m.serverRegistry,
		getAiConfigStatus: m.serverConfig,
	}),
}));
vi.mock("@shared/lib/server", () => ({
	getServerQueryClient: () => serverClient,
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agents: { registry: { get: m.registry } },
		aiConfig: { resolution: { getStatus: m.config } },
	},
}));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
	},
	useParams: () => ({ organizationSlug: "example-org" }),
	usePathname: () => "/app/example-org/agents/registered-example/chat",
	useSearchParams: () => new URLSearchParams(),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@shared/hooks/router", () => ({
	useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("nprogress", () => ({ default: { start: vi.fn(), done: vi.fn() } }));
vi.mock("@saas/shared/contexts/FullscreenContext", () => ({
	useFullscreen: () => ({ isFullscreen: false }),
}));
vi.mock("@saas/shared/contexts/SidebarCollapseContext", () => ({
	useSidebarCollapse: () => ({ isCollapsed: false }),
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => true,
}));
vi.mock("@saas/agents/hooks/useDataAnalystChat", () => ({
	useDataAnalystChat: (input: { organizationId: string }) => {
		m.chat(input);
		return {
			messages: [],
			running: false,
			send: m.send,
			reset: vi.fn(),
			stop: vi.fn(),
		};
	},
}));

const organization = {
	id: "org-route",
	slug: "example-org",
	name: "Example organization",
	logo: null,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	members: [{ id: "member-example", userId: "user-example", role: "member" }],
	invitations: [],
};
const agent = {
	id: "registered-example",
	agentId: "data_analyst",
	displayName: "Data Analyst",
	scope: "SYSTEM",
	status: "ACTIVE",
	metadata: null,
};
const activeKey = activeOrganizationQueryKey(organization.slug);
const registryKey = registeredAgentChatQueryOptions(
	agent.id,
	organization.id,
).queryKey;
const unresolvedRegistryKey = registeredAgentChatQueryOptions(
	agent.id,
	null,
).queryKey;
const configKey = agentChatAiConfigQueryOptions(organization.id).queryKey;

function ContextProbe() {
	const { organizationId } = useOrganizationContext();
	return <output data-organization-id={organizationId ?? "unresolved"} />;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
	serverClient = createQueryClient();
	// ApiClientProvider creates a fresh client during SSR, separate from the
	// request-scoped client whose snapshots the server layouts serialize.
	renderClient = createQueryClient();
	m.organization.mockResolvedValue(organization);
	m.serverRegistry.mockResolvedValue(agent);
	m.serverConfig.mockResolvedValue({ isConfigured: true });
});

afterEach(() => {
	serverClient.clear();
	renderClient.clear();
	vi.restoreAllMocks();
});

describe("registered chat organization context during SSR", () => {
	it.each([false, true])(
		"outer snapshot contains active organization: %s",
		async (outerContainsActiveOrganization) => {
			serverClient.setQueryData(organizationListQueryKey, [organization]);
			if (outerContainsActiveOrganization) {
				serverClient.setQueryData(activeKey, organization);
			}
			const outerState = dehydrate(serverClient);
			serverClient.setQueryData(activeKey, organization);
			const organizationState = dehydrate(serverClient);
			const page = await Page({
				params: Promise.resolve({
					organizationSlug: organization.slug,
					agentId: agent.id,
				}),
			});

			expect(serverClient.getQueryData(activeKey)).toEqual(organization);
			expect(serverClient.getQueryData(registryKey)).toEqual(agent);
			expect(serverClient.getQueryData(configKey)).toEqual({
				isConfigured: true,
			});
			expect(
				outerState.queries.some((query) =>
					query.queryKey.includes("activeOrganization"),
				),
			).toBe(outerContainsActiveOrganization);
			expect(
				organizationState.queries.map((query) => query.queryKey),
			).toContainEqual(activeKey);
			// Preserve the application's 60-second freshness policy. Missing data,
			// rather than an expired cache entry, is the only changed input.
			expect(renderClient.getDefaultOptions().queries?.staleTime).toBe(
				60_000,
			);
			expect(serverClient.getQueryState(activeKey)?.dataUpdatedAt).toBe(
				Date.now(),
			);
			expect(renderClient.getQueryCache().getAll()).toHaveLength(0);

			// SaaS boundary -> parent organization provider -> organization
			// boundary -> page boundary. No provider is moved under hydration.
			const html = renderToString(
				<QueryClientProvider client={renderClient}>
					<HydrationBoundary state={outerState}>
						<ActiveOrganizationProvider>
							<HydrationBoundary state={organizationState}>
								<OrganizationGuestProvider
									organizationSlug={organization.slug}
									isGuest={false}
								>
									<ContextProbe />
									{page}
								</OrganizationGuestProvider>
							</HydrationBoundary>
						</ActiveOrganizationProvider>
					</HydrationBoundary>
				</QueryClientProvider>,
			);

			expect(renderClient.getQueryData(registryKey)).toEqual(agent);
			expect(renderClient.getQueryData(configKey)).toEqual({
				isConfigured: true,
			});
			expect(html).toContain("Data analyst");
			expect(html).toContain("Ask about your data");
			expect(html).toContain("<textarea");
			expect(html).not.toContain("animate-spin");
			expect(html).toContain('href="/app/example-org/agents"');
			expect(
				renderClient.getQueryState(unresolvedRegistryKey),
			).toBeUndefined();
			expect(m.chat).toHaveBeenCalledWith({
				organizationId: organization.id,
			});
			if (outerContainsActiveOrganization) {
				expect(html).toContain('data-organization-id="org-route"');
				expect(renderClient.getQueryData(activeKey)).toEqual(
					organization,
				);
			} else {
				expect(html).toContain('data-organization-id="unresolved"');
				// The parent hook already created this entry. HydrationBoundary
				// queues existing-query hydration for an effect, which SSR never runs.
				expect(renderClient.getQueryState(activeKey)?.status).toBe(
					"pending",
				);
				expect(renderClient.getQueryData(activeKey)).toBeUndefined();
			}
			expect(
				renderClient.getQueryState(
					agentChatAiConfigQueryOptions(null).queryKey,
				),
			).toBeUndefined();
			expect(m.serverRegistry).toHaveBeenCalledExactlyOnceWith({
				id: agent.id,
				organizationId: organization.id,
			});
			expect(m.serverConfig).toHaveBeenCalledExactlyOnceWith({
				organizationId: organization.id,
			});
			expect(m.fullOrganization).not.toHaveBeenCalled();
			expect(m.organizationList).not.toHaveBeenCalled();
			expect(m.registry).not.toHaveBeenCalled();
			expect(m.config).not.toHaveBeenCalled();
			expect(m.setActive).not.toHaveBeenCalled();
			expect(m.send).not.toHaveBeenCalled();
		},
	);
});
