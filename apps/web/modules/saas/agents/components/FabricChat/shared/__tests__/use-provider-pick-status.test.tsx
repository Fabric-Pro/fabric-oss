import {
	focusManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	chatModelQueryOptions,
	useProviderPickStatus,
} from "../use-provider-pick-status";

const models = vi.hoisted(() => vi.fn());
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { aiConfig: { models: { listAvailable: models } } },
}));

const provider = { agentId: "model:claude-sonnet-5", name: "Claude Sonnet 5" };
const planPick = { agentId: "plan-model:gpt-6-astra", name: "GPT-6 Astra" };

function harness() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return { client, wrapper };
}

describe("provider pick status outside the popover", () => {
	it("fetches while closed, shares the picker cache, and restores the saved pick when a fallback takes over", async () => {
		models.mockReset().mockResolvedValue({
			models: [],
			chatgptPlan: {
				source: "shared",
				spent: { until: null },
				models: [],
			},
		});
		const { client, wrapper } = harness();
		const { result } = renderHook(
			() => useProviderPickStatus("example-org", [provider, planPick]),
			{ wrapper },
		);
		await waitFor(() =>
			expect(result.current.inactiveProviderPicks).toEqual([provider]),
		);
		expect(result.current.source).toBe("shared");
		expect(result.current.getInactiveNote(planPick)).toBeUndefined();
		expect(
			client.getQueryData(chatModelQueryOptions("example-org").queryKey),
		).toMatchObject({ chatgptPlan: { source: "shared" } });
		expect(models).toHaveBeenCalledTimes(1);
		expect(models).toHaveBeenCalledWith({
			organizationId: "example-org",
			taskType: "CHAT",
			planTaskType: "TOOL_CALLING",
		});
		models.mockResolvedValue({
			models: [{ canonicalName: "claude-sonnet-5" }],
			chatgptPlan: null,
		});
		act(() => {
			focusManager.setFocused(false);
			focusManager.setFocused(true);
		});
		await waitFor(() =>
			expect(result.current.inactiveProviderPicks).toEqual([]),
		);
		expect(result.current.getInactiveNote(provider)).toBeUndefined();
		expect(provider.agentId).toBe("model:claude-sonnet-5");
		focusManager.setFocused(undefined);
	});

	it("does not fetch for registered agents or plan picks alone", () => {
		models.mockReset();
		const { wrapper } = harness();
		renderHook(
			() =>
				useProviderPickStatus("example-org", [
					planPick,
					{ agentId: "analyst", name: "Analyst" },
				]),
			{ wrapper },
		);
		expect(models).not.toHaveBeenCalled();
	});
});

it.each([false, true])(
	"checks saved provider availability (listed: %s)",
	async (listed) => {
		models.mockReset().mockResolvedValue({
			models: listed ? [{ canonicalName: "claude-sonnet-5" }] : [],
			chatgptPlan: null,
		});
		const { wrapper } = harness();
		const { result } = renderHook(
			() => useProviderPickStatus("example-org", [provider]),
			{ wrapper },
		);
		await waitFor(() => expect(models).toHaveBeenCalled());
		await waitFor(() =>
			expect(result.current.inactiveProviderPicks).toEqual(
				listed ? [] : [provider],
			),
		);
		expect(result.current.getInactiveNote(provider)).toBe(
			listed
				? undefined
				: "Claude Sonnet 5 isn't available from your organization's AI provider — pick another model.",
		);
	},
);

it.each([
	["plan", { models: [], chatgptPlan: { source: "own", models: [] } }],
	["unlisted", { models: [], chatgptPlan: null }],
] as const)(
	"keeps a %s pick not applied during a background refetch",
	async (_case, listing) => {
		models.mockReset().mockResolvedValue(listing);
		const { wrapper } = harness();
		const { result } = renderHook(
			() => useProviderPickStatus("example-org", [provider]),
			{ wrapper },
		);
		await waitFor(() =>
			expect(result.current.inactiveProviderPicks).toEqual([provider]),
		);
		models.mockImplementation(() => new Promise(() => {}));
		act(() => {
			focusManager.setFocused(false);
			focusManager.setFocused(true);
		});
		await waitFor(() => expect(models).toHaveBeenCalledTimes(2));
		expect(result.current.inactiveProviderPicks).toEqual([provider]);
		expect(result.current.getInactiveNote(provider)).toBeDefined();
		focusManager.setFocused(undefined);
	},
);

it.each(["loading", "error"])(
	"keeps saved picks active during %s",
	async (status) => {
		models
			.mockReset()
			.mockImplementation(() =>
				status === "error"
					? Promise.reject(new Error("unavailable"))
					: new Promise(() => {}),
			);
		const { wrapper } = harness();
		const { result } = renderHook(
			() => useProviderPickStatus("example-org", [provider]),
			{ wrapper },
		);
		await waitFor(() => expect(models).toHaveBeenCalled());
		expect(result.current.inactiveProviderPicks).toEqual([]);
		expect(result.current.getInactiveNote(provider)).toBeUndefined();
	},
);
