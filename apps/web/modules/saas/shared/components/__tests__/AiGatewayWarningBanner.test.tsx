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
 * And it pins the copy itself. The admin-facing line used to name Anthropic
 * among the keys that enable document generation, which Anthropic cannot do —
 * it serves no embedding models, and document search needs them. The
 * assertions below are written against literals rather than against a constant
 * imported from the component, so a copy edit that reintroduces the claim
 * fails here instead of agreeing with itself.
 *
 * Run with:
 *   pnpm --filter web test modules/saas/shared/components/__tests__/AiGatewayWarningBanner.test.tsx
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
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
/**
 * The route's own params.
 *
 * `organizationSlug` is the URL's claim about which tenant the reader is
 * standing in, and it is the half `useOrganizationContext` cannot supply: its
 * `organizationId` is null both on a route that names no organization and on
 * one whose lookup has not landed — or has failed outright.
 */
const paramsMock = vi.fn();
vi.mock("next/navigation", () => ({
	usePathname: () => pathnameMock(),
	useParams: () => paramsMock(),
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

/**
 * Let every queued effect, microtask and macrotask run.
 *
 * Needed for the negative assertion in the resolving-window block below.
 * `waitFor(() => expect(mock).not.toHaveBeenCalled())` is not a wait at all:
 * its callback passes on the first tick, so it cannot tell "never fires" from
 * "fires one microtask later". Same helper, and the same reasoning, as the
 * sibling `AnthropicCapabilityBanner` suite — the point of the block below is
 * that the two banners now behave identically at this gate.
 */
async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	// `isResolvingOrganization` belongs in every fixture in this file because
	// the component now reads it: omitting it would leave it `undefined`, which
	// is falsy, and the cold-load guard would look tested when nothing had
	// exercised it.
	orgContextMock.mockReturnValue({
		organizationId: ORG_ID,
		organizationSlug: "acme",
		isOrgContext: true,
		isOrganizationAdmin: true,
		isResolvingOrganization: false,
	});
	guestMock.mockReturnValue(false);
	pathnameMock.mockReturnValue("/app/acme/projects");
	// Every fixture in this file stands on a route whose organization has
	// resolved, so the tenant gate is open by default — nothing that passes
	// today starts passing because the banner fell silent.
	paramsMock.mockReturnValue({ organizationSlug: "acme" });
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

describe("AiGatewayWarningBanner — the organization-resolving window", () => {
	/** The context this banner sees while the URL's organization is in flight. */
	function resolvingOrgContext() {
		return {
			organizationId: null,
			organizationSlug: null,
			isOrgContext: false,
			isOrganizationAdmin: false,
			isResolvingOrganization: true,
		};
	}

	it("asks nothing and says nothing while the URL's organization is still resolving", async () => {
		// `organizationId` is null in that window without meaning there is no
		// organization. This call is tenant-scoped, so asking now asks about the
		// caller's PERSONAL setup and caches the answer under a key the banner
		// stops reading the moment the real organization lands. The sibling
		// capability banner has carried this gate all along; this is the line the
		// two had drifted apart on.
		orgContextMock.mockReturnValue(resolvingOrgContext());

		renderBanner();

		await settle();
		expect(getStatusMock).not.toHaveBeenCalled();
		expect(screen.queryByText("AI provider required")).toBeNull();
	});

	it("asks as normal once the organization lands, under the same mount", async () => {
		// The control for the negative above: the same flush, with the gate open,
		// DOES fire the request — so "never fires" is the guard speaking and not
		// a flush that is simply too short. It also models what actually happens,
		// since the organization fetch resolves under a chrome that never
		// unmounted and only re-rendered.
		const queryClient = makeClient();
		orgContextMock.mockReturnValue(resolvingOrgContext());
		const { rerender } = renderBanner(queryClient);

		await settle();
		expect(getStatusMock).not.toHaveBeenCalled();

		orgContextMock.mockReturnValue({
			organizationId: ORG_ID,
			organizationSlug: "acme",
			isOrgContext: true,
			isOrganizationAdmin: true,
			isResolvingOrganization: false,
		});
		rerender(
			<QueryClientProvider client={queryClient}>
				<AiGatewayWarningBanner />
			</QueryClientProvider>,
		);

		await waitFor(() =>
			expect(getStatusMock).toHaveBeenCalledWith({
				organizationId: ORG_ID,
			}),
		);
		expect(
			await screen.findByText("AI provider required"),
		).toBeInTheDocument();
	});
});

describe("AiGatewayWarningBanner — the route names an organization the context never resolved", () => {
	/**
	 * The context a FAILED organization lookup leaves behind: no id, and no
	 * loading flag raised, because that query does not retry.
	 *
	 * Byte for byte the context of someone standing outside any organization —
	 * which is the whole difficulty. Only the ROUTE separates the two, so every
	 * test below sets the params deliberately rather than inheriting them.
	 */
	function nullTenantContext() {
		return {
			organizationId: null,
			organizationSlug: null,
			isOrgContext: false,
			isOrganizationAdmin: false,
			isResolvingOrganization: false,
		};
	}

	it("asks nothing and shows nothing when the route names an organization that failed to resolve", async () => {
		// Not the loading window above: the lookup is over and lost, and the
		// flag that window is recognised by is already back down. Asking here
		// sends `organizationId: null`, which the status procedure answers from
		// its PERSONAL arm — so this reader's own configuration would be
		// reported to them as the organization's.
		paramsMock.mockReturnValue({ organizationSlug: "acme" });
		orgContextMock.mockReturnValue(nullTenantContext());

		renderBanner();

		await settle();
		expect(getStatusMock).not.toHaveBeenCalled();
		expect(screen.queryByText("AI provider required")).toBeNull();
	});

	it("asks as normal once the slug resolves to an organization", async () => {
		// The control for the negative above: the same route, with the id in
		// place. Wait for both observable stages rather than assuming one timer
		// tick also covers React Query's notification and React's re-render.
		paramsMock.mockReturnValue({ organizationSlug: "acme" });

		renderBanner();

		await waitFor(() =>
			expect(getStatusMock).toHaveBeenCalledWith({
				organizationId: ORG_ID,
			}),
		);
		expect(
			await screen.findByText("AI provider required"),
		).toBeInTheDocument();
	});

	it("does not consume a personal status already cached under the null key", async () => {
		// The sharp half of this. Both banners key on
		// `["aiConfigStatus", organizationId]`, so one early ask — from either of
		// them — leaves the caller's PERSONAL answer sitting under the null key,
		// and every later render on the organization route reads it straight out
		// of the cache. That makes the disclosure immediate and lasting rather
		// than a flicker, and waiting for a request cannot expose it, because
		// there is no request left to make.
		const queryClient = makeClient();
		queryClient.setQueryData(
			aiConfigStatusQueryKey(null),
			status({ canResolveProvider: false }),
		);
		// Nothing may arrive over the network either, so the cache is the only
		// thing that could put this notice on screen.
		getStatusMock.mockReturnValue(new Promise(() => {}));
		paramsMock.mockReturnValue({ organizationSlug: "acme" });
		orgContextMock.mockReturnValue(nullTenantContext());

		renderBanner(queryClient);

		await settle();
		expect(getStatusMock).not.toHaveBeenCalled();
		expect(screen.queryByText("AI provider required")).toBeNull();

		// The control: that cached answer is live, and it does render — on the
		// personal route it actually describes. Without this the assertion above
		// could be satisfied by a seed that never landed on the key this banner
		// reads, and would then hold however the gate behaved.
		cleanup();
		queryClient.setQueryData(
			aiConfigStatusQueryKey(null),
			status({ canResolveProvider: false }),
		);
		pathnameMock.mockReturnValue("/app/projects");
		paramsMock.mockReturnValue({});
		renderBanner(queryClient);

		expect(screen.getByText("AI provider required")).toBeInTheDocument();
	});

	it("still asks outside any organization, where a null tenant is the real answer", async () => {
		// The gate is about the route and the context disagreeing, not about a
		// null id. On a route that names no organization, null IS the tenant, and
		// a guard tightened into "never ask with a null id" would silence this
		// notice for everyone outside an organization — with nothing else here to
		// catch it.
		pathnameMock.mockReturnValue("/app/projects");
		paramsMock.mockReturnValue({});
		orgContextMock.mockReturnValue(nullTenantContext());

		renderBanner();

		await waitFor(() =>
			expect(getStatusMock).toHaveBeenCalledWith({
				organizationId: null,
			}),
		);
		expect(
			await screen.findByText("AI provider required"),
		).toBeInTheDocument();
	});
});

describe("AiGatewayWarningBanner — role (AE7)", () => {
	it("a member who cannot edit is told what they can do, with no control to a read-only form", async () => {
		orgContextMock.mockReturnValue({
			organizationId: ORG_ID,
			organizationSlug: "acme",
			isOrgContext: true,
			isOrganizationAdmin: false,
			isResolvingOrganization: false,
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
			isResolvingOrganization: false,
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
	/** The admin-facing description, as rendered. */
	async function adminDescription() {
		renderBanner();
		const description = await screen.findByText(
			/Add an OpenAI, Vercel AI Gateway, OpenRouter, or compatible provider key/,
		);
		return description.textContent ?? "";
	}

	/**
	 * Where the enabling list ends, named rather than counted.
	 *
	 * The three assertions below examine only the first sentence — the keys the
	 * reader is told will buy them the named capabilities. What follows it is
	 * the caveat, not part of the list.
	 */
	const ENABLING_LIST_END = "to use chat, agents, and document generation.";

	/**
	 * The first sentence, sliced at that named boundary.
	 *
	 * Deliberately not `description.split(". ")[0]`. A positional split
	 * silently redefines what these assertions examine the moment the copy
	 * gains an abbreviation or another sentence: a reworded caveat could move
	 * "Anthropic" into fragment zero, or an "e.g." could cut the list in half,
	 * and every assertion would go on passing while inspecting the wrong text.
	 * Missing the boundary throws instead, so a copy change that moves it is a
	 * failure to look at rather than a silent change of subject.
	 */
	function enablingList(description: string) {
		const end = description.indexOf(ENABLING_LIST_END);
		if (end === -1) {
			throw new Error(
				`The admin copy no longer ends its enabling list with "${ENABLING_LIST_END}" — re-anchor this helper before trusting the assertions below. Got: ${description}`,
			);
		}
		return description.slice(0, end + ENABLING_LIST_END.length);
	}

	it("names the remedy and does not claim background work has stopped", async () => {
		const description = await adminDescription();

		expect(description).toContain(
			"to use chat, agents, and document generation.",
		);
		// Indexing, embedding and tool ingestion keep their own resolution
		// (R13), so the copy must not sweep workflows in with the outage.
		expect(document.body.textContent).not.toMatch(/workflow/i);
	});

	it("does not offer Anthropic as a key that enables document generation", async () => {
		const description = await adminDescription();

		// Anthropic serves no embedding models, and document search needs
		// them, so a reader acting on the enabling list alone must not come
		// away with an Anthropic key.
		expect(enablingList(description)).not.toMatch(/Anthropic/);
	});

	it("still names a provider that does, so the remedy stays actionable", async () => {
		const description = await adminDescription();

		// Removing the false claim must not leave the reader with nothing to
		// buy. OpenAI serves both halves; the gateways reach a provider that
		// does.
		expect(enablingList(description)).toContain("OpenAI");
		expect(enablingList(description)).toMatch(
			/Vercel AI Gateway|OpenRouter/,
		);
	});

	it("names the embedding gap rather than leaving Anthropic unmentioned", async () => {
		const description = await adminDescription();

		// Silence would be accurate but unhelpful: a reader who already holds
		// an Anthropic key needs to know why it is not on the list.
		expect(description).toContain(
			"Anthropic covers chat and agents, but not the embeddings document search needs.",
		);
	});

	it("leaves the non-admin copy exactly as it was — a different situation", async () => {
		// The member-facing line describes the zero-provider state and claims
		// no capability of any named provider, so the correction above does
		// not reach it.
		orgContextMock.mockReturnValue({
			organizationId: ORG_ID,
			organizationSlug: "acme",
			isOrgContext: true,
			isOrganizationAdmin: false,
			isResolvingOrganization: false,
		});

		renderBanner();

		const description = await screen.findByText(
			/no AI provider configured/i,
		);
		expect(description.textContent).toBe(
			"This organization has no AI provider configured, so chat, agents, and document generation are unavailable here. An organization admin can add one — or add a personal key to use these features yourself.",
		);
		expect(description.textContent).not.toMatch(/Anthropic/);
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
