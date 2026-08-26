import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Translation mock — return the key with serialised params so assertions
// can match `"rowEnforcementHard"` directly (matches the precedent in
// `EmailNotVerifiedAlert.test.tsx`).
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

const useAiUsageLimitsMock = vi.fn();
const useAiUsageLimitsStatusMock = vi.fn();

vi.mock("@saas/payments/hooks/useAiUsageLimits", async () => {
	const actual = await vi.importActual<
		typeof import("@saas/payments/hooks/useAiUsageLimits")
	>("@saas/payments/hooks/useAiUsageLimits");
	return {
		...actual,
		useAiUsageLimits: (...args: unknown[]) =>
			useAiUsageLimitsMock(...args) ?? {
				data: undefined,
				isLoading: true,
				isError: false,
				error: null,
			},
		useAiUsageLimitsStatus: (...args: unknown[]) =>
			useAiUsageLimitsStatusMock(...args) ?? {
				data: undefined,
				isLoading: true,
				isError: false,
				error: null,
			},
	};
});

// Stub the edit Sheet so this test stays focused on the card's branches.
vi.mock("../AiUsageLimitEditSheet", () => ({
	AiUsageLimitEditSheet: ({
		open,
		existing,
	}: {
		open: boolean;
		existing?: { id: string } | null;
	}) =>
		open ? (
			<div
				data-testid="edit-sheet"
				data-mode={existing ? "edit" : "create"}
				data-existing-id={existing?.id ?? ""}
			/>
		) : null,
}));

// The card looks up project names via orpcClient.projects.list when any
// row carries a projectId. Stub the client surface to avoid real fetches
// in jsdom — tests that don't exercise project-scoped limits never trigger
// it (the useQuery is `enabled: hasProjectScopedLimit`).
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			list: vi.fn().mockResolvedValue({ projects: [] }),
		},
	},
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AiUsageLimitsCard } from "../AiUsageLimitsCard";

// Helper — the card now uses useQuery for the project-name lookup, so
// every render needs a QueryClient in scope.
function renderWithQueryClient(ui: React.ReactElement) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const result = render(
		<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
	);
	// Wrap the rerender so existing callers that pass the unwrapped UI
	// element still hit the QueryClientProvider on update.
	const originalRerender = result.rerender;
	return {
		...result,
		rerender: (nextUi: React.ReactElement) =>
			originalRerender(
				<QueryClientProvider client={queryClient}>
					{nextUi}
				</QueryClientProvider>,
			),
	};
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

const PERSONAL_LIMIT_TOKENS = {
	id: "limit-1",
	organizationId: null,
	userId: "user-1",
	name: "Daily token cap",
	providerConfigId: null,
	modelCanonicalName: null,
	taskType: null,
	dimension: "TOKENS" as const,
	window: "DAILY" as const,
	maxValue: "100000",
	enforcement: "HARD" as const,
	createdById: "user-1",
	createdAt: new Date("2026-05-14T00:00:00Z").toISOString(),
};

const PERSONAL_LIMIT_SPEND = {
	id: "limit-2",
	organizationId: null,
	userId: "user-1",
	name: null,
	providerConfigId: null,
	modelCanonicalName: null,
	taskType: null,
	dimension: "SPEND_USD" as const,
	window: "MONTHLY" as const,
	maxValue: (BigInt(100) * BigInt(1_000_000)).toString(),
	enforcement: "SOFT" as const,
	createdById: "user-1",
	createdAt: new Date("2026-05-14T00:00:00Z").toISOString(),
};

function buildStatus(
	limit: typeof PERSONAL_LIMIT_TOKENS,
	overrides: { currentValue: string; percent: number },
) {
	return {
		limit,
		currentValue: overrides.currentValue,
		percent: overrides.percent,
		windowStart: new Date("2026-05-14T00:00:00Z").toISOString(),
		windowEnd: new Date("2026-05-15T00:00:00Z").toISOString(),
		timezone: "America/Los_Angeles",
	};
}

function setListResult(data: unknown, options?: { isLoading?: boolean }) {
	useAiUsageLimitsMock.mockReturnValue({
		data,
		isLoading: options?.isLoading ?? false,
		isError: false,
		error: null,
	});
}

function setStatusResult(data: unknown, options?: { isLoading?: boolean }) {
	useAiUsageLimitsStatusMock.mockReturnValue({
		data,
		isLoading: options?.isLoading ?? false,
		isError: false,
		error: null,
	});
}

beforeEach(() => {
	useAiUsageLimitsMock.mockReset();
	useAiUsageLimitsStatusMock.mockReset();
});

describe("AiUsageLimitsCard", () => {
	it("renders the editorial section label and the manage button when canManage", () => {
		setListResult({ limits: [], canManage: true });
		setStatusResult({ statuses: [] });

		renderWithQueryClient(<AiUsageLimitsCard canManage />);

		// Editorial section label is the i18n key (mocked translator
		// returns key as text).
		expect(screen.getByText("sectionLabel")).toBeInTheDocument();
		// "Manage limits" button is visible.
		expect(
			screen.getByRole("button", { name: "manageButton" }),
		).toBeInTheDocument();
	});

	it("renders the empty-state CTA only when canManage", () => {
		setListResult({ limits: [], canManage: true });
		setStatusResult({ statuses: [] });

		const { rerender } = renderWithQueryClient(
			<AiUsageLimitsCard canManage />,
		);

		// CTA appears when the user can manage.
		expect(
			screen.getByRole("button", { name: "emptyCta" }),
		).toBeInTheDocument();
		expect(screen.getByText("emptyBody")).toBeInTheDocument();

		// Re-render in member context — CTA must disappear.
		rerender(<AiUsageLimitsCard canManage={false} />);

		expect(
			screen.queryByRole("button", { name: "emptyCta" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "manageButton" }),
		).not.toBeInTheDocument();
	});

	it("renders one row per limit with the matching progress class for <80%, 80-99%, and >=100%", () => {
		const lowLimit = { ...PERSONAL_LIMIT_TOKENS, id: "low" };
		const warnLimit = { ...PERSONAL_LIMIT_TOKENS, id: "warn" };
		const overLimit = { ...PERSONAL_LIMIT_TOKENS, id: "over" };

		setListResult({
			limits: [lowLimit, warnLimit, overLimit],
			canManage: true,
		});
		setStatusResult({
			statuses: [
				buildStatus(lowLimit, { currentValue: "10000", percent: 10 }),
				buildStatus(warnLimit, { currentValue: "85000", percent: 85 }),
				buildStatus(overLimit, {
					currentValue: "120000",
					percent: 120,
				}),
			],
		});

		renderWithQueryClient(<AiUsageLimitsCard canManage />);

		const progressBars = screen.getAllByRole("progressbar");
		expect(progressBars).toHaveLength(3);

		// The fill class is applied to the inner div — query by descendant.
		const [lowBar, warnBar, overBar] = progressBars;
		expect(lowBar?.firstChild).toHaveClass("bg-primary");
		expect(warnBar?.firstChild).toHaveClass("bg-highlight");
		expect(overBar?.firstChild).toHaveClass("bg-destructive");
	});

	it("opens the edit Sheet with the row's limit when a row is clicked (canManage)", async () => {
		const user = userEvent.setup();
		setListResult({
			limits: [PERSONAL_LIMIT_TOKENS],
			canManage: true,
		});
		setStatusResult({
			statuses: [
				buildStatus(PERSONAL_LIMIT_TOKENS, {
					currentValue: "10000",
					percent: 10,
				}),
			],
		});

		renderWithQueryClient(<AiUsageLimitsCard canManage />);

		// The whole row is a single button — its `aria-label` carries the
		// `rowEditAriaLabel:name=…` key from the i18n mock.
		const rowButton = screen.getByRole("button", {
			name: /^rowEditAriaLabel:name=Daily token cap/i,
		});
		await user.click(rowButton);

		const sheet = await screen.findByTestId("edit-sheet");
		expect(sheet).toHaveAttribute("data-mode", "edit");
		expect(sheet).toHaveAttribute("data-existing-id", "limit-1");
	});

	it("opens the edit Sheet in create mode when the Manage button is clicked", async () => {
		const user = userEvent.setup();
		setListResult({ limits: [], canManage: true });
		setStatusResult({ statuses: [] });

		renderWithQueryClient(<AiUsageLimitsCard canManage />);

		const button = screen.getByRole("button", { name: "manageButton" });
		await user.click(button);

		const sheet = await screen.findByTestId("edit-sheet");
		expect(sheet).toHaveAttribute("data-mode", "create");
	});

	it("hides the manage and per-row edit affordances when canManage=false", () => {
		setListResult({
			limits: [PERSONAL_LIMIT_TOKENS],
			canManage: false,
		});
		setStatusResult({
			statuses: [
				buildStatus(PERSONAL_LIMIT_TOKENS, {
					currentValue: "10000",
					percent: 10,
				}),
			],
		});

		renderWithQueryClient(<AiUsageLimitsCard canManage={false} />);

		// No manage button.
		expect(
			screen.queryByRole("button", { name: "manageButton" }),
		).not.toBeInTheDocument();
		// No row-level button at all when canManage=false (the row is
		// rendered as a non-interactive `<div>`).
		expect(
			screen.queryByRole("button", {
				name: /^rowEditAriaLabel/,
			}),
		).not.toBeInTheDocument();
	});

	it("renders the SOFT enforcement pill when enforcement is SOFT", () => {
		setListResult({
			limits: [PERSONAL_LIMIT_SPEND],
			canManage: true,
		});
		setStatusResult({
			statuses: [
				buildStatus(PERSONAL_LIMIT_SPEND, {
					currentValue: (BigInt(50) * BigInt(1_000_000)).toString(),
					percent: 50,
				}),
			],
		});

		renderWithQueryClient(<AiUsageLimitsCard canManage />);

		// Soft pill text comes from the mocked translator key.
		expect(screen.getByText("rowEnforcementSoft")).toBeInTheDocument();
		expect(
			screen.queryByText("rowEnforcementHard"),
		).not.toBeInTheDocument();
	});

	it("falls back to an auto-generated name when limit.name is null", () => {
		setListResult({
			limits: [PERSONAL_LIMIT_SPEND],
			canManage: true,
		});
		setStatusResult({
			statuses: [
				buildStatus(PERSONAL_LIMIT_SPEND, {
					currentValue: "0",
					percent: 0,
				}),
			],
		});

		renderWithQueryClient(<AiUsageLimitsCard canManage />);

		// `null` name → "Monthly spend" fallback per `fallbackLimitName`.
		expect(screen.getByText(/Monthly spend/i)).toBeInTheDocument();
	});

	it("renders skeleton rows while loading", () => {
		setListResult(undefined, { isLoading: true });
		setStatusResult(undefined, { isLoading: true });

		const { container } = renderWithQueryClient(
			<AiUsageLimitsCard canManage />,
		);

		// Skeleton rows are non-interactive; assert at least one is present.
		const skeletons = container.querySelectorAll(".animate-pulse");
		expect(skeletons.length).toBeGreaterThan(0);
	});

	it("renders the used/max label using the rowUsedOfMax i18n key with placeholders", () => {
		setListResult({
			limits: [PERSONAL_LIMIT_TOKENS],
			canManage: true,
		});
		setStatusResult({
			statuses: [
				buildStatus(PERSONAL_LIMIT_TOKENS, {
					currentValue: "45200",
					percent: 45,
				}),
			],
		});

		renderWithQueryClient(<AiUsageLimitsCard canManage />);

		// The mocked translator serialises params — assert the formatted
		// 45.2k / 100.0k tokens label is present (proves `rowUsedOfMax` is
		// invoked with the right `used`, `max`, and `unit` placeholders).
		expect(
			screen.getByText(
				/rowUsedOfMax:used=45\.2k:max=100\.0k:unit=tokens/,
			),
		).toBeInTheDocument();
	});
});
