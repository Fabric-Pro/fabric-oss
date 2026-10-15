/**
 * `SearchProvidersSettingsForm` — the Cloudflare Browser Rendering dialog.
 *
 * Cloudflare keeps its account ID in the provider row's endpoint, as the
 * account-scoped API base URL. The dialog asks for the account ID instead of a
 * custom endpoint, composes the endpoint on test and save, and reads the ID
 * back from a stored endpoint when editing. Other providers keep the generic
 * endpoint field.
 *
 * `@tanstack/react-query` is real so the queries and mutations run through the
 * component's own hooks.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;

const state = vi.hoisted(() => ({
	configs: [] as unknown[],
	updateMock: vi.fn(),
	testMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		searchProviders: {
			listAvailableProviders: async () => [
				{
					name: "cloudflare",
					displayName: "Cloudflare Browser Rendering",
					description: "Renders pages as Markdown.",
					docsUrl:
						"https://developers.cloudflare.com/browser-rendering/rest-api/markdown-endpoint/",
					requiresApiKey: true,
					supportsContentRetrieval: true,
					supportsImageSearch: false,
					supportedCategories: [],
					costPerSearch: 0,
				},
				{
					name: "tavily",
					displayName: "Tavily",
					description: "Search API.",
					docsUrl: "https://docs.tavily.com",
					requiresApiKey: true,
					supportsContentRetrieval: true,
					supportsImageSearch: true,
					supportedCategories: ["general", "news"],
					costPerSearch: 0.001,
				},
			],
			getOrganizationProviders: async () => state.configs,
			updateOrganizationProvider: (input: unknown) =>
				state.updateMock(input),
			testProviderConnection: (input: unknown) => state.testMock(input),
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: { id: "org-1", name: "Example Org" },
	}),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { SearchProvidersSettingsForm } from "../SearchProvidersSettingsForm";

function renderForm() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<SearchProvidersSettingsForm />
		</QueryClientProvider>,
	);
}

async function openDialog(providerHeading: string) {
	const user = userEvent.setup();
	renderForm();
	const heading = await screen.findByRole("heading", {
		name: providerHeading,
	});
	const tile = heading.closest(".app-surface");
	if (!(tile instanceof HTMLElement)) {
		throw new Error("provider tile not found");
	}
	await user.click(
		within(tile).getByRole("button", { name: /Configure|Edit/ }),
	);
	return { user, dialog: await screen.findByRole("dialog") };
}

beforeEach(() => {
	vi.clearAllMocks();
	state.configs = [];
	state.updateMock.mockResolvedValue({ success: true });
	state.testMock.mockResolvedValue({ success: true, responseTime: 5 });
});

describe("SearchProvidersSettingsForm — Cloudflare Browser Rendering", () => {
	it("asks for an account ID and an API token instead of a custom endpoint", async () => {
		const { dialog } = await openDialog("Cloudflare Browser Rendering");

		expect(within(dialog).getByLabelText("Account ID")).toBeInTheDocument();
		expect(
			within(dialog).getByLabelText("API token"),
		).toHaveAccessibleDescription(/Browser Rendering - Edit permission/);
		expect(
			within(dialog).queryByLabelText(/Custom Endpoint/),
		).not.toBeInTheDocument();
		expect(await axe(dialog)).toHaveNoViolations();
	});

	it("flags a malformed account ID and blocks test and save", async () => {
		const { user, dialog } = await openDialog(
			"Cloudflare Browser Rendering",
		);
		await user.type(within(dialog).getByLabelText("API token"), "cf-token");
		const accountInput = within(dialog).getByLabelText("Account ID");
		await user.type(accountInput, "not-an-account");

		expect(accountInput).toHaveAttribute("aria-invalid", "true");
		expect(accountInput).toHaveAccessibleDescription(/32 characters/);
		expect(
			within(dialog).getByRole("button", { name: "Test Connection" }),
		).toBeDisabled();
		expect(
			within(dialog).getByRole("button", { name: "Save Configuration" }),
		).toBeDisabled();
	});

	it("composes the account endpoint on test and save", async () => {
		const { user, dialog } = await openDialog(
			"Cloudflare Browser Rendering",
		);
		await user.type(within(dialog).getByLabelText("API token"), "cf-token");
		// Pasted with surrounding space and in capitals: normalised.
		await user.type(
			within(dialog).getByLabelText("Account ID"),
			` ${ACCOUNT_ID.toUpperCase()} `,
		);

		await user.click(
			within(dialog).getByRole("button", { name: "Test Connection" }),
		);
		await waitFor(() =>
			expect(state.testMock).toHaveBeenCalledWith({
				providerName: "cloudflare",
				apiKey: "cf-token",
				endpoint: ENDPOINT,
			}),
		);

		await user.click(
			within(dialog).getByRole("button", { name: "Save Configuration" }),
		);
		await waitFor(() =>
			expect(state.updateMock).toHaveBeenCalledWith(
				expect.objectContaining({
					organizationId: "org-1",
					providerName: "cloudflare",
					apiKey: "cf-token",
					endpoint: ENDPOINT,
				}),
			),
		);
	});

	it("reads the account ID back from a stored endpoint when editing", async () => {
		state.configs = [
			{
				id: "row-1",
				providerName: "cloudflare",
				maskedApiKey: "en***",
				endpoint: ENDPOINT,
				isDefault: false,
				priority: 0,
				enabled: true,
				lastUsedAt: null,
				searchesCount: 0,
				totalCost: 0,
			},
		];
		const { dialog } = await openDialog("Cloudflare Browser Rendering");
		expect(within(dialog).getByLabelText("Account ID")).toHaveValue(
			ACCOUNT_ID,
		);
	});

	it("keeps the custom endpoint field for other providers", async () => {
		const { dialog } = await openDialog("Tavily");
		expect(
			within(dialog).getByLabelText(/Custom Endpoint/),
		).toBeInTheDocument();
		expect(
			within(dialog).queryByLabelText("Account ID"),
		).not.toBeInTheDocument();
		expect(within(dialog).getByLabelText("API Key")).toBeInTheDocument();
	});
});
