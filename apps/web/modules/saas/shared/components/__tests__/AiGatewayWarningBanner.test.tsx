/**
 * Unit tests for `AiGatewayWarningBanner`.
 *
 * The notice moved out of the two dashboards and into the app chrome, so it
 * now renders on every page inside an organization (Fizzy #1875, R5). Three of
 * the behaviours below are regressions that move would otherwise INTRODUCE
 * rather than behaviours it preserves, which is why they are asserted first:
 *
 * - A project guest holds no organization membership, so the org-scoped status
 *   call 403s for them. The removed credits banner was handed an explicit null
 *   by the layout; this component takes no props, so an unguarded version would
 *   pin a permanent notice to every page a guest loads, behind a control that
 *   redirects them away (AE6).
 * - Reading provider config is a viewer right, editing it is admin-only. An
 *   unguarded version hands every member a control leading to a form they may
 *   only read (AE7). Each role now gets the one control it can act on: an
 *   admin the organization's provider page, a member their own.
 * - Dismissal used to reset for free because the dashboard unmounted. A chrome
 *   mount survives navigation, so it has to reset explicitly (R14).
 *
 * It also pins the predicate: the notice reads `canResolveProvider`, which
 * mirrors what the resolver does, NOT `isConfigured`, which does not (R11).
 *
 * Run with:
 *   pnpm --filter web test modules/saas/shared/components/__tests__/AiGatewayWarningBanner.test.tsx
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	AiGatewayWarningBanner,
	aiConfigStatusQueryKey,
} from "../AiGatewayWarningBanner";

const orgContextMock = vi.fn();
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => orgContextMock(),
	useContextPath: (path: string) => {
		const { organizationSlug } = orgContextMock();
		return organizationSlug
			? `/app/${organizationSlug}/${path}`
			: `/app/${path}`;
	},
}));

const guestMock = vi.fn();
vi.mock("@saas/organizations/hooks/use-is-guest-in-org", () => ({
	useIsGuestInOrg: () => guestMock(),
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

const pathnameMock = vi.fn();
vi.mock("next/navigation", () => ({
	usePathname: () => pathnameMock(),
}));

vi.mock("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));

const ORG_ID = "org-1";

function makeClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
}

function renderBanner(queryClient = makeClient()) {
	const utils = render(
		<QueryClientProvider client={queryClient}>
			<AiGatewayWarningBanner />
		</QueryClientProvider>,
	);
	return { ...utils, queryClient };
}

/** The status shape the procedure returns, narrowed to what this notice reads. */
function status({
	canResolveProvider,
	isConfigured = canResolveProvider,
}: {
	canResolveProvider: boolean;
	isConfigured?: boolean;
}) {
	return { canResolveProvider, isConfigured };
}

beforeEach(() => {
	vi.clearAllMocks();
	orgContextMock.mockReturnValue({
		organizationId: ORG_ID,
		organizationSlug: "acme",
		isOrgContext: true,
		isOrganizationAdmin: true,
	});
	guestMock.mockReturnValue(false);
	pathnameMock.mockReturnValue("/app/acme/projects");
	getStatusMock.mockResolvedValue(status({ canResolveProvider: false }));
});

describe("AiGatewayWarningBanner — a guest (AE6)", () => {
	it("makes no organization-scoped status request and renders nothing", async () => {
		guestMock.mockReturnValue(true);

		renderBanner();

		// Give the query a chance to fire before asserting it did not.
		await waitFor(() => expect(guestMock).toHaveBeenCalled());
		expect(getStatusMock).not.toHaveBeenCalled();
		expect(screen.queryByText("AI provider required")).toBeNull();
	});

	it("offers a guest no settings control, even once the query would have settled", async () => {
		guestMock.mockReturnValue(true);

		renderBanner();

		await waitFor(() => expect(getStatusMock).not.toHaveBeenCalled());
		expect(screen.queryByRole("link")).toBeNull();
	});
});

describe("AiGatewayWarningBanner — role (AE7)", () => {
	it("a member who cannot edit is told what they can do, with no control to a read-only form", async () => {
		orgContextMock.mockReturnValue({
			organizationId: ORG_ID,
			organizationSlug: "acme",
			isOrgContext: true,
			isOrganizationAdmin: false,
		});

		renderBanner();

		const description = await screen.findByText(
			/no AI provider configured/i,
		);
		// Names both remedies they can act on: an admin, or their own key.
		expect(description.textContent).toContain(
			"An organization admin can add one",
		);
		expect(description.textContent).toContain("add a personal key");
		expect(
			screen.queryByRole("link", { name: /configure provider/i }),
		).toBeNull();
	});

	it("sends that member to their OWN provider page, the one remedy they can carry out alone", async () => {
		// The other half of the assertion above. The control was deliberately
		// absent while the personal provider page did not exist — the copy
		// offered a remedy with nowhere to go. Now it has a destination, and
		// it must be the ACCOUNT page: the organization's own page renders
		// read-only for this member, which is why they never get sent there.
		orgContextMock.mockReturnValue({
			organizationId: ORG_ID,
			organizationSlug: "acme",
			isOrgContext: true,
			isOrganizationAdmin: false,
		});

		renderBanner();

		const link = await screen.findByRole("link", {
			name: /add your own key/i,
		});
		expect(link).toHaveAttribute(
			"href",
			"/app/acme/settings/account/ai-providers",
		);
	});

	it("an admin in the same organization gets the control", async () => {
		renderBanner();

		const link = await screen.findByRole("link", {
			name: /configure provider/i,
		});
		expect(link).toHaveAttribute("href", "/app/acme/settings/ai-providers");
		// One control per role, not two. An admin fixing this for the whole
		// organization should not be nudged toward a key of their own.
		expect(
			screen.queryByRole("link", { name: /add your own key/i }),
		).toBeNull();
	});
});

describe("AiGatewayWarningBanner — what it says", () => {
	it("names the remedy and does not claim background work has stopped", async () => {
		renderBanner();

		const description = await screen.findByText(
			/Add an OpenAI, Anthropic, Vercel AI Gateway, OpenRouter, or compatible provider key/,
		);
		expect(description.textContent).toContain(
			"to use chat, agents, and document generation.",
		);
		// Indexing, embedding and tool ingestion keep their own resolution
		// (R13), so the copy must not sweep workflows in with the outage.
		expect(document.body.textContent).not.toMatch(/workflow/i);
	});

	it("renders on a page that is not the dashboard", async () => {
		pathnameMock.mockReturnValue("/app/acme/projects/p-1/documents");

		renderBanner();

		expect(
			await screen.findByText("AI provider required"),
		).toBeInTheDocument();
	});
});

describe("AiGatewayWarningBanner — the predicate it reads (R11)", () => {
	it("AE3: a tenant that can resolve a provider sees nothing", async () => {
		getStatusMock.mockResolvedValue(status({ canResolveProvider: true }));

		renderBanner();

		await waitFor(() => expect(getStatusMock).toHaveBeenCalled());
		expect(screen.queryByText("AI provider required")).toBeNull();
	});

	it("an enabled row carrying no credential is configured but not resolvable — the notice shows", async () => {
		getStatusMock.mockResolvedValue(
			status({ isConfigured: true, canResolveProvider: false }),
		);

		renderBanner();

		expect(
			await screen.findByText("AI provider required"),
		).toBeInTheDocument();
	});

	it("a member's personal key inside an organization with none is resolvable — the notice stays away", async () => {
		getStatusMock.mockResolvedValue(
			status({ isConfigured: false, canResolveProvider: true }),
		);

		renderBanner();

		await waitFor(() => expect(getStatusMock).toHaveBeenCalled());
		expect(screen.queryByText("AI provider required")).toBeNull();
	});

	it("passes the organization id explicitly rather than letting the session decide", async () => {
		renderBanner();

		await waitFor(() =>
			expect(getStatusMock).toHaveBeenCalledWith({
				organizationId: ORG_ID,
			}),
		);
	});

	it("says nothing while the status is unknown — a failed call is not an outage", async () => {
		getStatusMock.mockRejectedValue(new Error("boom"));

		renderBanner();

		await waitFor(() => expect(getStatusMock).toHaveBeenCalled());
		expect(screen.queryByText("AI provider required")).toBeNull();
	});
});

describe("AiGatewayWarningBanner — clearing and dismissing", () => {
	it("configuring a provider clears the notice without a reload", async () => {
		const { queryClient } = renderBanner();
		expect(
			await screen.findByText("AI provider required"),
		).toBeInTheDocument();

		// What the provider settings forms do after a successful save. The key
		// comes from the helper the component registers with, so a rename
		// cannot silently break the refresh.
		getStatusMock.mockResolvedValue(status({ canResolveProvider: true }));
		await queryClient.invalidateQueries({
			queryKey: aiConfigStatusQueryKey(ORG_ID),
		});

		await waitFor(() =>
			expect(screen.queryByText("AI provider required")).toBeNull(),
		);
	});

	it("dismissal silences the page it was dismissed on, and only that page (R14)", async () => {
		const queryClient = makeClient();
		const { rerender } = renderBanner(queryClient);

		expect(
			await screen.findByText("AI provider required"),
		).toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", { name: "Dismiss AI setup reminder" }),
		);
		expect(screen.queryByText("AI provider required")).toBeNull();

		// Navigation, as the chrome sees it: the component never unmounts, only
		// the path changes.
		pathnameMock.mockReturnValue("/app/acme/settings/general");
		rerender(
			<QueryClientProvider client={queryClient}>
				<AiGatewayWarningBanner />
			</QueryClientProvider>,
		);

		expect(
			await screen.findByText("AI provider required"),
		).toBeInTheDocument();
	});
});
