/**
 * Tests for `AiProvidersSettingsForm`'s credential-safety behaviour.
 *
 * Two defects this pins:
 *
 *  1. **Stale test success.** A passing connection test used to be a bare
 *     boolean, so you could test a valid credential, edit it to garbage, and
 *     still Save the untested value. Save now requires that the passing test
 *     covered the values currently in the form. This applied to the plain API
 *     key long before service principals existed, so it is covered for both
 *     auth modes.
 *
 *  2. **Reconfigure prefill race.** Reopening a configured provider fires a
 *     `getConfig` request to restore the saved auth mode. A slow response must
 *     not overwrite what the user has since typed, nor mutate a dialog that has
 *     closed or switched provider.
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

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

// react-query is only used for status/invalidations here; drive the view with
// a real client so the component's own async flow is exercised unchanged.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";

import { AiProvidersSettingsForm } from "../../modules/saas/settings/components/AiProvidersSettingsForm";

const WORKSPACE = "https://example-workspace.cloud.databricks.com";

function renderForm() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<AiProvidersSettingsForm />
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

describe("stale connection-test success", () => {
	it("re-locks Save when the API key is edited after a passing test", async () => {
		renderForm();
		await openConfigureDialog("Databricks");

		fireEvent.change(screen.getByLabelText(/^API Key$/i), {
			target: { value: "dapi-good" },
		});
		fireEvent.change(screen.getByLabelText(/Gateway URL/i), {
			target: { value: WORKSPACE },
		});

		fireEvent.click(getTestButton());
		await waitFor(() => expect(getSaveButton().disabled).toBe(false));

		// Swap in an untested credential — Save must lock again.
		fireEvent.change(screen.getByLabelText(/^API Key$/i), {
			target: { value: "dapi-garbage" },
		});
		expect(getSaveButton().disabled).toBe(true);
	});

	it("re-locks Save when the client secret is edited after a passing test", async () => {
		renderForm();
		await openConfigureDialog("Databricks");

		fireEvent.click(screen.getByLabelText(/Service principal/i));
		fireEvent.change(
			screen.getByLabelText(/Service Principal Client ID/i),
			{ target: { value: "client-abc" } },
		);
		fireEvent.change(
			screen.getByLabelText(/Service Principal Client Secret/i),
			{ target: { value: "secret-good" } },
		);
		fireEvent.change(screen.getByLabelText(/Gateway URL/i), {
			target: { value: WORKSPACE },
		});

		fireEvent.click(getTestButton());
		await waitFor(() => expect(getSaveButton().disabled).toBe(false));

		fireEvent.change(
			screen.getByLabelText(/Service Principal Client Secret/i),
			{ target: { value: "secret-garbage" } },
		);
		expect(getSaveButton().disabled).toBe(true);
	});

	it("re-locks Save when the base URL is edited after a passing test", async () => {
		renderForm();
		await openConfigureDialog("Databricks");

		fireEvent.change(screen.getByLabelText(/^API Key$/i), {
			target: { value: "dapi-good" },
		});
		fireEvent.change(screen.getByLabelText(/Gateway URL/i), {
			target: { value: WORKSPACE },
		});

		fireEvent.click(getTestButton());
		await waitFor(() => expect(getSaveButton().disabled).toBe(false));

		fireEvent.change(screen.getByLabelText(/Gateway URL/i), {
			target: { value: "https://other.cloud.databricks.com" },
		});
		expect(getSaveButton().disabled).toBe(true);
	});

	it("does not apply a test result that resolves after the input changed", async () => {
		let resolveTest: (v: unknown) => void = () => undefined;
		mockTestConnection.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveTest = resolve;
				}),
		);

		renderForm();
		await openConfigureDialog("Databricks");

		fireEvent.change(screen.getByLabelText(/^API Key$/i), {
			target: { value: "dapi-good" },
		});
		fireEvent.change(screen.getByLabelText(/Gateway URL/i), {
			target: { value: WORKSPACE },
		});
		fireEvent.click(getTestButton());

		// Edit while the request is in flight, THEN let it succeed.
		fireEvent.change(screen.getByLabelText(/^API Key$/i), {
			target: { value: "dapi-changed-mid-flight" },
		});
		resolveTest({ success: true, message: "Connected", latencyMs: 5 });

		// Let the resolution propagate through the mutation and re-render.
		await waitFor(() =>
			expect(mockTestConnection).toHaveBeenCalledTimes(1),
		);
		await Promise.resolve();

		// The result described superseded input, so it must neither unlock Save
		// nor announce success for a credential that is no longer on screen.
		await waitFor(() => expect(getSaveButton().disabled).toBe(true));
		expect(toast.success).not.toHaveBeenCalled();
	});
});

describe("reconfigure prefill race", () => {
	beforeEach(() => {
		mockGetStatus.mockResolvedValue({
			isConfigured: true,
			message: "configured",
			configuredProviders: [
				{
					provider: "DATABRICKS",
					displayName: "Databricks",
					isDefault: true,
					isEmbeddingProvider: false,
				},
			],
			embeddingProvider: null,
			embeddingModel: null,
		});
	});

	it("restores the saved service-principal mode and client ID", async () => {
		renderForm();
		await openConfigureDialog("Databricks", true);

		await waitFor(() =>
			expect(
				screen.getByLabelText(/Service Principal Client ID/i),
			).toHaveValue("saved-client-id"),
		);
		// The secret is never returned by the API and must stay blank.
		expect(
			screen.getByLabelText(/Service Principal Client Secret/i),
		).toHaveValue("");
	});

	it("does not overwrite input typed while the prefill was in flight", async () => {
		let resolvePrefill: (v: unknown) => void = () => undefined;
		mockGetConfig.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolvePrefill = resolve;
				}),
		);

		renderForm();
		await openConfigureDialog("Databricks", true);

		// The dialog opens in API-key mode; the saved config is a service
		// principal, so an applied prefill would BOTH overwrite the URL and flip
		// the auth mode — two observable effects to rule out.
		const typedUrl = "https://typed-by-user.cloud.databricks.com";
		fireEvent.change(screen.getByLabelText(/Gateway URL/i), {
			target: { value: typedUrl },
		});

		resolvePrefill({
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

		// Give the response every chance to land before asserting it did not.
		await waitFor(() => expect(mockGetConfig).toHaveBeenCalledTimes(1));
		await Promise.resolve();
		await Promise.resolve();

		// The user's typing must survive verbatim...
		expect(screen.getByLabelText(/Gateway URL/i)).toHaveValue(typedUrl);
		// ...and the late response must not switch the form to service-principal
		// mode, which would swap the visible credential fields under the user.
		expect(
			screen.queryByLabelText(/Service Principal Client ID/i),
		).toBeNull();
		expect(screen.getByLabelText(/^API Key$/i)).toBeTruthy();
	});

	it("does not let a delayed prefill flip auth mode after the user edits a credential", async () => {
		let resolvePrefill: (v: unknown) => void = () => undefined;
		mockGetConfig.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolvePrefill = resolve;
				}),
		);

		renderForm();
		await openConfigureDialog("Databricks", true);

		// Editing the API key is enough to take ownership of the dialog.
		fireEvent.change(screen.getByLabelText(/^API Key$/i), {
			target: { value: "dapi-typed-by-user" },
		});

		resolvePrefill({
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

		await waitFor(() => expect(mockGetConfig).toHaveBeenCalledTimes(1));
		await Promise.resolve();
		await Promise.resolve();

		expect(screen.getByLabelText(/^API Key$/i)).toHaveValue(
			"dapi-typed-by-user",
		);
		expect(
			screen.queryByLabelText(/Service Principal Client ID/i),
		).toBeNull();
	});

	it("drops a prefill that resolves after the dialog closed", async () => {
		let resolvePrefill: (v: unknown) => void = () => undefined;
		mockGetConfig.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolvePrefill = resolve;
				}),
		);

		renderForm();
		await openConfigureDialog("Databricks", true);

		// Close the dialog while the prefill is still in flight.
		const cancel = Array.from(document.querySelectorAll("button")).find(
			(b) => /^cancel$/i.test((b.textContent ?? "").trim()),
		);
		fireEvent.click(cancel as HTMLButtonElement);

		resolvePrefill({
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

		// Reopening must show a clean form, not state applied by the stale
		// response after close.
		await openConfigureDialog("Databricks", true);
		await waitFor(() =>
			expect(screen.queryByLabelText(/^API Key$/i)).not.toBeNull(),
		);
	});
});
