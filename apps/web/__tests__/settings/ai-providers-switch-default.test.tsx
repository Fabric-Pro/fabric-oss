import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { expect, it, vi } from "vitest";

vi.mock("next-intl", async () => vi.importActual("next-intl"));
const api = vi.hoisted(() => ({
	status: vi.fn(),
	preview: vi.fn(),
	setDefault: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: {
			resolution: { getStatus: api.status },
			providers: {
				previewSetDefault: api.preview,
				setDefault: api.setDefault,
				testConnection: vi.fn(),
				testSavedConnection: vi.fn(),
				upsert: vi.fn(),
				setEmbedding: vi.fn(),
				delete: vi.fn(),
				getConfig: vi.fn(),
				updateEnabled: vi.fn(),
			},
		},
	},
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "example-org",
		isOrgContext: true,
	}),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { OrgAiProvidersSettingsForm } from "../../modules/saas/settings/components/OrgAiProvidersSettingsForm";

// Restoring the direct setDefault click handler bypasses review and calls the
// mutation before acknowledgement; leaving out invalidations fails below.
it("reviews the clicked provider in the shared dialog before switching and invalidates AI Models", async () => {
	const providers = [
		{
			provider: "OPENAI_DIRECT",
			displayName: "OpenAI",
			isDefault: false,
			isEmbeddingProvider: true,
			purpose: "ALL",
			source: "org_config",
		},
		{
			provider: "ANTHROPIC_DIRECT",
			displayName: "Anthropic",
			isDefault: true,
			isEmbeddingProvider: false,
			purpose: "ALL",
			source: "org_config",
		},
	];
	api.status.mockResolvedValue({
		isConfigured: true,
		defaultProvider: "ANTHROPIC_DIRECT",
		configuredProviders: providers,
		message: "Example providers configured",
		embeddingProvider: "OPENAI_DIRECT",
	});
	api.preview.mockResolvedValue({
		currentProvider: "ANTHROPIC_DIRECT",
		targetProvider: "OPENAI_DIRECT",
		validProviders: [
			{ provider: "OPENAI_DIRECT" },
			{ provider: "ANTHROPIC_DIRECT" },
		],
		savedTextChoiceCount: 2,
		removedPreferences: [],
		keptPreferences: [],
		textTasks: [],
		preservesEmbedding: true,
		documentsProvider: "OPENAI_DIRECT",
		embeddingsModelChanged: false,
	});
	api.setDefault.mockResolvedValue({ success: true, preferencesCleared: 2 });
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const invalidate = vi.spyOn(client, "invalidateQueries");
	render(
		<QueryClientProvider client={client}>
			<NextIntlClientProvider locale="en" messages={en}>
				<OrgAiProvidersSettingsForm />
			</NextIntlClientProvider>
		</QueryClientProvider>,
	);
	fireEvent.click(
		(await screen.findAllByRole("button", { name: /Set Default/i }))[0],
	);
	expect(api.setDefault).not.toHaveBeenCalled();
	const dialog = await screen.findByRole("alertdialog");
	await waitFor(() =>
		expect(api.preview).toHaveBeenCalledWith({
			organizationId: "example-org",
			provider: "OPENAI_DIRECT",
		}),
	);
	expect(within(dialog).getByRole("combobox")).toHaveTextContent("OpenAI");
	const confirm = within(dialog).getByRole("button", {
		name: "Make default",
	});
	expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
	await waitFor(() => expect(confirm).not.toBeDisabled());
	fireEvent.click(confirm);
	await waitFor(() =>
		expect(api.setDefault).toHaveBeenCalledWith({
			organizationId: "example-org",
			provider: "OPENAI_DIRECT",
		}),
	);
	for (const key of [
		"aiConfigStatus",
		"aiAvailableModels",
		"aiTaskDefaults",
		"aiOrgPreferences",
	]) {
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: [key, "example-org"],
		});
	}
});

it("never offers Set Default for a provider outside the server's valid targets", async () => {
	api.status.mockResolvedValue({
		isConfigured: true,
		defaultProvider: "ANTHROPIC_DIRECT",
		configuredProviders: [
			{
				provider: "ANTHROPIC_DIRECT",
				displayName: "Anthropic",
				isDefault: true,
				purpose: "ALL",
			},
			{
				provider: "OPENAI_DIRECT",
				displayName: "OpenAI",
				isDefault: false,
				purpose: "ALL",
			},
		],
		message: "Example providers configured",
	});
	api.preview.mockResolvedValue({
		validProviders: [{ provider: "ANTHROPIC_DIRECT" }],
		currentProvider: "ANTHROPIC_DIRECT",
		targetProvider: null,
		textTasks: [],
		keptPreferences: [],
		removedPreferences: [],
		embeddingsModelChanged: false,
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<NextIntlClientProvider locale="en" messages={en}>
				<OrgAiProvidersSettingsForm />
			</NextIntlClientProvider>
		</QueryClientProvider>,
	);
	await screen.findByText("AI Providers Configured");
	await waitFor(() =>
		expect(api.preview).toHaveBeenCalledWith({
			organizationId: "example-org",
		}),
	);
	expect(screen.queryByRole("button", { name: /Set Default/i })).toBeNull();
});
