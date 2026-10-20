/**
 * "Use when the ChatGPT plan is spent" on a personal key (Fizzy #3085): every
 * key on the Personal tab that may serve LLM work carries the switch, never
 * an embeddings-only key, and only while CHATGPT_PLAN is on. Turning it
 * saves the opt-in for that provider alone.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetStatus, mockSetPlanSpentFallback, flags } = vi.hoisted(() => ({
	mockGetStatus: vi.fn(),
	mockSetPlanSpentFallback: vi.fn(),
	flags: { current: {} as Record<string, boolean> },
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
				setPlanSpentFallback: mockSetPlanSpentFallback,
				delete: vi.fn(),
				getConfig: vi.fn(),
				updateEnabled: vi.fn(),
			},
		},
	},
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => flags.current[key] === true,
}));

vi.mock("@saas/settings/hooks/use-return-to-redirect", () => ({
	useReturnToRedirect: () => ({ triggerReturn: vi.fn() }),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AiProvidersSettingsForm } from "../../modules/saas/settings/components/AiProvidersSettingsForm";

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

function personalKey(overrides: Record<string, unknown>) {
	return {
		displayName: null,
		isDefault: false,
		isEmbeddingProvider: false,
		purpose: "ALL",
		useWhenPlanSpent: false,
		source: "user_config",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	flags.current = { CHATGPT_PLAN: true };
	mockGetStatus.mockResolvedValue({
		isConfigured: true,
		message: "",
		configuredProviders: [
			personalKey({
				provider: "OPENAI_DIRECT",
				isDefault: true,
				useWhenPlanSpent: true,
			}),
			personalKey({
				provider: "ANTHROPIC_DIRECT",
			}),
			personalKey({
				provider: "VOYAGE_AI",
				isEmbeddingProvider: true,
				purpose: "EMBEDDINGS_ONLY",
			}),
		],
		embeddingProvider: "VOYAGE_AI",
		embeddingModel: null,
		planSpentPersonalProvider: "OPENAI_DIRECT",
	});
	mockSetPlanSpentFallback.mockResolvedValue({ useWhenPlanSpent: false });
});

describe("personal key — Use when the ChatGPT plan is spent", () => {
	it("is offered on every key that may serve LLM work, never on an embeddings-only key", async () => {
		renderForm();

		await waitFor(() =>
			expect(
				screen.getAllByTestId("plan-spent-fallback-toggle"),
			).toHaveLength(2),
		);
		const switches = screen
			.getAllByTestId("plan-spent-fallback-toggle")
			.map((toggle) => toggle.querySelector("button[role='switch']"));
		expect(switches.map((s) => s?.getAttribute("aria-checked"))).toEqual(
			expect.arrayContaining(["true", "false"]),
		);
		expect(screen.getAllByText("toggleLabel").length).toBeGreaterThan(0);
	});

	it("saves the opt-in for that key's provider", async () => {
		renderForm();

		await waitFor(() =>
			expect(
				screen.getAllByTestId("plan-spent-fallback-toggle"),
			).toHaveLength(2),
		);
		const checked = screen
			.getAllByTestId("plan-spent-fallback-toggle")
			.map((toggle) => toggle.querySelector("button[role='switch']"))
			.find((s) => s?.getAttribute("aria-checked") === "true");
		if (!checked) {
			throw new Error("No opted-in key found");
		}
		fireEvent.click(checked);

		await waitFor(() =>
			expect(mockSetPlanSpentFallback).toHaveBeenCalledWith({
				provider: "OPENAI_DIRECT",
				useWhenPlanSpent: false,
			}),
		);
	});

	it("is hidden while CHATGPT_PLAN is off", async () => {
		flags.current = {};
		renderForm();

		await waitFor(() => expect(mockGetStatus).toHaveBeenCalled());
		await screen.findAllByText(/reconfigure/i);
		expect(screen.queryByTestId("plan-spent-fallback-toggle")).toBeNull();
	});
});
