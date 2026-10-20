/**
 * The Personal tab of AI Providers (Fizzy #3087): a member with no keys of
 * their own is told "No AI Provider Configured" only when the organization
 * has nothing that serves their chat and generation either — no provider key
 * the server's resolver lands on, and no ChatGPT plan serving their work.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetStatus, plan } = vi.hoisted(() => ({
	mockGetStatus: vi.fn(),
	plan: { known: true, sharedServes: false },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: {
			resolution: { getStatus: mockGetStatus },
			providers: {
				testConnection: vi.fn(),
				testSavedConnection: vi.fn(),
				upsert: vi.fn(),
				setDefault: vi.fn(),
				setEmbedding: vi.fn(),
				delete: vi.fn(),
				getConfig: vi.fn(),
				updateEnabled: vi.fn(),
			},
		},
	},
}));

vi.mock("@saas/settings/hooks/use-return-to-redirect", () => ({
	useReturnToRedirect: () => ({ triggerReturn: vi.fn() }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		organizationName: "Example Org",
		isOrgContext: true,
	}),
}));

vi.mock("@saas/organizations/hooks/use-is-guest-in-org", () => ({
	useIsGuestInOrg: () => false,
}));

vi.mock("@saas/shared/lib/use-tenant-scope-resolved", () => ({
	useTenantScopeResolved: () => true,
}));

vi.mock(
	"../../modules/saas/settings/components/chatgpt-plan/chatgpt-plan-status",
	() => ({
		useChatgptPlanStatus: () => ({
			query: { data: undefined },
			currentOrganization: null,
			known: plan.known,
		}),
		useChatgptPlanStatusKnown: () => plan.known,
		useChatgptPlanServesOwnWork: () => false,
		useSharedChatgptPlanServesOwnWork: () => plan.sharedServes,
	}),
);

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AccountAiProvidersSettings } from "../../modules/saas/settings/components/chatgpt-plan/AccountAiProvidersSettings";

const WARNING = "No AI Provider Configured";

const PERSONAL_NONE = {
	isConfigured: false,
	canResolveProvider: false,
	resolvedProvider: null,
	resolvedProviderSource: null,
	message: "",
	configuredProviders: [],
	embeddingProvider: null,
	embeddingModel: null,
};

const ORG_SERVES = {
	...PERSONAL_NONE,
	isConfigured: true,
	canResolveProvider: true,
	resolvedProvider: "ANTHROPIC_DIRECT",
	resolvedProviderSource: "organization",
};

// An organization whose only key is "Embeddings only": configured, but the
// resolver lands on nothing for chat and generation.
const ORG_EMBEDDINGS_ONLY = {
	...PERSONAL_NONE,
	isConfigured: true,
};

function serve(org: object) {
	mockGetStatus.mockImplementation(
		async (input: { organizationId: string | null }) =>
			input.organizationId === null ? PERSONAL_NONE : org,
	);
}

function renderTab() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<AccountAiProvidersSettings />
		</QueryClientProvider>,
	);
	return queryClient;
}

beforeEach(() => {
	vi.clearAllMocks();
	plan.known = true;
	plan.sharedServes = false;
});

async function settled() {
	await waitFor(() =>
		expect(mockGetStatus).toHaveBeenCalledWith({ organizationId: "org-1" }),
	);
	await waitFor(() =>
		expect(mockGetStatus).toHaveBeenCalledWith({ organizationId: null }),
	);
	// Let both queries resolve and the form re-render.
	await act(async () => {});
}

describe("Personal tab: No AI Provider Configured", () => {
	it("is hidden when the organization's provider serves the member (AC1)", async () => {
		serve(ORG_SERVES);
		renderTab();
		await settled();
		expect(screen.queryByText(WARNING)).toBeNull();
	});

	it("is shown when the organization has nothing either (AC2)", async () => {
		serve({ ...PERSONAL_NONE });
		renderTab();
		expect(await screen.findByText(WARNING)).toBeInTheDocument();
	});

	it("is shown when the organization's only key is embeddings-only", async () => {
		serve(ORG_EMBEDDINGS_ONLY);
		renderTab();
		expect(await screen.findByText(WARNING)).toBeInTheDocument();
	});

	it("is hidden when a shared ChatGPT account serves the member", async () => {
		plan.sharedServes = true;
		serve({ ...PERSONAL_NONE });
		renderTab();
		await settled();
		expect(screen.queryByText(WARNING)).toBeNull();
	});

	it("waits for the plan status of this organization before warning", async () => {
		plan.known = false;
		serve({ ...PERSONAL_NONE });
		renderTab();
		await settled();
		expect(screen.queryByText(WARNING)).toBeNull();
	});

	it("follows the organization's provider being added and removed (AC3)", async () => {
		serve({ ...PERSONAL_NONE });
		const queryClient = renderTab();
		expect(await screen.findByText(WARNING)).toBeInTheDocument();

		serve(ORG_SERVES);
		await act(() =>
			queryClient.invalidateQueries({ queryKey: ["aiConfigStatus"] }),
		);
		await waitFor(() => expect(screen.queryByText(WARNING)).toBeNull());

		serve({ ...PERSONAL_NONE });
		await act(() =>
			queryClient.invalidateQueries({ queryKey: ["aiConfigStatus"] }),
		);
		expect(await screen.findByText(WARNING)).toBeInTheDocument();
	});
});
