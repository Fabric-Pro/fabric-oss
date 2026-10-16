/**
 * Fizzy #3082: after switching organizations, the ChatGPT plan status must be
 * the one for the organization on the page.
 *
 * `users.chatgptPlan.status` answers for the SESSION's active organization,
 * which lands a moment after the URL does. Fetched in that window, the
 * previous organization's answer ("no plan serves your work") was cached under
 * the new organization's key, so a member whose work there runs on a shared
 * plan was told it ran on — and was billed to — their personal key.
 *
 * These tests run the real `chatgpt-plan-status` hooks under both notices and
 * mock only what sits beneath them: the active organization, the flag and the
 * two status calls.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () =>
	(await import("../../../projects/__tests__/en-copy")).nextIntlMock(),
);

const active = vi.hoisted(() => ({
	current: {
		activeOrganization: { slug: "plan-org" } as { slug: string } | null,
		isSessionOnActiveOrganization: true,
		isSwitching: false,
		isResolvingOrganization: false,
	},
}));
vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => active.current,
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => key === "CHATGPT_PLAN",
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-plan",
		isOrgContext: true,
		isOrganizationAdmin: false,
	}),
	useContextPath: (path: string) => `/app/plan-org/${path}`,
}));
vi.mock("@saas/organizations/hooks/use-is-guest-in-org", () => ({
	useIsGuestInOrg: () => false,
}));
vi.mock("@saas/shared/lib/use-tenant-scope-resolved", () => ({
	useTenantScopeResolved: () => true,
}));
vi.mock("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));

const api = vi.hoisted(() => ({
	getStatus: vi.fn(),
	planStatus: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: { resolution: { getStatus: api.getStatus } },
		users: { chatgptPlan: { status: api.planStatus } },
	},
}));

import { AiGatewayWarningBanner } from "../AiGatewayWarningBanner";
import { PersonalKeyNotice } from "../PersonalKeyNotice";

const PERSONAL_KEY = "Your AI work here runs on your personal key";
const PROVIDER_REQUIRED = "AI provider required";
const DOCUMENT_SEARCH = "Document search needs an AI provider";

/** The plan status as the server returns it for the session's organization. */
function planStatusFor(
	slug: string,
	{ sharedPlanServesOwnWork }: { sharedPlanServesOwnWork: boolean },
) {
	return {
		connected: false,
		status: null,
		currentOrganization: {
			slug,
			name: slug,
			enabled: false,
			answered: true,
			includeBackgroundJobs: false,
		},
		organizations: [],
		sharedPlanServesOwnWork,
	};
}

function renderBoth() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	// A fresh element each time: re-rendering the identical element lets
	// React skip the subtree, so the hooks would never see the change.
	const ui = () => (
		<QueryClientProvider client={client}>
			<AiGatewayWarningBanner />
			<PersonalKeyNotice />
		</QueryClientProvider>
	);
	const utils = render(ui());
	return { ...utils, rerenderSame: () => utils.rerender(ui()) };
}

async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	window.localStorage.clear();
	active.current = {
		activeOrganization: { slug: "plan-org" },
		isSessionOnActiveOrganization: true,
		isSwitching: false,
		isResolvingOrganization: false,
	};
});

describe("PersonalKeyNotice after an organization switch", () => {
	beforeEach(() => {
		// The member's personal key is what the key resolver lands on here.
		api.getStatus.mockResolvedValue({
			canResolveProvider: true,
			resolvedProvider: "VERCEL_GATEWAY",
			resolvedProviderSource: "user",
			resolvedEmbeddingProvider: null,
			embeddingProvider: null,
		});
	});

	it("does not ask for the plan status while the session is still on the previous organization", async () => {
		active.current.isSessionOnActiveOrganization = false;
		api.planStatus.mockResolvedValue(
			planStatusFor("previous-org", { sharedPlanServesOwnWork: false }),
		);

		renderBoth();
		await waitFor(() => expect(api.getStatus).toHaveBeenCalled());
		await settle();

		expect(api.planStatus).not.toHaveBeenCalled();
		expect(screen.queryByText(PERSONAL_KEY)).toBeNull();
	});

	it("says nothing when the plan status answers for another organization", async () => {
		// The session moved on after the page loaded: the answer is not the
		// page's, so "no plan serves you" cannot be read from it.
		api.planStatus.mockResolvedValue(
			planStatusFor("previous-org", { sharedPlanServesOwnWork: false }),
		);

		renderBoth();
		await waitFor(() => expect(api.planStatus).toHaveBeenCalled());
		await settle();

		expect(screen.queryByText(PERSONAL_KEY)).toBeNull();
	});

	it("asks once the session lands, and stays silent when a shared plan serves the work there", async () => {
		active.current.isSessionOnActiveOrganization = false;
		api.planStatus.mockResolvedValue(
			planStatusFor("plan-org", { sharedPlanServesOwnWork: true }),
		);

		const { rerenderSame } = renderBoth();
		await settle();
		expect(api.planStatus).not.toHaveBeenCalled();

		active.current = {
			...active.current,
			isSessionOnActiveOrganization: true,
		};
		rerenderSame();

		await waitFor(() => expect(api.planStatus).toHaveBeenCalledTimes(1));
		await settle();
		expect(screen.queryByText(PERSONAL_KEY)).toBeNull();
	});

	it("still speaks once the status is in for this organization and no plan serves the work", async () => {
		api.planStatus.mockResolvedValue(
			planStatusFor("plan-org", { sharedPlanServesOwnWork: false }),
		);

		renderBoth();

		expect(await screen.findByText(PERSONAL_KEY)).toBeInTheDocument();
	});
});

describe("AiGatewayWarningBanner after an organization switch", () => {
	beforeEach(() => {
		api.getStatus.mockResolvedValue({
			canResolveProvider: false,
			resolvedProvider: null,
			resolvedProviderSource: null,
			resolvedEmbeddingProvider: null,
			embeddingProvider: null,
		});
	});

	it("does not claim AI is unavailable on another organization's plan answer", async () => {
		api.planStatus.mockResolvedValue(
			planStatusFor("previous-org", { sharedPlanServesOwnWork: false }),
		);

		renderBoth();
		await waitFor(() => expect(api.planStatus).toHaveBeenCalled());
		await settle();

		expect(screen.queryByText(PROVIDER_REQUIRED)).toBeNull();
		expect(screen.queryByText(DOCUMENT_SEARCH)).toBeNull();
	});

	it("names only the document-search gap once this organization's shared plan is known to serve the work", async () => {
		api.planStatus.mockResolvedValue(
			planStatusFor("plan-org", { sharedPlanServesOwnWork: true }),
		);

		renderBoth();

		expect(await screen.findByText(DOCUMENT_SEARCH)).toBeInTheDocument();
		expect(screen.queryByText(PROVIDER_REQUIRED)).toBeNull();
	});
});
