/**
 * Unit tests for `AnthropicCapabilityBanner`.
 *
 * The banner tells someone whose embedding path resolves to Anthropic that a
 * whole capability class is missing behind it (Fizzy #2289, R6-R10, R15-R18).
 * It sits in the app chrome beside the AI-setup reminder and borrows that
 * component's shape, so it inherits the same three ways of going wrong — and
 * the first three tests below are written against them deliberately, because
 * each passes in the WRONG direction if it is only asserted after the fact:
 *
 * - A project guest holds no organization membership, so the org-scoped status
 *   call 403s for them. A component that renders nothing for other reasons
 *   still looks correct here; only asserting that the request never fires
 *   catches an unguarded query (R15).
 * - The AI-setup reminder outranks this banner. When nothing AI-shaped resolves
 *   at all, "you have no usable provider" is the more urgent truth, and two
 *   notices stacked in one column say half a remedy twice (R17).
 * - The two AI Providers settings pages already carry the same sentence on the
 *   Anthropic card, next to the embedding prompt that fixes it (R18).
 *
 * The copy is asserted against literals typed out here rather than against the
 * constants the component imports, so a reword that drifts from the
 * product-approved wording fails here instead of agreeing with itself.
 *
 * Run with:
 *   pnpm --filter web test modules/saas/shared/components/__tests__/AnthropicCapabilityBanner.test.tsx
 */
import { ANTHROPIC_PROVIDER_ID } from "@saas/settings/lib/ai-providers";
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
import { aiConfigStatusQueryKey } from "../AiGatewayWarningBanner";
import { AnthropicCapabilityBanner } from "../AnthropicCapabilityBanner";

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
const OTHER_ORG_ID = "org-2";

/**
 * The three sentences, typed out rather than imported. See the file header:
 * these are the product-approved strings, and a test that imported them would
 * pass whatever they became.
 */
const TITLE = "Some capabilities are unavailable with Anthropic";
const BODY =
	"Anthropic does not support embeddings, image generation, or audio. To use these features, configure an additional provider that supports them.";
const DETAIL =
	"Chat and agents keep working. Document search, retrieval, and the context step in document generation do not.";
/** What a reader who cannot fix it themselves is told instead of a control. */
const ADMIN_REMEDY =
	"An organization admin needs to assign an embedding provider for this organization.";

function makeClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
}

function renderBanner(queryClient = makeClient()) {
	const utils = render(
		<QueryClientProvider client={queryClient}>
			<AnthropicCapabilityBanner />
		</QueryClientProvider>,
	);
	return { ...utils, queryClient };
}

/**
 * The organization context, defaulting to an admin inside a resolved
 * organization. `isResolvingOrganization` belongs to every fixture because the
 * component reads it: omitting it would make it `undefined`, which is falsy,
 * and the cold-load guard would look tested when nothing had exercised it.
 */
function orgContext(
	overrides: {
		organizationId?: string | null;
		organizationSlug?: string | null;
		isOrgContext?: boolean;
		isOrganizationAdmin?: boolean;
		isResolvingOrganization?: boolean;
	} = {},
) {
	return {
		organizationId: ORG_ID,
		organizationSlug: "acme",
		isOrgContext: true,
		isOrganizationAdmin: true,
		isResolvingOrganization: false,
		...overrides,
	};
}

/**
 * The status payload, narrowed to the two fields the rule reads. Defaults to
 * the state the banner exists for: a caller who can resolve a provider, whose
 * embedding path lands on one that serves no embeddings.
 *
 * The provider id comes from the typed provider metadata rather than a literal
 * — unlike the copy above, it is an identifier, and a hand-typed one would
 * typecheck, never match, and let every assertion below pass vacuously.
 */
function status({
	canResolveProvider = true,
	resolvedEmbeddingProvider = ANTHROPIC_PROVIDER_ID,
	// Spelled out in every fixture rather than defaulted away. Omitting it would
	// leave it `undefined`, which is falsy, and the source-branched remedy below
	// would look tested while nothing had exercised it.
	resolvedEmbeddingSource = "organization",
}: {
	canResolveProvider?: boolean;
	resolvedEmbeddingProvider?: string | null;
	resolvedEmbeddingSource?: "organization" | "user" | null;
} = {}) {
	return {
		canResolveProvider,
		resolvedEmbeddingProvider,
		resolvedEmbeddingSource,
	};
}

/** A promise that never settles — the query's loading window, held open. */
function pending() {
	return new Promise(() => {});
}

/**
 * Let every queued effect, microtask and macrotask run.
 *
 * Needed for the negative assertions. `waitFor(() => expect(mock).not
 * .toHaveBeenCalled())` is not a wait at all: its callback passes on the first
 * tick, so it cannot tell "never fires" from "fires one microtask later". A
 * claim that a request was never made has to be made after the render settled,
 * and the guest test below proves this flush is long enough by showing the same
 * one DOES catch the call for a non-guest.
 */
async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	orgContextMock.mockReturnValue(orgContext());
	guestMock.mockReturnValue(false);
	pathnameMock.mockReturnValue("/app/acme/projects");
	// Every fixture in this file stands on a route whose organization has
	// resolved, so the tenant gate is open by default — nothing that passes
	// today starts passing because the banner fell silent.
	paramsMock.mockReturnValue({ organizationSlug: "acme" });
	getStatusMock.mockResolvedValue(status());
});

describe("AnthropicCapabilityBanner — a guest (R15/AE7)", () => {
	it("makes no organization-scoped status request and renders nothing", async () => {
		guestMock.mockReturnValue(true);

		renderBanner();

		await settle();
		expect(getStatusMock).not.toHaveBeenCalled();
		expect(screen.queryByText(TITLE)).toBeNull();
	});

	it("offers a guest no settings control, even once the query would have settled", async () => {
		guestMock.mockReturnValue(true);

		renderBanner();

		await settle();
		expect(getStatusMock).not.toHaveBeenCalled();
		expect(screen.queryByRole("link")).toBeNull();

		// The control for the assertion above: the same flush, for a
		// non-guest, does fire the request. Without this the negative could be
		// satisfied by a flush that is simply too short, and the guard it
		// claims to test could be gone.
		cleanup();
		guestMock.mockReturnValue(false);
		renderBanner();
		await settle();
		expect(getStatusMock).toHaveBeenCalled();
	});
});

describe("AnthropicCapabilityBanner — the reminder outranks it (R17/AE6)", () => {
	it("says nothing while no provider resolves at all", async () => {
		// The AI-setup reminder is on screen saying nothing AI-shaped works.
		// Which capabilities a provider lacks is not the reader's problem yet.
		getStatusMock.mockResolvedValue(status({ canResolveProvider: false }));

		renderBanner();

		await waitFor(() => expect(getStatusMock).toHaveBeenCalled());
		expect(screen.queryByText(TITLE)).toBeNull();
	});
});

describe("AnthropicCapabilityBanner — the settings pages (R18/AE11)", () => {
	it("says nothing on the organization's AI Providers page", async () => {
		pathnameMock.mockReturnValue("/app/acme/settings/ai-providers");

		renderBanner();

		await waitFor(() => expect(getStatusMock).toHaveBeenCalled());
		// The Anthropic card on that page carries this sentence already, right
		// beside the embedding prompt that resolves it.
		expect(screen.queryByText(TITLE)).toBeNull();
	});

	it("says nothing on the account's AI Providers page", async () => {
		pathnameMock.mockReturnValue("/app/acme/settings/account/ai-providers");

		renderBanner();

		await waitFor(() => expect(getStatusMock).toHaveBeenCalled());
		expect(screen.queryByText(TITLE)).toBeNull();
	});

	it("still speaks on the AI Models page, which is where the gap is felt", async () => {
		// Suppression is for the two pages that already carry this sentence,
		// and nothing else under /settings. The AI Models page is the one whose
		// "No models available" emptiness this notice exists to explain, so a
		// suffix check loose enough to swallow it would silence the banner
		// exactly where the reader is asking the question.
		pathnameMock.mockReturnValue("/app/acme/settings/ai-models");

		renderBanner();

		expect(await screen.findByText(TITLE)).toBeInTheDocument();
	});
});

describe("AnthropicCapabilityBanner — what it says (R7, R8/AE1)", () => {
	it("renders the approved title and both sentences", async () => {
		renderBanner();

		expect(await screen.findByText(TITLE)).toBeInTheDocument();
		expect(screen.getByText(BODY)).toBeInTheDocument();
		// The second sentence is the banner's alone: someone reading the card
		// is choosing a provider, someone reading this is already working.
		expect(screen.getByText(DETAIL)).toBeInTheDocument();
	});

	it("passes the organization id explicitly rather than letting the session decide", async () => {
		renderBanner();

		await waitFor(() =>
			expect(getStatusMock).toHaveBeenCalledWith({
				organizationId: ORG_ID,
			}),
		);
	});
});

describe("AnthropicCapabilityBanner — the condition it reads (R6/AE3)", () => {
	it("says nothing once the embedding path resolves to a provider that can embed", async () => {
		// The remedy the copy asks for has been carried out: embeddings now
		// resolve somewhere that serves them.
		getStatusMock.mockResolvedValue(
			status({ resolvedEmbeddingProvider: "OPENAI_DIRECT" }),
		);

		renderBanner();

		await waitFor(() => expect(getStatusMock).toHaveBeenCalled());
		expect(screen.queryByText(TITLE)).toBeNull();
	});

	it("says nothing when the embedding path resolves to nothing at all", async () => {
		// A different failure with a different remedy, owned by the AI-setup
		// reminder. Blaming Anthropic for it would name a vendor the tenant may
		// never have configured.
		getStatusMock.mockResolvedValue(
			status({ resolvedEmbeddingProvider: null }),
		);

		renderBanner();

		await waitFor(() => expect(getStatusMock).toHaveBeenCalled());
		expect(screen.queryByText(TITLE)).toBeNull();
	});
});

describe("AnthropicCapabilityBanner — clearing and returning (R9/AE2, AE10)", () => {
	it("disappears when an embedding provider is assigned, with no reload", async () => {
		const { queryClient } = renderBanner();
		expect(await screen.findByText(TITLE)).toBeInTheDocument();

		// What the provider settings forms do after a successful save. The key
		// comes from the helper the component registers with, so a rename
		// cannot silently break the refresh.
		getStatusMock.mockResolvedValue(
			status({ resolvedEmbeddingProvider: "OPENAI_DIRECT" }),
		);
		await queryClient.invalidateQueries({
			queryKey: aiConfigStatusQueryKey(ORG_ID),
		});

		await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
	});

	it("reappears when the embedding provider is unassigned again", async () => {
		const { queryClient } = renderBanner();
		expect(await screen.findByText(TITLE)).toBeInTheDocument();

		getStatusMock.mockResolvedValue(
			status({ resolvedEmbeddingProvider: "OPENAI_DIRECT" }),
		);
		await queryClient.invalidateQueries({
			queryKey: aiConfigStatusQueryKey(ORG_ID),
		});
		await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());

		// The gap is back, so the notice is owed again — a banner that only
		// ever cleared would be silent for the rest of the session.
		getStatusMock.mockResolvedValue(status());
		await queryClient.invalidateQueries({
			queryKey: aiConfigStatusQueryKey(ORG_ID),
		});

		expect(await screen.findByText(TITLE)).toBeInTheDocument();
	});
});

describe("AnthropicCapabilityBanner — role (R16/AE8)", () => {
	it("gives a member who cannot edit no control, and names who can act", async () => {
		// The remedy does not transfer down the way the sibling reminder's
		// does. `getEmbeddingProviderConfig` in organization context reads
		// `cloudProviderConfig` alone — a personal embedding provider is never
		// consulted — so sending a member to their own provider page would send
		// them to do something that changes nothing and leaves the banner up.
		orgContextMock.mockReturnValue(
			orgContext({ isOrganizationAdmin: false }),
		);

		renderBanner();

		expect(await screen.findByText(ADMIN_REMEDY)).toBeInTheDocument();
		// No control at all: not the organization's page, which renders
		// read-only for them, and above all not their own.
		expect(screen.queryByRole("link")).toBeNull();
		expect(
			document.querySelector(
				'a[href="/app/acme/settings/account/ai-providers"]',
			),
		).toBeNull();
	});

	it("sends an admin to the organization's provider settings", async () => {
		renderBanner();

		const link = await screen.findByRole("link", {
			name: /add an embedding provider/i,
		});
		expect(link).toHaveAttribute("href", "/app/acme/settings/ai-providers");
		// An admin can act, so they are not told to go and find someone who can.
		expect(screen.queryByText(ADMIN_REMEDY)).toBeNull();
	});

	it("treats a reader outside any organization as able to configure it", async () => {
		// Nobody sits above them, so the configuration is theirs and the
		// control is the organization-shaped one pointed at their own pages.
		// The route has to say so too: a slug with no id behind it is the
		// unresolved case, not this one.
		pathnameMock.mockReturnValue("/app/projects");
		paramsMock.mockReturnValue({});
		orgContextMock.mockReturnValue(
			orgContext({
				organizationId: null,
				organizationSlug: null,
				isOrgContext: false,
				isOrganizationAdmin: false,
			}),
		);

		renderBanner();

		const link = await screen.findByRole("link", {
			name: /add an embedding provider/i,
		});
		expect(link).toHaveAttribute("href", "/app/settings/ai-providers");
		expect(screen.queryByText(ADMIN_REMEDY)).toBeNull();
		await waitFor(() =>
			expect(getStatusMock).toHaveBeenCalledWith({
				organizationId: null,
			}),
		);
	});
});

describe("AnthropicCapabilityBanner — whose configuration resolved", () => {
	it("points a member at their OWN settings when their own default is what resolved", async () => {
		// Role says they can change nothing; the resolver says the row it
		// landed on is theirs. The second is what decides the remedy, because
		// an admin assigning one for the organization is a bigger change than
		// the one this reader can make alone.
		orgContextMock.mockReturnValue(
			orgContext({ isOrganizationAdmin: false }),
		);
		getStatusMock.mockResolvedValue(
			status({ resolvedEmbeddingSource: "user" }),
		);

		renderBanner();

		const link = await screen.findByRole("link", {
			name: /add an embedding provider/i,
		});
		expect(link).toHaveAttribute(
			"href",
			"/app/acme/settings/account/ai-providers",
		);
		expect(screen.queryByText(ADMIN_REMEDY)).toBeNull();
	});

	it("still sends a member to find an admin when the organization's row resolved", async () => {
		orgContextMock.mockReturnValue(
			orgContext({ isOrganizationAdmin: false }),
		);
		getStatusMock.mockResolvedValue(
			status({ resolvedEmbeddingSource: "organization" }),
		);

		renderBanner();

		expect(await screen.findByText(ADMIN_REMEDY)).toBeInTheDocument();
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("says nothing about whose it is when the resolver did not report an origin", async () => {
		// Null is "we could not tell", and a remedy naming the wrong owner is
		// worse than one naming nobody. The member keeps the conservative
		// answer.
		orgContextMock.mockReturnValue(
			orgContext({ isOrganizationAdmin: false }),
		);
		getStatusMock.mockResolvedValue(
			status({ resolvedEmbeddingSource: null }),
		);

		renderBanner();

		expect(await screen.findByText(ADMIN_REMEDY)).toBeInTheDocument();
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("does not redirect an admin to their own page when their own row resolved", async () => {
		// An admin can change the organization's configuration, which outranks
		// their personal row, so the organization-level remedy stays theirs.
		getStatusMock.mockResolvedValue(
			status({ resolvedEmbeddingSource: "user" }),
		);

		renderBanner();

		const link = await screen.findByRole("link", {
			name: /add an embedding provider/i,
		});
		expect(link).toHaveAttribute("href", "/app/acme/settings/ai-providers");
	});
});

describe("AnthropicCapabilityBanner — dismissal lasts the session (R10/AE12)", () => {
	it("stays hidden after the pathname changes", async () => {
		const queryClient = makeClient();
		const { rerender } = renderBanner(queryClient);

		expect(await screen.findByText(TITLE)).toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Dismiss Anthropic capability notice",
			}),
		);
		expect(screen.queryByText(TITLE)).toBeNull();

		// Navigation, as the chrome sees it: the component never unmounts, only
		// the path changes. Unlike the AI-setup reminder — which describes a
		// total outage and comes back on every page — this one describes a
		// partial and often deliberate state, so one dismissal settles it.
		pathnameMock.mockReturnValue("/app/acme/settings/general");
		rerender(
			<QueryClientProvider client={queryClient}>
				<AnthropicCapabilityBanner />
			</QueryClientProvider>,
		);

		await waitFor(() => expect(getStatusMock).toHaveBeenCalled());
		expect(screen.queryByText(TITLE)).toBeNull();
	});

	it("returns for the next organization after the workspace is switched", async () => {
		const queryClient = makeClient();
		const { rerender } = renderBanner(queryClient);

		expect(await screen.findByText(TITLE)).toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Dismiss Anthropic capability notice",
			}),
		);
		expect(screen.queryByText(TITLE)).toBeNull();

		// The switcher navigates without unmounting the chrome, so a dismissal
		// held as a bare boolean followed the reader into the next tenant and
		// hid a gap they had never been told about — one they may not even be
		// able to fix. The dismissal is the reader's answer about ONE
		// workspace.
		orgContextMock.mockReturnValue(
			orgContext({
				organizationId: OTHER_ORG_ID,
				organizationSlug: "globex",
			}),
		);
		rerender(
			<QueryClientProvider client={queryClient}>
				<AnthropicCapabilityBanner />
			</QueryClientProvider>,
		);

		expect(await screen.findByText(TITLE)).toBeInTheDocument();
		await waitFor(() =>
			expect(getStatusMock).toHaveBeenCalledWith({
				organizationId: OTHER_ORG_ID,
			}),
		);
	});

	it("remembers every organization it was dismissed in, not only the latest", async () => {
		const queryClient = makeClient();
		const { rerender } = renderBanner(queryClient);

		/** The switcher, as the chrome sees it: a re-render, never an unmount. */
		function switchTo(organizationId: string, organizationSlug: string) {
			orgContextMock.mockReturnValue(
				orgContext({ organizationId, organizationSlug }),
			);
			rerender(
				<QueryClientProvider client={queryClient}>
					<AnthropicCapabilityBanner />
				</QueryClientProvider>,
			);
		}

		/** Read the notice in the current workspace and answer it. */
		async function dismissHere() {
			expect(await screen.findByText(TITLE)).toBeInTheDocument();
			fireEvent.click(
				screen.getByRole("button", {
					name: "Dismiss Anthropic capability notice",
				}),
			);
			expect(screen.queryByText(TITLE)).toBeNull();
		}

		// Answered for the first workspace.
		await dismissHere();

		// ...and, after a switch, for the second. The test above stops here.
		switchTo(OTHER_ORG_ID, "globex");
		await dismissHere();

		// Switching away and back is ordinary. A dismissal held as the LAST
		// organization alone was evicted by the second answer, so returning here
		// re-raised a notice this reader had already dealt with — the same
		// nagging the tenant key was added to stop, one switch removed.
		const callsBeforeReturn = getStatusMock.mock.calls.length;
		switchTo(ORG_ID, "acme");

		// The wait is load-bearing. This organization's cache went when the
		// observer moved away, so for a moment the banner has no data — and a
		// banner with no data is hidden for a reason that has nothing to do with
		// dismissal, which would let a single-slot regression pass. Assert only
		// once the answer describing the same unchanged gap is back.
		await waitFor(() =>
			expect(getStatusMock.mock.calls.length).toBeGreaterThan(
				callsBeforeReturn,
			),
		);
		await settle();
		expect(screen.queryByText(TITLE)).toBeNull();
	});
});

describe("AnthropicCapabilityBanner — nothing to say yet", () => {
	it("renders nothing while the status is loading", async () => {
		getStatusMock.mockReturnValue(pending());

		renderBanner();

		await waitFor(() => expect(getStatusMock).toHaveBeenCalled());
		expect(screen.queryByText(TITLE)).toBeNull();
	});

	it("renders nothing when the status call fails", async () => {
		// Absent data means "we do not know", never "embeddings land on
		// Anthropic".
		getStatusMock.mockRejectedValue(new Error("boom"));

		renderBanner();

		await waitFor(() => expect(getStatusMock).toHaveBeenCalled());
		expect(screen.queryByText(TITLE)).toBeNull();
	});

	it("asks nothing and says nothing while the URL's organization is still resolving", async () => {
		// `organizationId` is null in that window without meaning there is no
		// organization. Everything here is tenant-scoped, so asking would ask
		// about the caller's personal setup and describe it to someone standing
		// inside an organization.
		orgContextMock.mockReturnValue(
			orgContext({
				organizationId: null,
				organizationSlug: null,
				isOrgContext: false,
				isResolvingOrganization: true,
			}),
		);

		renderBanner();

		await settle();
		expect(getStatusMock).not.toHaveBeenCalled();
		expect(screen.queryByText(TITLE)).toBeNull();
	});

	it("shows nothing from the previous organization after a switch", async () => {
		const queryClient = makeClient();
		const { rerender } = renderBanner(queryClient);
		expect(await screen.findByText(TITLE)).toBeInTheDocument();

		// The new organization's key has no data yet. Rendering the old
		// tenant's answer under the new tenant's name would be a leak, not a
		// nicety.
		getStatusMock.mockReturnValue(pending());
		orgContextMock.mockReturnValue(
			orgContext({
				organizationId: OTHER_ORG_ID,
				organizationSlug: "globex",
			}),
		);
		rerender(
			<QueryClientProvider client={queryClient}>
				<AnthropicCapabilityBanner />
			</QueryClientProvider>,
		);

		expect(screen.queryByText(TITLE)).toBeNull();
		await waitFor(() =>
			expect(getStatusMock).toHaveBeenCalledWith({
				organizationId: OTHER_ORG_ID,
			}),
		);
		expect(screen.queryByText(TITLE)).toBeNull();
	});
});

describe("AnthropicCapabilityBanner — the route names an organization the context never resolved", () => {
	/**
	 * The context a FAILED organization lookup leaves behind: no id, and no
	 * loading flag raised, because that query does not retry.
	 *
	 * Byte for byte the context of someone standing outside any organization —
	 * which is the whole difficulty. Only the ROUTE separates the two, so every
	 * test below sets the params deliberately rather than inheriting them.
	 */
	function nullTenantContext() {
		return orgContext({
			organizationId: null,
			organizationSlug: null,
			isOrgContext: false,
			isOrganizationAdmin: false,
			// Spelled out rather than left to the fixture's default: this is the
			// failed-lookup shape, and its difference from the loading one — the
			// flag already back down — is the point of the block.
			isResolvingOrganization: false,
		});
	}

	it("asks nothing and shows nothing when the route names an organization that failed to resolve", async () => {
		// Not the loading window asserted above: the lookup is over and lost,
		// and the flag that window is recognised by is already back down. Asking
		// here sends `organizationId: null`, which the status procedure answers
		// from its PERSONAL arm — so this reader's own embedding configuration
		// would be reported to them as the organization's.
		paramsMock.mockReturnValue({ organizationSlug: "acme" });
		orgContextMock.mockReturnValue(nullTenantContext());

		renderBanner();

		await settle();
		expect(getStatusMock).not.toHaveBeenCalled();
		expect(screen.queryByText(TITLE)).toBeNull();
	});

	it("asks as normal once the slug resolves to an organization", async () => {
		// The control for the negative above: the same route, the same flush,
		// with the id in place. Without it "never called" could be a flush too
		// short to catch the call rather than the gate holding.
		paramsMock.mockReturnValue({ organizationSlug: "acme" });

		renderBanner();

		await settle();
		expect(getStatusMock).toHaveBeenCalledWith({ organizationId: ORG_ID });
		expect(screen.getByText(TITLE)).toBeInTheDocument();
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
			status({
				canResolveProvider: true,
				resolvedEmbeddingProvider: ANTHROPIC_PROVIDER_ID,
			}),
		);
		// Nothing may arrive over the network either, so the cache is the only
		// thing that could put this notice on screen.
		getStatusMock.mockReturnValue(pending());
		paramsMock.mockReturnValue({ organizationSlug: "acme" });
		orgContextMock.mockReturnValue(nullTenantContext());

		renderBanner(queryClient);

		await settle();
		expect(getStatusMock).not.toHaveBeenCalled();
		expect(screen.queryByText(TITLE)).toBeNull();

		// The control: that cached answer is live, and it does render — on the
		// personal route it actually describes. Without this the assertion above
		// could be satisfied by a seed that never landed on the key this banner
		// reads, and would then hold however the gate behaved.
		cleanup();
		queryClient.setQueryData(
			aiConfigStatusQueryKey(null),
			status({
				canResolveProvider: true,
				resolvedEmbeddingProvider: ANTHROPIC_PROVIDER_ID,
			}),
		);
		pathnameMock.mockReturnValue("/app/projects");
		paramsMock.mockReturnValue({});
		renderBanner(queryClient);

		expect(screen.getByText(TITLE)).toBeInTheDocument();
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
		expect(await screen.findByText(TITLE)).toBeInTheDocument();
	});
});

describe("AnthropicCapabilityBanner — accessibility", () => {
	it("names itself distinctly from the sibling reminder", async () => {
		renderBanner();

		expect(
			await screen.findByRole("alert", {
				name: "Anthropic capability notice",
			}),
		).toBeInTheDocument();
	});

	it("hides the decorative icon from assistive technology", async () => {
		renderBanner();

		const alert = await screen.findByRole("alert", {
			name: "Anthropic capability notice",
		});
		const icon = alert.querySelector("svg");
		expect(icon).not.toBeNull();
		expect(icon).toHaveAttribute("aria-hidden", "true");
	});

	it("gives the dismiss control an accessible name", async () => {
		renderBanner();

		expect(
			await screen.findByRole("button", {
				name: "Dismiss Anthropic capability notice",
			}),
		).toBeInTheDocument();
	});

	it("wraps its entrance in motion-safe", async () => {
		renderBanner();

		const alert = await screen.findByRole("alert", {
			name: "Anthropic capability notice",
		});
		const wrapper = alert.parentElement;
		expect(wrapper?.className).toContain("motion-safe:animate-in");
		expect(wrapper?.className).toContain("motion-safe:fade-in");
		// An unprefixed entrance class would animate for a reader who asked
		// the operating system for no motion.
		expect(wrapper?.className).not.toMatch(/(^|\s)animate-in/);
		expect(wrapper?.className).not.toMatch(/(^|\s)fade-in/);
	});
});
