import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setFavorite = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { setFavorite: (...args: unknown[]) => setFavorite(...args) },
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationId: () => "org-1",
}));

// Only the query KEYS are used here, so stable stand-ins are enough.
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			list: { key: () => [["projects", "list"]] },
			get: { key: () => [["projects", "get"], { input: { id: "p1" } }] },
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { error: (...args: unknown[]) => toastError(...args) },
}));

import type { FeatureFlagKey } from "@repo/utils";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { ProjectFavoriteToggle } from "../ProjectFavoriteToggle";

function renderToggle({
	isFavorite = false,
	flagOn = true,
}: {
	isFavorite?: boolean;
	flagOn?: boolean;
} = {}) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const invalidate = vi.spyOn(queryClient, "invalidateQueries");

	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			<FeatureFlagProvider
				value={
					{ PROJECT_FAVORITES: flagOn } as Record<
						FeatureFlagKey,
						boolean
					>
				}
			>
				{children}
			</FeatureFlagProvider>
		</QueryClientProvider>
	);

	const utils = render(
		<ProjectFavoriteToggle
			projectId="p1"
			projectName="Atlas"
			isFavorite={isFavorite}
		/>,
		{ wrapper },
	);
	return { ...utils, invalidate };
}

beforeEach(() => {
	vi.clearAllMocks();
	setFavorite.mockResolvedValue({ favorited: true });
});

describe("ProjectFavoriteToggle", () => {
	it("does not render while the feature flag is off", () => {
		renderToggle({ flagOn: false });

		expect(screen.queryByRole("button")).toBeNull();
	});

	it("names both the action and the project, and swaps with state", () => {
		const { rerender } = renderToggle({ isFavorite: false });

		expect(
			screen.getByRole("button", { name: "Add Atlas to favorites" }),
		).toBeInTheDocument();

		rerender(
			<ProjectFavoriteToggle
				projectId="p1"
				projectName="Atlas"
				isFavorite={true}
			/>,
		);
		expect(
			screen.getByRole("button", { name: "Remove Atlas from favorites" }),
		).toBeInTheDocument();
	});

	it("reports its on/off state to assistive technology", () => {
		renderToggle({ isFavorite: true });

		expect(screen.getByRole("button")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});

	it("sends the project id and the resolved tenant", async () => {
		renderToggle({ isFavorite: false });

		await userEvent.click(screen.getByRole("button"));

		expect(setFavorite).toHaveBeenCalledWith({
			projectId: "p1",
			favorited: true,
			organizationId: "org-1",
		});
	});

	it("flips optimistically while the write is still in flight", async () => {
		let settle: (value: unknown) => void = () => {};
		setFavorite.mockReturnValue(
			new Promise((resolve) => {
				settle = resolve;
			}),
		);
		renderToggle({ isFavorite: false });

		await userEvent.click(screen.getByRole("button"));

		// The user sees the new state without waiting for the round trip. After it
		// settles the control falls back to its prop, which the invalidated
		// queries refresh.
		await waitFor(() => {
			expect(screen.getByRole("button")).toHaveAttribute(
				"aria-pressed",
				"true",
			);
		});
		settle({ favorited: true });
	});

	it("rolls back and offers a retry when the write fails", async () => {
		setFavorite.mockRejectedValue(new Error("nope"));
		renderToggle({ isFavorite: false });

		await userEvent.click(screen.getByRole("button"));

		await waitFor(() => {
			expect(toastError).toHaveBeenCalled();
		});
		expect(toastError.mock.calls[0][1].action.label).toBe("Retry");
		expect(screen.getByRole("button")).toHaveAttribute(
			"aria-pressed",
			"false",
		);
	});

	// Regression: the shortcut query is registered under the tenant-prefixed key
	// `["tenant", orgId, ...base]`. A flat `["projects","shortcuts"]` filter is
	// compared from index zero and matches nothing, so the sub-nav would keep
	// serving a stale list until a full reload.
	it("invalidates the shortcut query under its tenant-prefixed key", async () => {
		const { invalidate } = renderToggle({ isFavorite: false });

		await userEvent.click(screen.getByRole("button"));

		await waitFor(() => {
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: ["tenant", "org-1", "projects", "shortcuts"],
			});
		});
	});

	it("does not invalidate anything when the write fails", async () => {
		setFavorite.mockRejectedValue(new Error("nope"));
		const { invalidate } = renderToggle({ isFavorite: false });

		await userEvent.click(screen.getByRole("button"));

		await waitFor(() => {
			expect(toastError).toHaveBeenCalled();
		});
		// Nothing changed server-side, so refetching would return what is cached.
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("stays reachable without hover, so touch and keyboard both work", () => {
		renderToggle({ isFavorite: false });

		const button = screen.getByRole("button");
		// A bare `opacity-0` would leave an invisible but hit-testable control on
		// a card whose own tap navigates away.
		expect(button.className).toContain("focus-visible:opacity-100");
		expect(button.className).toContain("pointer-coarse:opacity-100");
	});
});
