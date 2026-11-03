import { createQueryClient } from "@shared/lib/query-client";
import {
	dehydrate,
	type QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
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
	serverRegistry:
		vi.fn<
			(input: { id: string; organizationId: string }) => Promise<unknown>
		>(),
	serverConfig:
		vi.fn<(input: { organizationId: string }) => Promise<unknown>>(),
	serverHeaders: vi.fn(),
	organization:
		vi.fn<(slug: string) => Promise<{ id: string; slug: string } | null>>(),
	send: vi.fn(),
}));
let serverClient: QueryClient;
let browserClient: QueryClient;
vi.mock("@saas/auth/lib/server", () => ({
	getActiveOrganization: m.organization,
}));
vi.mock("@saas/shared/lib/catalog-request-timing", () => ({
	logChatRequestTiming: vi.fn(),
	measureCatalogRequestPhase: (
		_phase: string,
		operation: () => Promise<unknown>,
	) => operation(),
}));
vi.mock("next/headers", () => ({
	headers: async () =>
		new Headers({
			cookie: "session=example",
			"x-correlation-id": "example-correlation",
		}),
}));
vi.mock("@repo/api/modules/agents/lib/agent-chat-server-client", () => ({
	createAgentChatServerClient: (headers: Headers) => {
		m.serverHeaders(headers);
		return {
			getRegisteredAgent: m.serverRegistry,
			getAiConfigStatus: m.serverConfig,
		};
	},
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
	useEffectiveOrganizationId: (id?: string | null) =>
		id === undefined ? "org-route" : id,
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
	m.serverRegistry.mockResolvedValue(agent);
	m.serverConfig.mockResolvedValue({ isConfigured: true });
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
		expect(m.serverRegistry.mock.calls[0]?.[0]).toEqual({
			id: "registered-example",
			organizationId: "org-route",
		});
		expect(m.serverConfig.mock.calls[0]?.[0]).toEqual({
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
		expect(m.serverRegistry).toHaveBeenCalledOnce();
		expect(m.serverConfig).toHaveBeenCalledOnce();
		expect(m.registry).not.toHaveBeenCalled();
		expect(m.config).not.toHaveBeenCalled();
		expect(m.serverHeaders.mock.calls[0]?.[0].get("cookie")).toBe(
			"session=example",
		);
		expect(m.serverHeaders.mock.calls[0]?.[0].get("x-correlation-id")).toBe(
			"example-correlation",
		);
		expect(m.send).not.toHaveBeenCalled();
	});
	it("rejects an inaccessible route organization before fetching agent or provider data", async () => {
		m.organization.mockResolvedValue(null);
		await expect(route()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
		expect(m.registry).not.toHaveBeenCalled();
		expect(m.config).not.toHaveBeenCalled();
		expect(m.serverRegistry).not.toHaveBeenCalled();
		expect(m.serverConfig).not.toHaveBeenCalled();
		expect(m.serverHeaders).not.toHaveBeenCalled();
	});
	it("preserves the retired-system-agent notice", async () => {
		m.registry.mockResolvedValue({ ...agent, agentId: "cuga_generalist" });
		m.serverRegistry.mockResolvedValue({
			...agent,
			agentId: "cuga_generalist",
		});
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
		m.serverConfig.mockResolvedValue({ isConfigured: false });
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
		m.serverRegistry.mockRejectedValue(
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

	it("keeps rejected server reads out of the dehydrated cache", async () => {
		m.serverConfig.mockRejectedValue(
			new Error("Synthetic configuration refusal"),
		);
		await route();
		expect(
			serverClient.getQueryState(["aiConfigStatus", "org-route"])?.status,
		).toBe("error");
		expect(
			dehydrate(serverClient).queries.map((query) => query.queryKey),
		).not.toContainEqual(["aiConfigStatus", "org-route"]);
		expect(m.config).not.toHaveBeenCalled();
		expect(m.send).not.toHaveBeenCalled();
	});

	it("starts both server reads before either completes", async () => {
		let finishRegistry = () => {};
		let finishConfig = () => {};
		m.serverRegistry.mockImplementation(
			() =>
				new Promise((resolve) => {
					finishRegistry = () => resolve(agent);
				}),
		);
		m.serverConfig.mockImplementation(
			() =>
				new Promise((resolve) => {
					finishConfig = () => resolve({ isConfigured: true });
				}),
		);
		const pending = route();
		await vi.waitFor(() => {
			expect(m.serverRegistry).toHaveBeenCalledOnce();
			expect(m.serverConfig).toHaveBeenCalledOnce();
		});
		finishRegistry();
		finishConfig();
		await pending;
		expect(m.registry).not.toHaveBeenCalled();
		expect(m.config).not.toHaveBeenCalled();
	});
});
