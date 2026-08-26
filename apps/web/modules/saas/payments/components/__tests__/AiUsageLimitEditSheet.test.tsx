import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, params?: Record<string, unknown>) => {
		if (params) {
			let result = key;
			for (const [k, v] of Object.entries(params)) {
				result = `${result}:${k}=${v}`;
			}
			return result;
		}
		return key;
	},
}));

// The sheet now prefetches `projects.list` when the user opens it, so any
// `render` would otherwise attempt a real network call against the oRPC
// client. Stub the client surface to a noop that returns an empty list.
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			list: vi.fn().mockResolvedValue({ projects: [] }),
		},
	},
}));

const upsertMutate = vi.fn();
const deleteMutate = vi.fn();
const upsertState = { isPending: false };
const deleteState = { isPending: false };

vi.mock("@saas/payments/hooks/useAiUsageLimits", async () => {
	const actual = await vi.importActual<
		typeof import("@saas/payments/hooks/useAiUsageLimits")
	>("@saas/payments/hooks/useAiUsageLimits");
	return {
		...actual,
		useUpsertAiUsageLimit: () => ({
			mutate: upsertMutate,
			isPending: upsertState.isPending,
		}),
		useDeleteAiUsageLimit: () => ({
			mutate: deleteMutate,
			isPending: deleteState.isPending,
		}),
		// The edit sheet wires Provider + Model selects via this hook —
		// stub to "no providers configured" so the existing tests render
		// without a network call. Tenant-isolation behaviour is exercised
		// by the procedure-level tests.
		useAiUsageLimitProviderOptions: () => ({
			data: { providers: [] },
			isLoading: false,
			isError: false,
		}),
	};
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AiUsageLimitEditSheet } from "../AiUsageLimitEditSheet";

// Helper — the sheet now uses useQueryClient for project-picker prefetch,
// so every render needs a QueryClient in scope. Fresh client per test
// avoids cross-test cache leakage.
function renderWithQueryClient(ui: React.ReactElement) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
	);
}

class ResizeObserverMock {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;

HTMLElement.prototype.hasPointerCapture ??= () => false;
HTMLElement.prototype.setPointerCapture ??= () => {};
HTMLElement.prototype.releasePointerCapture ??= () => {};
HTMLElement.prototype.scrollIntoView ??= () => {};

const EXISTING_LIMIT = {
	id: "limit-1",
	organizationId: null,
	userId: "user-1",
	name: "My limit",
	providerConfigId: null,
	modelCanonicalName: null,
	taskType: null,
	dimension: "TOKENS" as const,
	window: "DAILY" as const,
	maxValue: "50000",
	enforcement: "HARD" as const,
	createdById: "user-1",
	createdAt: new Date("2026-05-14T00:00:00Z").toISOString(),
};

beforeEach(() => {
	upsertMutate.mockReset();
	deleteMutate.mockReset();
	upsertState.isPending = false;
	deleteState.isPending = false;
});

describe("AiUsageLimitEditSheet", () => {
	it("renders the create-mode title and high-concurrency disclaimer", () => {
		renderWithQueryClient(
			<AiUsageLimitEditSheet
				open
				onOpenChange={() => {}}
				existing={null}
			/>,
		);

		expect(screen.getByText("sheetTitleCreate")).toBeInTheDocument();
		// The disclaimer lives in the SheetDescription only — the duplicate
		// footer copy was removed during the UX polish pass.
		expect(
			screen.getByText("highConcurrencyDisclaimer"),
		).toBeInTheDocument();
	});

	it("defaults to SPEND_USD / MONTHLY / HARD on create", () => {
		renderWithQueryClient(
			<AiUsageLimitEditSheet
				open
				onOpenChange={() => {}}
				existing={null}
			/>,
		);

		// SPEND_USD radio is checked by default.
		const spendRadio = screen.getByRole("radio", {
			name: "fieldDimensionSpend",
		});
		expect(spendRadio).toHaveAttribute("data-state", "checked");

		// HARD enforcement radio is checked.
		const hardRadio = screen.getByRole("radio", {
			name: "fieldEnforcementHard",
		});
		expect(hardRadio).toHaveAttribute("data-state", "checked");
	});

	it("rejects empty maxValue with a validation error", async () => {
		const user = userEvent.setup();
		renderWithQueryClient(
			<AiUsageLimitEditSheet
				open
				onOpenChange={() => {}}
				existing={null}
			/>,
		);

		// Submit without entering a max value.
		const saveButton = screen.getByRole("button", {
			name: /^(saveButton|createButton)$/,
		});
		await user.click(saveButton);

		await waitFor(() => {
			expect(screen.getByRole("alert")).toBeInTheDocument();
		});
		expect(upsertMutate).not.toHaveBeenCalled();
	});

	it("rejects negative maxValue with a validation error", async () => {
		const user = userEvent.setup();
		renderWithQueryClient(
			<AiUsageLimitEditSheet
				open
				onOpenChange={() => {}}
				existing={null}
			/>,
		);

		const maxInput = screen.getByLabelText("fieldMaxValue");
		await user.type(maxInput, "-50");
		const saveButton = screen.getByRole("button", {
			name: /^(saveButton|createButton)$/,
		});
		await user.click(saveButton);

		await waitFor(() => {
			expect(screen.getByRole("alert")).toBeInTheDocument();
		});
		expect(upsertMutate).not.toHaveBeenCalled();
	});

	it("submits a valid create payload and closes on success", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		upsertMutate.mockImplementation(
			(
				_input: unknown,
				options?: {
					onSuccess?: () => void;
					onError?: (e: Error) => void;
				},
			) => {
				options?.onSuccess?.();
			},
		);

		renderWithQueryClient(
			<AiUsageLimitEditSheet
				open
				onOpenChange={onOpenChange}
				organizationId="org-1"
				existing={null}
			/>,
		);

		const maxInput = screen.getByLabelText("fieldMaxValue");
		await user.type(maxInput, "100");
		const saveButton = screen.getByRole("button", {
			name: /^(saveButton|createButton)$/,
		});
		await user.click(saveButton);

		await waitFor(() => {
			expect(upsertMutate).toHaveBeenCalledTimes(1);
		});

		const [payload] = upsertMutate.mock.calls[0] as [
			Record<string, unknown>,
			unknown,
		];
		// Defaults (SPEND_USD / MONTHLY / HARD) applied; org id passed
		// through; null filters everywhere.
		expect(payload).toMatchObject({
			organizationId: "org-1",
			dimension: "SPEND_USD",
			window: "MONTHLY",
			enforcement: "HARD",
			maxValue: 100,
			providerConfigId: null,
			modelCanonicalName: null,
			taskType: null,
		});
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("hydrates form state from `existing` in edit mode", () => {
		renderWithQueryClient(
			<AiUsageLimitEditSheet
				open
				onOpenChange={() => {}}
				existing={EXISTING_LIMIT}
			/>,
		);

		expect(screen.getByText("sheetTitleEdit")).toBeInTheDocument();
		// Name pre-filled.
		const nameInput = screen.getByLabelText(
			"fieldName",
		) as HTMLInputElement;
		expect(nameInput.value).toBe("My limit");
		// Tokens dimension selected (not SPEND_USD).
		const tokensRadio = screen.getByRole("radio", {
			name: "fieldDimensionTokens",
		});
		expect(tokensRadio).toHaveAttribute("data-state", "checked");
		// Max value pre-filled with the raw token count.
		const maxInput = screen.getByLabelText(
			"fieldMaxValue",
		) as HTMLInputElement;
		expect(maxInput.value).toBe("50000");
		// Delete button available in edit mode.
		expect(
			screen.getByRole("button", { name: "deleteButton" }),
		).toBeInTheDocument();
	});

	it("surfaces server error inline when the mutation rejects", async () => {
		const user = userEvent.setup();
		upsertMutate.mockImplementation(
			(
				_input: unknown,
				options?: {
					onSuccess?: () => void;
					onError?: (e: Error) => void;
				},
			) => {
				options?.onError?.(
					new Error(
						"A limit already exists for this scope. Edit the existing one or change the filter.",
					),
				);
			},
		);

		renderWithQueryClient(
			<AiUsageLimitEditSheet
				open
				onOpenChange={() => {}}
				existing={null}
			/>,
		);

		const maxInput = screen.getByLabelText("fieldMaxValue");
		await user.type(maxInput, "100");
		const saveButton = screen.getByRole("button", {
			name: /^(saveButton|createButton)$/,
		});
		await user.click(saveButton);

		await waitFor(() => {
			expect(
				screen.getByText(/A limit already exists for this scope/i),
			).toBeInTheDocument();
		});
	});

	it("delete button opens AlertDialog and calls deleteMutation on confirm", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		deleteMutate.mockImplementation(
			(
				_input: unknown,
				options?: {
					onSuccess?: () => void;
					onError?: (e: Error) => void;
				},
			) => {
				options?.onSuccess?.();
			},
		);

		renderWithQueryClient(
			<AiUsageLimitEditSheet
				open
				onOpenChange={onOpenChange}
				existing={EXISTING_LIMIT}
			/>,
		);

		const deleteButton = screen.getByRole("button", {
			name: "deleteButton",
		});
		await user.click(deleteButton);

		// Confirm dialog appears.
		const confirmDialog = await screen.findByRole("alertdialog");
		expect(
			within(confirmDialog).getByText("deleteConfirmTitle"),
		).toBeInTheDocument();
		expect(
			within(confirmDialog).getByText("deleteConfirmBody"),
		).toBeInTheDocument();

		// Confirm.
		const confirmButton = within(confirmDialog).getByRole("button", {
			name: "deleteConfirmConfirm",
		});
		await user.click(confirmButton);

		await waitFor(() => {
			expect(deleteMutate).toHaveBeenCalledTimes(1);
		});
		const [payload] = deleteMutate.mock.calls[0] as [
			{ id: string; organizationId: string | null },
			unknown,
		];
		expect(payload).toEqual({ id: "limit-1", organizationId: null });
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("converts SPEND_USD dollar input to integer dollars on submit (server multiplies by 1e6)", async () => {
		const user = userEvent.setup();
		upsertMutate.mockImplementation(
			(
				_input: unknown,
				options?: {
					onSuccess?: () => void;
					onError?: (e: Error) => void;
				},
			) => {
				options?.onSuccess?.();
			},
		);

		renderWithQueryClient(
			<AiUsageLimitEditSheet
				open
				onOpenChange={() => {}}
				existing={null}
			/>,
		);

		const maxInput = screen.getByLabelText("fieldMaxValue");
		await user.type(maxInput, "50.99");
		const saveButton = screen.getByRole("button", {
			name: /^(saveButton|createButton)$/,
		});
		await user.click(saveButton);

		await waitFor(() => {
			expect(upsertMutate).toHaveBeenCalledTimes(1);
		});
		const [payload] = upsertMutate.mock.calls[0] as [
			Record<string, unknown>,
			unknown,
		];
		// Decimals are rounded to whole-dollar so the wire schema's
		// integer constraint is satisfied. Server does the *1e6 conversion.
		expect(payload.maxValue).toBe(51);
	});

	it("renders the high-concurrency disclaimer once in the Sheet description", () => {
		renderWithQueryClient(
			<AiUsageLimitEditSheet
				open
				onOpenChange={() => {}}
				existing={null}
			/>,
		);

		// Single occurrence — the duplicate footer copy was removed in the
		// UX polish pass; only the SheetDescription carries the disclaimer.
		expect(screen.getAllByText("highConcurrencyDisclaimer")).toHaveLength(
			1,
		);
	});
});
