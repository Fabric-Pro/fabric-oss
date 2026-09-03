/**
 * Spotlight exit routing — a spotlight closes back to wherever it was opened
 * from.
 *
 * Two surfaces raise the single-component spotlight and they need different
 * exits:
 *
 *   - The drawer's "Show me" (`onShowComponent`) — the user was reading the
 *     drawer, so "Got it" hands them back to it.
 *   - `GET_STARTED_SPOTLIGHT_EVENT`, raised by a surface outside the drawer
 *     (the readiness checklist is the first caller) — the user never opened
 *     the drawer, so "Got it" must close to nothing. Opening the drawer here
 *     covers the very component the callout just pointed at.
 *
 * Both exits ran through one `setMode("drawer")`, so dismissing a readiness
 * callout opened a drawer the user never asked for.
 *
 * `GetStartedDrawer` / `GetStartedSpotlight` are minimal stubs: this is about
 * the CONTROLLER's mode routing, not their rendering.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configure, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act, useState as useMockFlagState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	GET_STARTED_OPEN_EVENT,
	GET_STARTED_SPOTLIGHT_EVENT,
	type SpotlightEventDetail,
} from "../../lib/tour-steps";

configure({ asyncUtilTimeout: 5000 });

// ----------------------------------------------------------------------------
// Mocks — defined BEFORE the import of GetStartedController.
// ----------------------------------------------------------------------------

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: { id: "user-1", name: "Test User" },
		session: { id: "test-session" },
		loaded: true,
		reloadSession: vi.fn(),
	}),
}));

const getState = vi.fn();
const update = vi.fn();
const getMyDefault = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		users: {
			onboarding: {
				getState: (...args: unknown[]) => getState(...args),
				update: (...args: unknown[]) => update(...args),
			},
		},
		functionTags: { setMyDefault: vi.fn() },
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		functionTags: {
			getMyDefault: {
				queryOptions: () => ({
					queryKey: ["ft", "getMyDefault"],
					queryFn: getMyDefault,
				}),
			},
		},
		projects: {
			tabVisibility: {
				get: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.tabVisibility.get", input],
						queryFn: async () => ({ config: null }),
					}),
				},
			},
			tabPreferences: {
				get: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.tabPreferences.get", input],
						queryFn: async () => ({ prefs: null }),
					}),
				},
			},
		},
	},
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => {
		const [value] = useMockFlagState(false);
		// Publishing Suite is a different gate from the one this file drives.
		// Answering per key keeps a future flip of the shared value from
		// switching it on as a side effect.
		return key === "PUBLISHING_SUITE" ? false : value;
	},
}));
vi.mock("@saas/shared/components/RoleTagSnapshotProvider", () => ({
	useRoleTagSnapshot: () => false,
}));

// The drawer stub exposes "Show me" so a test can take the drawer-originated
// path through the very same spotlight the event path uses.
vi.mock("../GetStartedDrawer", () => ({
	GetStartedDrawer: ({
		onClose,
		onShowComponent,
	}: {
		onClose: () => void;
		onShowComponent: (item: unknown) => void;
	}) => (
		<div data-testid="drawer">
			<button type="button" onClick={onClose}>
				Close drawer
			</button>
			<button
				type="button"
				onClick={() =>
					onShowComponent({
						id: "projects",
						label: "Projects",
						description: "Where the work lives.",
						icon: () => null,
						anchor: "nav-projects",
					})
				}
			>
				Show me
			</button>
		</div>
	),
}));
vi.mock("../GetStartedWelcomeDialog", () => ({
	GetStartedWelcomeDialog: ({ onDismiss }: { onDismiss: () => void }) => (
		<div data-testid="welcome">
			<button type="button" onClick={onDismiss}>
				Explore alone
			</button>
		</div>
	),
}));
vi.mock("../GetStartedSpotlight", () => ({
	GetStartedSpotlight: (props: {
		onFinish: () => void;
		onDismiss: () => void;
	}) => (
		<div data-testid="spotlight">
			<button type="button" onClick={props.onFinish}>
				Got it
			</button>
			<button type="button" onClick={props.onDismiss}>
				Dismiss
			</button>
		</div>
	),
}));

import {
	DEFAULT_TOUR_STATE,
	makeOnboardingStateData as makeStateData,
} from "../../lib/__tests__/onboarding-state-fixtures";
import { GetStartedController } from "../GetStartedController";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function renderController() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<GetStartedController />
		</QueryClientProvider>,
	);
}

/** Raise a spotlight the way the readiness checklist does. */
async function dispatchSpotlight() {
	await act(async () => {
		window.dispatchEvent(
			new CustomEvent<SpotlightEventDetail>(GET_STARTED_SPOTLIGHT_EVENT, {
				detail: {
					anchorId: "context-add",
					projectTab: "context",
					title: "Add your first context source",
					body: "Upload a file, paste a link or a note here.",
				},
			}),
		);
	});
}

async function openDrawer() {
	await act(async () => {
		window.dispatchEvent(new CustomEvent(GET_STARTED_OPEN_EVENT));
	});
}

beforeEach(() => {
	getState.mockReset();
	update.mockReset();
	getMyDefault.mockReset();
	getMyDefault.mockResolvedValue({ tags: [] });
	update.mockResolvedValue({ state: DEFAULT_TOUR_STATE });
	// A settled user: no welcome dialog, no auto-launch, no tags prompt — the
	// spotlight is the only surface these tests put on screen.
	getState.mockResolvedValue(
		makeStateData({
			state: { autoLaunched: true },
			eligibleForAutoLaunch: false,
			eligibleForFunctionTagsPrompt: false,
		}),
	);
	sessionStorage.clear();
});

describe("GetStartedController — spotlight exits where it came from", () => {
	it("closes to nothing when the spotlight was raised outside the drawer", async () => {
		const user = userEvent.setup();
		renderController();

		await dispatchSpotlight();
		expect(await screen.findByTestId("spotlight")).toBeInTheDocument();
		// Precondition: this path never went through the drawer.
		expect(screen.queryByTestId("drawer")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Got it" }));

		await waitFor(() => {
			expect(screen.queryByTestId("spotlight")).not.toBeInTheDocument();
		});
		expect(screen.queryByTestId("drawer")).not.toBeInTheDocument();
	});

	it("closes to nothing on Dismiss too, not just Got it", async () => {
		const user = userEvent.setup();
		renderController();

		await dispatchSpotlight();
		expect(await screen.findByTestId("spotlight")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Dismiss" }));

		await waitFor(() => {
			expect(screen.queryByTestId("spotlight")).not.toBeInTheDocument();
		});
		expect(screen.queryByTestId("drawer")).not.toBeInTheDocument();
	});

	it("returns to the drawer when the spotlight came from the drawer's Show me", async () => {
		const user = userEvent.setup();
		renderController();

		await openDrawer();
		expect(await screen.findByTestId("drawer")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Show me" }));
		expect(await screen.findByTestId("spotlight")).toBeInTheDocument();
		expect(screen.queryByTestId("drawer")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Got it" }));

		// The drawer the user was reading comes back — unchanged behaviour.
		expect(await screen.findByTestId("drawer")).toBeInTheDocument();
		expect(screen.queryByTestId("spotlight")).not.toBeInTheDocument();
	});

	it("does not leak drawer origin from an earlier Show me into a later event spotlight", async () => {
		const user = userEvent.setup();
		renderController();

		// First: the drawer path, run to completion.
		await openDrawer();
		await user.click(
			await screen.findByRole("button", { name: "Show me" }),
		);
		await user.click(screen.getByRole("button", { name: "Got it" }));
		await user.click(
			await screen.findByRole("button", { name: "Close drawer" }),
		);
		await waitFor(() => {
			expect(screen.queryByTestId("drawer")).not.toBeInTheDocument();
		});

		// Then: the readiness-checklist path must still close to nothing.
		await dispatchSpotlight();
		expect(await screen.findByTestId("spotlight")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Got it" }));

		await waitFor(() => {
			expect(screen.queryByTestId("spotlight")).not.toBeInTheDocument();
		});
		expect(screen.queryByTestId("drawer")).not.toBeInTheDocument();
	});
});
