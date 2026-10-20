/**
 * What serves a member's chat and generation in the organization on screen
 * (Fizzy #3087). The work-item dialog warns and blocks only when this answers
 * nothing at all, so a member on a personal key or a ChatGPT plan is never
 * blocked, and an organization whose only key is "Embeddings only" is.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetStatus, state } = vi.hoisted(() => ({
	mockGetStatus: vi.fn(),
	state: {
		planKnown: true,
		ownPlan: false,
		sharedPlan: false,
		guest: false,
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: { resolution: { getStatus: mockGetStatus } },
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "org-1" }),
}));

vi.mock("@saas/organizations/hooks/use-is-guest-in-org", () => ({
	useIsGuestInOrg: () => state.guest,
}));

vi.mock("@saas/shared/lib/use-tenant-scope-resolved", () => ({
	useTenantScopeResolved: () => true,
}));

vi.mock("@saas/settings/components/chatgpt-plan/chatgpt-plan-status", () => ({
	useChatgptPlanStatusKnown: () => state.planKnown,
	useChatgptPlanServesOwnWork: () => state.ownPlan,
	useSharedChatgptPlanServesOwnWork: () => state.sharedPlan,
}));

import {
	servesAnything,
	useAiServesMemberHere,
} from "../use-ai-serves-member-here";

/** As the status procedure answers inside an organization. */
function status(canResolveProvider: boolean) {
	return {
		isConfigured: true,
		canResolveProvider,
		resolvedProvider: canResolveProvider ? "ANTHROPIC_DIRECT" : null,
		resolvedProviderSource: canResolveProvider ? "user" : null,
	};
}

function blocked() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	const { result } = renderHook(
		() => servesAnything(useAiServesMemberHere()),
		{ wrapper },
	);
	return result;
}

beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(state, {
		planKnown: true,
		ownPlan: false,
		sharedPlan: false,
		guest: false,
	});
});

describe("useAiServesMemberHere", () => {
	it("does not block a member whose own plan serves them, with no key anywhere", async () => {
		state.ownPlan = true;
		mockGetStatus.mockResolvedValue(status(false));
		const result = blocked();
		await waitFor(() => expect(result.current).toBe(true));
	});

	it("does not block a member whose organization shares a ChatGPT account", async () => {
		state.sharedPlan = true;
		mockGetStatus.mockResolvedValue(status(false));
		const result = blocked();
		await waitFor(() => expect(result.current).toBe(true));
	});

	it("does not block a member on their own personal key", async () => {
		// The procedure resolves the caller's personal default inside an
		// organization with none of its own.
		mockGetStatus.mockResolvedValue(status(true));
		const result = blocked();
		await waitFor(() => expect(result.current).toBe(true));
		expect(mockGetStatus).toHaveBeenCalledWith({ organizationId: "org-1" });
	});

	it("blocks an organization whose only key is embeddings-only", async () => {
		// Stored, so `isConfigured`, but nothing chat can resolve to.
		mockGetStatus.mockResolvedValue(status(false));
		const result = blocked();
		await waitFor(() => expect(result.current).toBe(false));
	});

	it("answers nothing until the plan status is in for this organization", async () => {
		state.planKnown = false;
		mockGetStatus.mockResolvedValue(status(false));
		const result = blocked();
		await waitFor(() => expect(mockGetStatus).toHaveBeenCalled());
		expect(result.current).toBeNull();
	});

	it("never asks about the host's setup for a project guest", () => {
		state.guest = true;
		const result = blocked();
		expect(result.current).toBeNull();
		expect(mockGetStatus).not.toHaveBeenCalled();
	});
});
