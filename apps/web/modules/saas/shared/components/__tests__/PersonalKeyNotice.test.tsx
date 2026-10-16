/**
 * Unit tests for `PersonalKeyNotice` (Fizzy #3082).
 *
 * Inside an organization with no usable provider of its own, the resolver
 * falls back to the member's personal key and bills them for the work. The
 * notice says so — and only then. The show/hide matrix below is the contract:
 *
 * - shown: the chat path resolves to the caller's own key (`"user"` source);
 * - hidden: it resolves to the organization's key;
 * - hidden: a ChatGPT plan (own or shared) serves the member's own work, since
 *   the plan runs before any key;
 * - hidden: for a project guest, who is never asked about the host's setup;
 * - hidden: while the status or plan answer is still loading, or before the
 *   URL's organization has resolved;
 * - hidden: when nothing resolves at all, which is the "AI provider required"
 *   notice's case — the two are never on screen together.
 *
 * Copy is asserted against the real `en.json`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () =>
	(await import("../../../projects/__tests__/en-copy")).nextIntlMock(),
);

const orgContextMock = vi.fn();
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => orgContextMock(),
	useContextPath: (path: string) => `/app/acme/${path}`,
}));

const guestMock = vi.fn();
vi.mock("@saas/organizations/hooks/use-is-guest-in-org", () => ({
	useIsGuestInOrg: () => guestMock(),
}));

const tenantScopeMock = vi.fn();
vi.mock("@saas/shared/lib/use-tenant-scope-resolved", () => ({
	useTenantScopeResolved: () => tenantScopeMock(),
}));

const ownPlanMock = vi.fn();
const sharedPlanMock = vi.fn();
const planStatusKnownMock = vi.fn();
vi.mock("@saas/settings/components/chatgpt-plan/chatgpt-plan-status", () => ({
	useChatgptPlanStatusKnown: () => planStatusKnownMock(),
	useChatgptPlanServesOwnWork: () => ownPlanMock(),
	useSharedChatgptPlanServesOwnWork: () => sharedPlanMock(),
}));

const getStatusMock = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: {
			resolution: {
				getStatus: (input: unknown) => getStatusMock(input),
			},
		},
	},
}));

vi.mock("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));

import { AiGatewayWarningBanner } from "../AiGatewayWarningBanner";
import { PersonalKeyNotice } from "../PersonalKeyNotice";

const TITLE = "Your AI work here runs on your personal key";

function status({
	canResolveProvider = true,
	resolvedProvider = "OPENAI_DIRECT" as string | null,
	resolvedProviderSource = "user" as "organization" | "user" | null,
} = {}) {
	return {
		canResolveProvider,
		isConfigured: false,
		resolvedProvider,
		resolvedProviderSource,
		resolvedEmbeddingProvider: null,
		embeddingProvider: null,
	};
}

function renderNotice(children: ReactNode = <PersonalKeyNotice />) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	return render(
		<QueryClientProvider client={client}>{children}</QueryClientProvider>,
	);
}

async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	window.localStorage.clear();
	orgContextMock.mockReturnValue({
		organizationId: "org-1",
		isOrgContext: true,
		isOrganizationAdmin: false,
	});
	guestMock.mockReturnValue(false);
	tenantScopeMock.mockReturnValue(true);
	ownPlanMock.mockReturnValue(false);
	sharedPlanMock.mockReturnValue(false);
	planStatusKnownMock.mockReturnValue(true);
	getStatusMock.mockResolvedValue(status());
});

describe("PersonalKeyNotice — when it shows", () => {
	it("tells a member their work here runs on, and is billed to, their own key", async () => {
		renderNotice();

		expect(await screen.findByText(TITLE)).toBeDefined();
		expect(
			screen.getByText(
				"This organization has no AI provider for chat and generation, so your own OpenAI key is used and billed to you.",
			),
		).toBeDefined();
		expect(getStatusMock).toHaveBeenCalledWith({ organizationId: "org-1" });
	});

	it("sends a member to their own keys, and not to a page they cannot edit", async () => {
		renderNotice();

		const manage = await screen.findByRole("link", {
			name: "Manage your keys",
		});
		expect(manage.getAttribute("href")).toBe(
			"/app/acme/settings/ai-providers?tab=personal",
		);
		expect(
			screen.queryByRole("link", { name: "Configure provider" }),
		).toBeNull();
	});

	it("also offers an admin the organization's own provider settings", async () => {
		orgContextMock.mockReturnValue({
			organizationId: "org-1",
			isOrgContext: true,
			isOrganizationAdmin: true,
		});

		renderNotice();

		const configure = await screen.findByRole("link", {
			name: "Configure provider",
		});
		expect(configure.getAttribute("href")).toBe(
			"/app/acme/settings/ai-providers",
		);
		expect(
			screen.getByRole("link", { name: "Manage your keys" }),
		).toBeDefined();
	});

	it("collapses when dismissed and stays collapsed for this organization", async () => {
		const { unmount } = renderNotice();

		fireEvent.click(
			await screen.findByRole("button", {
				name: "Dismiss personal key notice",
			}),
		);
		expect(screen.queryByText(TITLE)).toBeNull();
		expect(
			screen.getByRole("button", { name: "Show personal key notice" }),
		).toBeDefined();

		unmount();
		renderNotice();
		expect(
			await screen.findByRole("button", {
				name: "Show personal key notice",
			}),
		).toBeDefined();
		expect(screen.queryByText(TITLE)).toBeNull();
	});
});

describe("PersonalKeyNotice — when it stays silent", () => {
	it("says nothing when the organization's own key serves the work", async () => {
		getStatusMock.mockResolvedValue(
			status({ resolvedProviderSource: "organization" }),
		);

		renderNotice();
		await waitFor(() => expect(getStatusMock).toHaveBeenCalled());
		await settle();

		expect(screen.queryByText(TITLE)).toBeNull();
	});

	it.each([
		["the member's own ChatGPT plan", ownPlanMock],
		["a ChatGPT plan the organization shares", sharedPlanMock],
	])("says nothing while %s serves their own work", async (_name, plan) => {
		plan.mockReturnValue(true);

		renderNotice();
		await waitFor(() => expect(getStatusMock).toHaveBeenCalled());
		await settle();

		expect(screen.queryByText(TITLE)).toBeNull();
	});

	it("says nothing to a guest, and asks nothing about the host", async () => {
		guestMock.mockReturnValue(true);

		renderNotice();
		await settle();

		expect(getStatusMock).not.toHaveBeenCalled();
		expect(screen.queryByText(TITLE)).toBeNull();
	});

	it("says nothing, and asks nothing, before the organization resolves", async () => {
		tenantScopeMock.mockReturnValue(false);

		renderNotice();
		await settle();

		expect(getStatusMock).not.toHaveBeenCalled();
		expect(screen.queryByText(TITLE)).toBeNull();
	});

	it("says nothing while the status is loading", async () => {
		getStatusMock.mockReturnValue(new Promise(() => {}));

		renderNotice();
		await settle();

		expect(getStatusMock).toHaveBeenCalled();
		expect(screen.queryByText(TITLE)).toBeNull();
	});

	it("says nothing until the ChatGPT plan status is in for this organization", async () => {
		planStatusKnownMock.mockReturnValue(false);

		renderNotice();
		await waitFor(() => expect(getStatusMock).toHaveBeenCalled());
		await settle();

		expect(screen.queryByText(TITLE)).toBeNull();
	});

	it("says nothing outside an organization", async () => {
		orgContextMock.mockReturnValue({
			organizationId: null,
			isOrgContext: false,
			isOrganizationAdmin: false,
		});

		renderNotice();
		await settle();

		expect(screen.queryByText(TITLE)).toBeNull();
	});

	it("says nothing when a failed status call leaves no answer", async () => {
		getStatusMock.mockRejectedValue(new Error("network"));

		renderNotice();
		await waitFor(() => expect(getStatusMock).toHaveBeenCalled());
		await settle();

		expect(screen.queryByText(TITLE)).toBeNull();
	});
});

describe("PersonalKeyNotice — never beside 'AI provider required'", () => {
	it.each([
		[
			"nothing resolves",
			status({
				canResolveProvider: false,
				resolvedProvider: null,
				resolvedProviderSource: null,
			}),
			"AI provider required",
		],
		["the caller's own key resolves", status(), TITLE],
	])(
		"when %s, exactly one of the two speaks",
		async (_state, payload, shown) => {
			getStatusMock.mockResolvedValue(payload);

			renderNotice(
				<>
					<AiGatewayWarningBanner />
					<PersonalKeyNotice />
				</>,
			);

			expect(await screen.findByText(shown)).toBeDefined();
			const other = shown === TITLE ? "AI provider required" : TITLE;
			expect(screen.queryByText(other)).toBeNull();
		},
	);
});
