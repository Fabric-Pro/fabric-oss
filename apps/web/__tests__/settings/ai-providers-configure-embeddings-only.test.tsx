/**
 * "Embeddings only" in a provider's Configure dialog (Fizzy #2770): a key
 * meant for document search is saved restricted, so the first save never
 * makes it the default provider, not even for the moments before the card's
 * own toggle could be reached. Shared harness with the credential-safety
 * suite.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetStatus, mockTestConnection, mockUpsert, mockGetConfig } =
	vi.hoisted(() => ({
		mockGetStatus: vi.fn(),
		mockTestConnection: vi.fn(),
		mockUpsert: vi.fn(),
		mockGetConfig: vi.fn(),
	}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: {
			resolution: { getStatus: mockGetStatus },
			providers: {
				testConnection: mockTestConnection,
				testSavedConnection: vi.fn(),
				upsert: mockUpsert,
				setDefault: vi.fn(),
				setEmbedding: vi.fn(),
				delete: vi.fn(),
				getConfig: mockGetConfig,
				updateEnabled: vi.fn(),
			},
		},
	},
}));

vi.mock("@saas/settings/hooks/use-return-to-redirect", () => ({
	useReturnToRedirect: () => ({ triggerReturn: vi.fn() }),
}));

// Only `OrgAiProvidersSettingsForm` reads this; the personal form ignores it.
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org_example",
		organizationName: "Example Org",
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

const WORKSPACE = "https://example-workspace.cloud.databricks.com";

function renderForm(Form: () => React.ReactNode = AiProvidersSettingsForm) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<Form />
		</QueryClientProvider>,
	);
}

/**
 * Open the configure dialog for a provider by its card button.
 *
 * @param expectReconfigure - Wait for the button to read "Reconfigure" first.
 *   The prefill only runs for an ALREADY-configured provider, and that label is
 *   the signal that the status query has landed — clicking sooner would take
 *   the `!isProviderConfigured` early return and skip the prefill entirely.
 */
async function openConfigureDialog(
	providerName: string,
	expectReconfigure = false,
) {
	const findButton = () => {
		const cards = screen.queryAllByText(providerName);
		const card = cards[0]?.closest("div.relative") as
			| HTMLElement
			| undefined;
		return Array.from(card?.querySelectorAll("button") ?? []).find((b) =>
			/configure/i.test(b.textContent ?? ""),
		);
	};

	await waitFor(() => {
		const button = findButton();
		expect(button).toBeDefined();
		if (expectReconfigure) {
			expect(button?.textContent ?? "").toMatch(/reconfigure/i);
		}
	});

	const button = findButton();
	if (!button) {
		throw new Error(`No Configure button found for ${providerName}`);
	}
	fireEvent.click(button);
}

function getSaveButton(): HTMLButtonElement {
	const button = Array.from(document.querySelectorAll("button")).find((b) =>
		/save configuration/i.test(b.textContent ?? ""),
	);
	if (!button) {
		throw new Error("Save button not found");
	}
	return button as HTMLButtonElement;
}

function getTestButton(): HTMLButtonElement {
	// The label flips to "Testing Connection..." while a request is in flight.
	const button = Array.from(document.querySelectorAll("button")).find((b) =>
		/test(ing)? connection/i.test(b.textContent ?? ""),
	);
	if (!button) {
		throw new Error("Test button not found");
	}
	return button as HTMLButtonElement;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetStatus.mockResolvedValue({
		isConfigured: false,
		message: "",
		configuredProviders: [],
		embeddingProvider: null,
		embeddingModel: null,
	});
	mockTestConnection.mockResolvedValue({
		success: true,
		message: "Connected",
		latencyMs: 12,
	});
	mockUpsert.mockResolvedValue({
		success: true,
		id: "ucpc_1",
		provider: "DATABRICKS",
		displayName: "Databricks",
		isDefault: true,
	});
	mockGetConfig.mockResolvedValue({
		success: true,
		provider: "DATABRICKS",
		displayName: "Databricks",
		isDefault: true,
		isEmbeddingProvider: false,
		enabled: true,
		enabledProviders: [],
		hasApiKey: false,
		hasServicePrincipal: true,
		clientId: "saved-client-id",
		baseUrl: WORKSPACE,
		deploymentName: null,
	});
});

describe("Configure dialog — Embeddings only", () => {
	async function configureDatabricks(
		Form: () => React.ReactNode,
		embeddingsOnly: boolean,
	) {
		renderForm(Form);
		await openConfigureDialog("Databricks");
		fireEvent.change(screen.getByLabelText(/^API Key$/i), {
			target: { value: "dapi-good" },
		});
		fireEvent.change(screen.getByLabelText(/Gateway URL/i), {
			target: { value: WORKSPACE },
		});
		if (embeddingsOnly) {
			fireEvent.click(screen.getByTestId("configure-embeddings-only"));
		}
		fireEvent.click(getTestButton());
		await waitFor(() => expect(getSaveButton().disabled).toBe(false));
		fireEvent.click(getSaveButton());
		await waitFor(() => expect(mockUpsert).toHaveBeenCalledTimes(1));
		return mockUpsert.mock.calls[0]?.[0] as Record<string, unknown>;
	}

	it.each([
		["the organization form", OrgAiProvidersSettingsForm],
		["the account form", AiProvidersSettingsForm],
	])(
		"saves the key for embeddings only, never as the default, from %s",
		async (_label, Form) => {
			const saved = await configureDatabricks(Form, true);
			expect(saved).toMatchObject({
				provider: "DATABRICKS",
				purpose: "EMBEDDINGS_ONLY",
			});
			expect(saved.isDefault).not.toBe(true);
		},
	);

	it("offers no second embeddings-only key", async () => {
		mockGetStatus.mockResolvedValue({
			isConfigured: true,
			message: "",
			configuredProviders: [
				{
					provider: "OPENAI_DIRECT",
					displayName: "OpenAI",
					isDefault: false,
					isEmbeddingProvider: true,
					purpose: "EMBEDDINGS_ONLY",
					source: "org_config",
				},
			],
			embeddingProvider: "OPENAI_DIRECT",
			embeddingModel: null,
		});
		renderForm(OrgAiProvidersSettingsForm);
		await openConfigureDialog("Databricks");
		expect(screen.getByTestId("configure-embeddings-only")).toBeDisabled();
	});

	it("saves an unrestricted key as before, the first one as the default", async () => {
		const saved = await configureDatabricks(
			OrgAiProvidersSettingsForm,
			false,
		);
		expect(saved).toMatchObject({ purpose: "ALL", isDefault: true });
	});
});
