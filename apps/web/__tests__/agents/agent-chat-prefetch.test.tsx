import { createQueryClient } from "@shared/lib/query-client";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../../app/(saas)/app/(organizations)/[organizationSlug]/agents/[agentId]/chat/page";

const m = vi.hoisted(() => ({
	registry:
		vi.fn<
			(input: { id: string; organizationId?: string }) => Promise<unknown>
		>(),
	config: vi.fn<
		(input: { organizationId: string | null }) => Promise<unknown>
	>(),
	organization:
		vi.fn<(slug: string) => Promise<{ id: string; slug: string } | null>>(),
	send: vi.fn(),
}));
let serverClient: QueryClient;
let browserClient: QueryClient;
vi.mock("@saas/auth/lib/server", () => ({
	getActiveOrganization: m.organization,
}));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
	},
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
	usePathname: () => "/app/example-org/agents/registered-example/chat",
	useSearchParams: () => new URLSearchParams(),
	useParams: () => ({}),
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
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-route",
		basePath: "/app/example-org",
		organizationName: "Example",
		isOrgContext: true,
	}),
}));
vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({ activeOrganization: null }),
}));
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
	useDataAnalystChat: () => ({
		messages: [],
		running: false,
		send: m.send,
		reset: vi.fn(),
		stop: vi.fn(),
	}),
}));

const agent = {
	id: "registered-example",
	agentId: "data_analyst",
	displayName: "Data Analyst",
	scope: "SYSTEM",
	status: "ACTIVE",
	metadata: null,
};
beforeEach(() => {
	vi.clearAllMocks();
	serverClient = createQueryClient();
	browserClient = createQueryClient();
	m.organization.mockResolvedValue({ id: "org-route", slug: "example-org" });
	m.registry.mockResolvedValue(agent);
	m.config.mockResolvedValue({ isConfigured: true });
});
afterEach(() => {
	serverClient.clear();
	browserClient.clear();
});
async function route() {
	return Page({
		params: Promise.resolve({
			organizationSlug: "example-org",
			agentId: "registered-example",
		}),
	});
}

describe("organization chat server prefetch", () => {
	it("renders the real Analyst welcome on the server and shares one registry result with both client readers", async () => {
		const element = await route();
		expect(m.organization).toHaveBeenCalledWith("example-org");
		expect(m.registry.mock.calls[0]?.[0]).toEqual({
			id: "registered-example",
			organizationId: "org-route",
		});
		expect(m.config.mock.calls[0]?.[0]).toEqual({
			organizationId: "org-route",
		});
		const view = (
			<QueryClientProvider client={browserClient}>
				{element}
			</QueryClientProvider>
		);
		const html = renderToString(view);
		expect(html).toContain("Data analyst");
		expect(html).toContain("Ask about your data");
		render(view);
		expect(
			await screen.findByRole("heading", { name: "Data analyst" }),
		).toBeInTheDocument();
		expect(m.registry).toHaveBeenCalledOnce();
		expect(m.config).toHaveBeenCalledOnce();
		expect(m.send).not.toHaveBeenCalled();
	});
	it("rejects an inaccessible route organization before fetching agent or provider data", async () => {
		m.organization.mockResolvedValue(null);
		await expect(route()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
		expect(m.registry).not.toHaveBeenCalled();
		expect(m.config).not.toHaveBeenCalled();
	});
	it("preserves the retired-system-agent notice", async () => {
		m.registry.mockResolvedValue({ ...agent, agentId: "cuga_generalist" });
		const element = await route();
		render(
			<QueryClientProvider client={browserClient}>
				{element}
			</QueryClientProvider>,
		);
		expect(
			await screen.findByRole("heading", { name: "Agent unavailable" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "Data analyst" }),
		).toBeNull();
		expect(m.send).not.toHaveBeenCalled();
	});
	it("preserves provider-not-configured behavior", async () => {
		m.config.mockResolvedValue({ isConfigured: false });
		const element = await route();
		render(
			<QueryClientProvider client={browserClient}>
				{element}
			</QueryClientProvider>,
		);
		expect(
			await screen.findByText("AI Provider Not Configured"),
		).toBeInTheDocument();
		expect(m.send).not.toHaveBeenCalled();
	});
	it("does not turn an agent refusal into an empty Analyst welcome", async () => {
		m.registry.mockRejectedValue(
			new Error("Synthetic agent access refused"),
		);
		const element = await route();
		render(
			<QueryClientProvider client={browserClient}>
				{element}
			</QueryClientProvider>,
		);
		expect(
			await screen.findByText("Failed to load agent"),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "Data analyst" }),
		).toBeNull();
		expect(m.send).not.toHaveBeenCalled();
	});
});
