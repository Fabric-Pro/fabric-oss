/**
 * Tests for the Anthropic capability notice on the Direct Providers cards
 * (Fizzy #2289).
 *
 * Anthropic serves chat, reasoning and tool-calling; it serves no embedding,
 * image or audio models. Provider settings never said so, so a user configured
 * Anthropic, saw a success state, and met the consequence days later on a
 * different page. The notice states the limitation on the card itself, before
 * any configure action is taken.
 *
 * What these tests pin:
 *
 *  1. **The notice is unconditional.** It is a statement about the vendor, not
 *     about this tenant's setup, so saving a key does not close the gap and
 *     must not silence the notice.
 *  2. **Only Anthropic carries it.** The neighbouring providers do not share
 *     Anthropic's exact gaps — Groq, for one, serves audio transcription — so a
 *     notice that leaked onto another card would be a false claim about a
 *     vendor.
 *  3. **It informs, it does not gate.** Configuring Anthropic stays available
 *     and enabled while the notice is on screen.
 *
 * The expected strings are typed out as literals below rather than imported
 * from the copy module. Asserting an import against itself would pass no
 * matter what the copy said; these literals are the product-approved wording,
 * and a reword has to be made here deliberately.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetStatus } = vi.hoisted(() => ({
	mockGetStatus: vi.fn(),
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
		organizationId: "org_acme",
		organizationName: "Acme",
		isOrgContext: true,
	}),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

// react-query is only used for status/invalidations here; drive the view with
// a real client so the component's own async flow is exercised unchanged.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AiProvidersSettingsForm } from "../../modules/saas/settings/components/AiProvidersSettingsForm";
import { OrgAiProvidersSettingsForm } from "../../modules/saas/settings/components/OrgAiProvidersSettingsForm";
import {
	ANTHROPIC_PROVIDER_ID,
	getDirectProviders,
} from "../../modules/saas/settings/lib/ai-providers";

/**
 * Product-approved wording — deliberately retyped, never imported. A copy
 * assertion that reads the same constant it is checking proves only that the
 * import resolved.
 *
 * The provider id below goes the other way and IS imported, because the two
 * fail in opposite directions: a retyped sentence that drifts makes this test
 * shout, while a retyped identifier that drifts makes the fixture quietly stop
 * describing an Anthropic row, and every assertion passes for the wrong reason.
 */
const CAPABILITY_TITLE = "Some capabilities are unavailable with Anthropic";
const CAPABILITY_BODY =
	"Anthropic does not support embeddings, image generation, or audio. To use these features, configure an additional provider that supports them.";

const ANTHROPIC_CARD_NAME = "Anthropic";

function renderPersonalForm() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<AiProvidersSettingsForm />
		</QueryClientProvider>,
	);
}

function renderOrgForm() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<OrgAiProvidersSettingsForm />
		</QueryClientProvider>,
	);
}

/**
 * The card for one provider, found by its own heading rather than by a class,
 * so the assertions stay scoped to a single card in a grid of eleven.
 */
function getProviderCard(providerName: string): HTMLElement {
	const heading = screen
		.getAllByRole("heading", { level: 4 })
		.find((node) => node.textContent?.trim() === providerName);
	if (!heading) {
		throw new Error(`No provider card found for ${providerName}`);
	}
	const card = heading.closest("div.relative");
	if (!card) {
		throw new Error(`Provider card for ${providerName} has no container`);
	}
	return card as HTMLElement;
}

/**
 * The notice block inside a card: walk up from the approved title until an
 * ancestor also holds the decorative icon. Found structurally so the test does
 * not encode the notice's styling classes.
 */
function getCapabilityNotice(card: HTMLElement): HTMLElement {
	const title = within(card).getByText(CAPABILITY_TITLE);
	let node = title.parentElement;
	while (node && !node.querySelector("svg")) {
		node = node.parentElement;
	}
	if (!node) {
		throw new Error("Capability notice has no icon-bearing container");
	}
	return node;
}

function getConfigureButton(card: HTMLElement): HTMLButtonElement {
	const button = Array.from(card.querySelectorAll("button")).find((node) =>
		/configure/i.test(node.textContent ?? ""),
	);
	if (!button) {
		throw new Error("No Configure button found on the card");
	}
	return button as HTMLButtonElement;
}

const UNCONFIGURED_STATUS = {
	isConfigured: false,
	message: "",
	configuredProviders: [],
	embeddingProvider: null,
	embeddingModel: null,
};

const ANTHROPIC_CONFIGURED_STATUS = {
	isConfigured: true,
	message: "configured",
	configuredProviders: [
		{
			provider: ANTHROPIC_PROVIDER_ID,
			displayName: "Anthropic",
			isDefault: true,
			isEmbeddingProvider: false,
		},
	],
	embeddingProvider: null,
	embeddingModel: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	mockGetStatus.mockResolvedValue(UNCONFIGURED_STATUS);
});

describe("the Anthropic capability notice", () => {
	it("states the limitation on the Anthropic card once Anthropic is configured (AE4)", async () => {
		mockGetStatus.mockResolvedValue(ANTHROPIC_CONFIGURED_STATUS);
		renderPersonalForm();

		// "Reconfigure" is the signal that the status query landed and the card
		// knows Anthropic is set up — the point at which a success state used to
		// be the last word the user got.
		await waitFor(() =>
			expect(
				getConfigureButton(getProviderCard(ANTHROPIC_CARD_NAME))
					.textContent ?? "",
			).toMatch(/reconfigure/i),
		);

		const card = getProviderCard(ANTHROPIC_CARD_NAME);
		expect(within(card).getByText(CAPABILITY_TITLE)).toBeInTheDocument();
		expect(within(card).getByText(CAPABILITY_BODY)).toBeInTheDocument();
	});

	it("states the limitation on the Anthropic card when Anthropic is not configured", async () => {
		renderPersonalForm();

		await waitFor(() => expect(mockGetStatus).toHaveBeenCalled());

		const card = getProviderCard(ANTHROPIC_CARD_NAME);
		expect(getConfigureButton(card).textContent ?? "").toMatch(
			/^\s*configure\s*$/i,
		);
		expect(within(card).getByText(CAPABILITY_TITLE)).toBeInTheDocument();
		expect(within(card).getByText(CAPABILITY_BODY)).toBeInTheDocument();
	});

	it("leaves every other direct-provider card without a capability notice (AE5)", async () => {
		renderPersonalForm();

		await waitFor(() => expect(mockGetStatus).toHaveBeenCalled());

		// One notice on the page, and it is Anthropic's.
		expect(screen.getAllByText(CAPABILITY_TITLE)).toHaveLength(1);
		expect(screen.getAllByText(CAPABILITY_BODY)).toHaveLength(1);

		const otherProviders = getDirectProviders().filter(
			(provider) => provider.name !== ANTHROPIC_CARD_NAME,
		);
		expect(otherProviders.length).toBeGreaterThan(0);

		for (const provider of otherProviders) {
			const card = getProviderCard(provider.name);
			expect(
				within(card).queryByText(CAPABILITY_TITLE),
			).not.toBeInTheDocument();
			expect(
				within(card).queryByText(CAPABILITY_BODY),
			).not.toBeInTheDocument();
		}
	});

	it("keeps Anthropic configurable while the notice is displayed (AE5)", async () => {
		renderPersonalForm();

		await waitFor(() => expect(mockGetStatus).toHaveBeenCalled());

		const card = getProviderCard(ANTHROPIC_CARD_NAME);
		expect(within(card).getByText(CAPABILITY_TITLE)).toBeInTheDocument();

		// The notice informs; it must not gate. A disabled Configure here would
		// turn a caveat into a block.
		const configure = getConfigureButton(card);
		expect(configure).toBeInTheDocument();
		expect(configure.disabled).toBe(false);
	});

	it("hides the notice's icon from assistive technology and leaves the copy as plain content", async () => {
		renderPersonalForm();

		await waitFor(() => expect(mockGetStatus).toHaveBeenCalled());

		const card = getProviderCard(ANTHROPIC_CARD_NAME);
		const notice = getCapabilityNotice(card);

		const icon = notice.querySelector("svg");
		expect(icon).not.toBeNull();
		expect(icon?.getAttribute("aria-hidden")).toBe("true");

		// The notice is static for the life of the page, so it is read in DOM
		// order rather than announced — no live region, no alert role.
		expect(notice.querySelector("[aria-live]")).toBeNull();
		expect(within(card).queryByRole("alert")).not.toBeInTheDocument();
	});
});

describe("the organization AI Providers surface", () => {
	it("carries the same notice on its Anthropic card", async () => {
		renderOrgForm();

		await waitFor(() => expect(mockGetStatus).toHaveBeenCalled());

		const card = getProviderCard(ANTHROPIC_CARD_NAME);
		expect(within(card).getByText(CAPABILITY_TITLE)).toBeInTheDocument();
		expect(within(card).getByText(CAPABILITY_BODY)).toBeInTheDocument();
		expect(getConfigureButton(card).disabled).toBe(false);
	});
});
