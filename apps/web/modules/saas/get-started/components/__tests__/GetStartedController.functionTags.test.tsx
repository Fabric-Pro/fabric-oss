/**
 * FR4 recurring no-tags prompt — controller wiring.
 *
 * `GetStartedDrawer` and `GetStartedSpotlight` are mocked to minimal stubs:
 * this suite is about the CONTROLLER's mode/effect wiring around the tags
 * prompt (eligibility derivation, drawer sequencing, per-tab-session guard,
 * opt-out chaining), not those components' own rendering.
 *
 * Coverage:
 *   1. Opens for an eligible, drawer-settled user not shown this session.
 *   2. Opens for an existing (non-auto-launch-cohort) user with no tags.
 *   3. eligibleForFunctionTagsPrompt: false → no prompt.
 *   4. sessionStorage shown-flag set for this user → no prompt.
 *   5. Per-user key: another user's shown flag does not suppress this user.
 *   6. Sequencing: opens only after the first-login welcome dialog closes.
 *   7. No reopen after Save / "Not now" (session flag) and page tour unblocks.
 *   8. optOutFunctionTagsPrompt serializes with markPageSeen via chainRef.
 *   9. Re-seeds the shown flag on an in-place user-id change (Codex F1).
 *
 * Fizzy #2264 (ROLE_TAG_ENFORCEMENT stand-down):
 *  10. Enforcement on → this prompt never renders (the blocking gate covers
 *      the same user instead).
 *  11. Enforcement off → this prompt still renders exactly as before.
 *  12. A loading → eligible transition does not crash on a hook-order change.
 *  13. The page-tour auto-open stands down while the gate is up
 *      (`roleTagGateUp`), and resumes once the user has tags even with
 *      enforcement still on.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	configure,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act, useState as useMockFlagState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	GET_STARTED_OPEN_EVENT,
	GET_STARTED_PROJECT_TAB_EVENT,
	GET_STARTED_SURFACE_EVENT,
	GET_STARTED_TOUR_PAGE_EVENT,
	type SurfaceEventDetail,
} from "../../lib/tour-steps";

// This suite uses REAL timers (the 900ms page-tour delay) and drives
// multi-step promise-chains through `waitFor`. Raise the async-util timeout
// above the 1000ms default so the chain assertions have headroom on the
// contended `--concurrency=4` CI runner. Module isolation scopes this to this
// file.
configure({ asyncUtilTimeout: 5000 });

// ----------------------------------------------------------------------------
// Mocks — defined BEFORE the import of GetStartedController.
// ----------------------------------------------------------------------------

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

// Mutable so a rerender can simulate an in-place account switch (Codex F1).
let mockUserId = "user-1";
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: { id: mockUserId, name: "Test User" },
		session: { id: "test-session" },
		loaded: true,
		reloadSession: vi.fn(),
	}),
}));

const getState = vi.fn();
const update = vi.fn();
const setMyDefault = vi.fn();
const getMyDefault = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		users: {
			onboarding: {
				getState: (...args: unknown[]) => getState(...args),
				update: (...args: unknown[]) => update(...args),
			},
		},
		functionTags: {
			setMyDefault: (...args: unknown[]) => setMyDefault(...args),
		},
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
		// Tab customization (card #1837) — the controller reads viewer-visible
		// tabs to filter tour steps; nothing configured in this suite.
		projects: {
			// Existence probe the controller reads to collapse the
			// project-scoped tour steps (Fizzy #2360). These files don't drive
			// the tour, so one project keeps them on the pre-#2360 path.
			list: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["projects.list", input],
					queryFn: async () => ({ projects: [{ id: "project-1" }] }),
				}),
			},
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

// Mutable so individual tests can drive `roleTagEnforcement` /
// `roleTagGateUp` in the controller (Fizzy #2264 stand-down). Same style as
// `FunctionTagsRequiredGate.test.tsx`, which this predicate is shared with.
let flagValue = false;
let snapshotValue: boolean | null = false;
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	// A genuine hook — NOT a bare function — so that a hook-order regression
	// in the component under test (a `useFeatureFlag` call appended to a
	// short-circuited `&&` chain) actually crashes here the way React really
	// would. A plain `() => flagValue` mock has no hook slot of its own and
	// would make the "loading -> eligible transition" test below pass
	// regardless of whether the real bug is present.
	useFeatureFlag: (key: string) => {
		const [value] = useMockFlagState(flagValue);
		// Publishing Suite is a different gate from the one these tests drive.
		// Pinning it off keeps toggling the role-tag flag from switching it on
		// as a side effect.
		return key === "PUBLISHING_SUITE" ? false : value;
	},
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationId: () => "org-1",
}));

vi.mock("@saas/shared/components/RoleTagSnapshotProvider", () => ({
	useRoleTagSnapshot: () => snapshotValue,
}));

// Minimal stubs — this suite tests the controller's own mode/effect wiring,
// not the drawer/spotlight's internals.
vi.mock("../GetStartedDrawer", () => ({
	GetStartedDrawer: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="drawer">
			<button type="button" onClick={onClose}>
				Close drawer
			</button>
		</div>
	),
}));
vi.mock("../GetStartedWelcomeDialog", () => ({
	GetStartedWelcomeDialog: ({
		onStartTour,
		onDismiss,
	}: {
		onStartTour: () => void;
		onDismiss: () => void;
	}) => (
		<div data-testid="welcome">
			<button type="button" onClick={onStartTour}>
				Take tour
			</button>
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
				Finish tour
			</button>
			<button type="button" onClick={props.onDismiss}>
				Dismiss tour
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
// Fixtures / helpers
// ----------------------------------------------------------------------------

function renderController() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const utils = render(
		<QueryClientProvider client={client}>
			<GetStartedController />
		</QueryClientProvider>,
	);
	return { client, ...utils };
}

function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

async function dispatchTourPage(pageId: string) {
	await act(async () => {
		window.dispatchEvent(
			new CustomEvent(GET_STARTED_TOUR_PAGE_EVENT, {
				detail: { pageId },
			}),
		);
	});
}

async function dispatchProjectTab(tab: string) {
	await act(async () => {
		window.dispatchEvent(
			new CustomEvent(GET_STARTED_PROJECT_TAB_EVENT, {
				detail: { projectId: "proj-1", tab },
			}),
		);
	});
}

/** Let pending microtasks/effects settle without a specific signal to await. */
async function settle(ms = 50) {
	await act(async () => {
		await new Promise((r) => setTimeout(r, ms));
	});
}

beforeEach(() => {
	getState.mockReset();
	update.mockReset();
	setMyDefault.mockReset();
	getMyDefault.mockReset();
	getMyDefault.mockResolvedValue({ tags: [] });
	setMyDefault.mockResolvedValue({ tags: [] });
	sessionStorage.clear();
	mockUserId = "user-1";
	// Default: enforcement off, matching the flag's production default —
	// every pre-existing test in this file exercises that behavior.
	flagValue = false;
	snapshotValue = false;
});

describe("GetStartedController — no-tags prompt (FR4)", () => {
	it("opens for an eligible, drawer-settled user not shown this session", async () => {
		getState.mockResolvedValue(
			makeStateData({
				state: { autoLaunched: true },
				eligibleForFunctionTagsPrompt: true,
				eligibleForAutoLaunch: false,
			}),
		);
		renderController();
		expect(
			await screen.findByText("Set your function tags"),
		).toBeInTheDocument();
	});

	it("opens for an existing user (no auto-launch cohort) with no tags", async () => {
		getState.mockResolvedValue(
			makeStateData({
				state: { autoLaunched: false },
				autoLaunchCohort: false, // existing user — no drawer ever fires
				eligibleForFunctionTagsPrompt: true,
				eligibleForAutoLaunch: false,
			}),
		);
		renderController();
		expect(
			await screen.findByText("Set your function tags"),
		).toBeInTheDocument();
	});

	it("does not open when eligibleForFunctionTagsPrompt is false", async () => {
		getState.mockResolvedValue(
			makeStateData({
				state: { autoLaunched: true },
				eligibleForFunctionTagsPrompt: false,
			}),
		);
		renderController();
		await waitFor(() => expect(getState).toHaveBeenCalled());
		await settle();
		expect(
			screen.queryByText("Set your function tags"),
		).not.toBeInTheDocument();
	});

	it("does not open when already shown this session (sessionStorage set for this user)", async () => {
		sessionStorage.setItem("fabric:function-tags-prompt-shown:user-1", "1");
		getState.mockResolvedValue(
			makeStateData({
				state: { autoLaunched: true },
				eligibleForFunctionTagsPrompt: true,
			}),
		);
		renderController();
		await waitFor(() => expect(getState).toHaveBeenCalled());
		await settle();
		expect(
			screen.queryByText("Set your function tags"),
		).not.toBeInTheDocument();
	});

	it("does NOT inherit another user's shown flag (per-user key)", async () => {
		sessionStorage.setItem(
			"fabric:function-tags-prompt-shown:someone-else",
			"1",
		);
		getState.mockResolvedValue(
			makeStateData({
				state: { autoLaunched: true },
				eligibleForFunctionTagsPrompt: true,
			}),
		);
		renderController();
		// Current user is "user-1" (mocked useSession) — still shown.
		expect(
			await screen.findByText("Set your function tags"),
		).toBeInTheDocument();
	});

	it("sequencing: opens after the first-login welcome dialog closes, not on top of it", async () => {
		const autoLaunchGate = deferred<{ state: typeof DEFAULT_TOUR_STATE }>();
		update.mockImplementation((args: { action: { type: string } }) => {
			if (args.action.type === "markAutoLaunched") {
				return autoLaunchGate.promise;
			}
			return Promise.resolve({ state: DEFAULT_TOUR_STATE });
		});
		getState.mockResolvedValue(
			makeStateData({
				state: { autoLaunched: false },
				eligibleForAutoLaunch: true,
				autoLaunchCohort: true,
				eligibleForFunctionTagsPrompt: true,
			}),
		);
		renderController();

		// Drawer first; the prompt must NOT be on screen yet.
		expect(await screen.findByTestId("welcome")).toBeInTheDocument();
		expect(
			screen.queryByText("Set your function tags"),
		).not.toBeInTheDocument();

		fireEvent.click(screen.getByText("Explore alone"));
		// Opens off the optimistic autoLaunched cache write after the dialog.
		expect(
			await screen.findByText("Set your function tags"),
		).toBeInTheDocument();

		await act(async () => {
			autoLaunchGate.resolve({
				state: { ...DEFAULT_TOUR_STATE, autoLaunched: true },
			});
			await Promise.resolve();
			await Promise.resolve();
		});
	});

	it.each(["save", "notnow"] as const)(
		"does not reopen after %s (session flag) and unblocks the page tour",
		async (path) => {
			update.mockResolvedValue({ state: DEFAULT_TOUR_STATE });
			// The modal's Save is gated on a non-empty selection (it must not
			// persist an empty set over the user's real defaults), so seed a
			// current default so Save is enabled on the "save" path. The "notnow"
			// path ignores this. getMyDefault is read only by the modal — it does
			// not affect the controller's eligibility/pending derivation.
			if (path === "save") {
				getMyDefault.mockResolvedValue({ tags: ["DEVELOPER"] });
			}
			getState.mockResolvedValue(
				makeStateData({
					state: { autoLaunched: true },
					eligibleForFunctionTagsPrompt: true,
					autoLaunchCohort: true,
					eligibleForAutoLaunch: false,
				}),
			);
			const user = userEvent.setup();
			renderController();
			await screen.findByText("Set your function tags");

			if (path === "save") {
				const saveButton = screen.getByRole("button", {
					name: /^save$/i,
				});
				await waitFor(() => expect(saveButton).toBeEnabled());
				await user.click(saveButton);
			} else {
				await user.click(
					screen.getByRole("button", { name: /not now/i }),
				);
			}

			await waitFor(() =>
				expect(
					screen.queryByText("Set your function tags"),
				).not.toBeInTheDocument(),
			);
			await settle();
			expect(
				screen.queryByText("Set your function tags"),
			).not.toBeInTheDocument();

			// Page tour is no longer suppressed (pending went false via session flag).
			await dispatchProjectTab("overview");
			await settle(1000);
			await waitFor(() =>
				expect(update).toHaveBeenCalledWith({
					action: { type: "markPageSeen", pageId: "overview" },
				}),
			);
		},
	);

	it("serializes optOutFunctionTagsPrompt with a concurrent markPageSeen through the single chainRef", async () => {
		const calls: string[] = [];
		const pageSeenGate = deferred<void>();
		const optGate = deferred<void>();
		update.mockImplementation(
			async (args: { action: { type: string; pageId?: string } }) => {
				calls.push(args.action.type);
				if (args.action.type === "markAutoLaunched") {
					return {
						state: { ...DEFAULT_TOUR_STATE, autoLaunched: true },
					};
				}
				if (args.action.type === "markPageSeen") {
					await pageSeenGate.promise;
					return {
						state: {
							...DEFAULT_TOUR_STATE,
							autoLaunched: true,
							seenPages: { [args.action.pageId as string]: true },
						},
					};
				}
				if (args.action.type === "optOutFunctionTagsPrompt") {
					await optGate.promise;
					return {
						state: {
							...DEFAULT_TOUR_STATE,
							autoLaunched: true,
							functionTagsPromptOptOut: true,
							seenPages: { overview: true },
						},
					};
				}
				return { state: DEFAULT_TOUR_STATE };
			},
		);
		getState.mockResolvedValue(
			makeStateData({
				state: { autoLaunched: false },
				eligibleForAutoLaunch: true,
				autoLaunchCohort: true,
				eligibleForFunctionTagsPrompt: true,
			}),
		);
		const user = userEvent.setup();
		renderController();

		expect(await screen.findByTestId("welcome")).toBeInTheDocument();
		await dispatchTourPage("overview"); // enqueues markPageSeen after markAutoLaunched
		await waitFor(() =>
			expect(calls).toEqual(["markAutoLaunched", "markPageSeen"]),
		);
		fireEvent.click(screen.getByRole("button", { name: /finish tour/i }));
		await screen.findByText("Set your function tags");

		await user.click(
			screen.getByRole("button", { name: /don't ask again/i }),
		);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		// opt-out request must NOT be dispatched until markPageSeen resolves.
		expect(calls).toEqual(["markAutoLaunched", "markPageSeen"]);

		pageSeenGate.resolve();
		await waitFor(() =>
			expect(calls).toEqual([
				"markAutoLaunched",
				"markPageSeen",
				"optOutFunctionTagsPrompt",
			]),
		);
		optGate.resolve();
		await waitFor(() =>
			expect(
				screen.queryByText("Set your function tags"),
			).not.toBeInTheDocument(),
		);
	});

	it("re-seeds the shown flag on an in-place user-id change (Codex F1)", async () => {
		// user-1 already saw it this session; user-2 has NOT.
		sessionStorage.setItem("fabric:function-tags-prompt-shown:user-1", "1");
		getState.mockResolvedValue(
			makeStateData({
				state: { autoLaunched: true },
				eligibleForFunctionTagsPrompt: true,
			}),
		);
		const { rerender, client } = renderController();
		await waitFor(() => expect(getState).toHaveBeenCalled());
		await settle();
		// user-1: suppressed (their session key is set).
		expect(
			screen.queryByText("Set your function tags"),
		).not.toBeInTheDocument();

		// Simulate an in-place switch to user-2 and rerender the same tree.
		mockUserId = "user-2";
		rerender(
			<QueryClientProvider client={client}>
				<GetStartedController />
			</QueryClientProvider>,
		);
		// user-2 has no session key → the re-seed effect flips the flag false →
		// the prompt opens for user-2.
		expect(
			await screen.findByText("Set your function tags"),
		).toBeInTheDocument();
	});
});

/**
 * Fizzy #2264: `ROLE_TAG_ENFORCEMENT` supersedes this dismissible prompt with
 * the blocking `FunctionTagsRequiredGate` (mounted separately in
 * `AppWrapper`). Exactly one of the two must ever render, and the page-tour
 * auto-open must not run underneath the gate while it's up.
 */
describe("GetStartedController — role-tag enforcement stand-down (Fizzy #2264)", () => {
	it("does not render the dismissible prompt when enforcement is on", async () => {
		flagValue = true;
		getState.mockResolvedValue(
			makeStateData({
				state: { autoLaunched: true },
				eligibleForFunctionTagsPrompt: true,
			}),
		);
		renderController();
		await waitFor(() => expect(getState).toHaveBeenCalled());
		await settle();
		expect(
			screen.queryByText("Set your function tags"),
		).not.toBeInTheDocument();
	});

	it("renders the dismissible prompt once live enforcementEnabled is false, even with the payload flag on", async () => {
		// The regression this guards: suppressing on the frozen
		// `roleTagEnforcement` payload flag alone would leave this prompt dark
		// for the rest of the session even after the gate has already stood
		// down live (an admin turned enforcement off mid-session). Must be
		// gated on the live `enforcementLive` const, not the frozen flag by
		// itself.
		flagValue = true;
		getMyDefault.mockResolvedValue({ tags: [], enforcementEnabled: false });
		getState.mockResolvedValue(
			makeStateData({
				state: { autoLaunched: true },
				eligibleForFunctionTagsPrompt: true,
			}),
		);
		renderController();
		expect(
			await screen.findByText("Set your function tags"),
		).toBeInTheDocument();
	});

	it("still renders the dismissible prompt when enforcement is off", async () => {
		flagValue = false;
		getState.mockResolvedValue(
			makeStateData({
				state: { autoLaunched: true },
				eligibleForFunctionTagsPrompt: true,
			}),
		);
		renderController();
		expect(
			await screen.findByText("Set your function tags"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /not now/i }),
		).toBeInTheDocument();
	});

	it("survives a loading -> eligible transition without a hook-order crash", async () => {
		flagValue = true;
		// Resolve the onboarding query only AFTER the first render, so the
		// controller renders once with `data === undefined` and again with it
		// populated. A conditional `useFeatureFlag` call (appended to the
		// `functionTagsPromptPending` chain instead of hoisted to its own
		// top-level const) crashes exactly on this transition.
		const pending = deferred<ReturnType<typeof makeStateData>>();
		getState.mockReturnValue(pending.promise);
		renderController();
		await act(async () => {
			pending.resolve(
				makeStateData({
					state: { autoLaunched: true },
					eligibleForFunctionTagsPrompt: true,
				}),
			);
			await Promise.resolve();
		});
		// No assertion beyond "did not throw" is needed; React's own hook-order
		// error would fail this render/act call.
		await waitFor(() => expect(getState).toHaveBeenCalled());
	});

	it("suppresses the page-tour auto-open while the role-tag gate is up", async () => {
		// Isolates `roleTagGateUp` from `functionTagsPromptPending`:
		// `eligibleForFunctionTagsPrompt: false` means the OLD prompt's own
		// suppression cannot be what blocks the tour here — only the page-tour
		// effect's own `|| roleTagGateUp` guard can be.
		flagValue = true;
		getMyDefault.mockResolvedValue({ tags: [], enforcementEnabled: true });
		getState.mockResolvedValue(
			makeStateData({
				state: { autoLaunched: true },
				autoLaunchCohort: true,
				eligibleForFunctionTagsPrompt: false,
			}),
		);
		renderController();
		await waitFor(() => expect(getState).toHaveBeenCalled());

		await dispatchProjectTab("overview");
		await settle(1000);

		expect(update).not.toHaveBeenCalledWith({
			action: { type: "markPageSeen", pageId: "overview" },
		});
		expect(screen.queryByTestId("spotlight")).not.toBeInTheDocument();
	});

	it("still auto-opens the page tour once the user already has tags, even with enforcement on", async () => {
		// The opposite half of the test above, proving the guard reads
		// `roleTagGateUp` (which closes the instant tags exist) rather than
		// the raw `roleTagEnforcement` flag (which stays on for the whole
		// rollout, tagged users included).
		flagValue = true;
		getMyDefault.mockResolvedValue({
			tags: ["DEVELOPER"],
			enforcementEnabled: true,
		});
		getState.mockResolvedValue(
			makeStateData({
				state: { autoLaunched: true },
				autoLaunchCohort: true,
				eligibleForFunctionTagsPrompt: false,
			}),
		);
		renderController();
		await waitFor(() => expect(getState).toHaveBeenCalled());

		await dispatchProjectTab("overview");
		await settle(1000);

		await waitFor(() =>
			expect(update).toHaveBeenCalledWith({
				action: { type: "markPageSeen", pageId: "overview" },
			}),
		);
	});
});

/**
 * Surface broadcast — components rendered outside the
 * controller (the sidebar launcher pointer) need to know when an onboarding
 * surface is on screen. The signal is keyed on `mode`, so every surface is
 * covered without per-handler wiring.
 */
describe("GetStartedController — surface broadcast", () => {
	function captureSurfaceEvents() {
		const seen: boolean[] = [];
		const listener = (e: Event) => {
			seen.push(
				(e as CustomEvent<SurfaceEventDetail>).detail?.open === true,
			);
		};
		window.addEventListener(GET_STARTED_SURFACE_EVENT, listener);
		return {
			seen,
			stop: () =>
				window.removeEventListener(GET_STARTED_SURFACE_EVENT, listener),
		};
	}

	it("reports open when the first-login welcome dialog auto-launches, closed when it goes away", async () => {
		const surface = captureSurfaceEvents();
		getState.mockResolvedValue(
			makeStateData({
				eligibleForAutoLaunch: true,
				autoLaunchCohort: true,
			}),
		);
		renderController();

		expect(await screen.findByTestId("welcome")).toBeInTheDocument();
		await waitFor(() => expect(surface.seen).toContain(true));

		await userEvent.click(screen.getByText("Explore alone"));
		await waitFor(() =>
			expect(surface.seen[surface.seen.length - 1]).toBe(false),
		);
		surface.stop();
	});

	it("reports open for the tags prompt too — the signal follows mode, not one surface", async () => {
		const surface = captureSurfaceEvents();
		getState.mockResolvedValue(
			makeStateData({
				state: { autoLaunched: true },
				eligibleForFunctionTagsPrompt: true,
			}),
		);
		renderController();

		expect(
			await screen.findByText("Set your function tags"),
		).toBeInTheDocument();
		await waitFor(() => expect(surface.seen).toContain(true));
		surface.stop();
	});

	it("stops broadcasting once unmounted", async () => {
		const surface = captureSurfaceEvents();
		getState.mockResolvedValue(makeStateData());
		const { unmount } = renderController();
		await settle();

		const before = surface.seen.length;
		unmount();
		await settle();
		expect(surface.seen.length).toBe(before);
		surface.stop();
	});
});

/**
 * First-login destination. The auto-launch branch now opens a two-choice
 * welcome dialog instead of the area-listing drawer; the drawer stays reachable
 * from the sidebar launcher.
 */
describe("GetStartedController — first-login welcome dialog", () => {
	function eligibleForFirstLogin() {
		getState.mockResolvedValue(
			makeStateData({
				eligibleForAutoLaunch: true,
				autoLaunchCohort: true,
			}),
		);
	}

	it("opens the welcome dialog, not the drawer", async () => {
		eligibleForFirstLogin();
		renderController();

		expect(await screen.findByTestId("welcome")).toBeInTheDocument();
		expect(screen.queryByTestId("drawer")).not.toBeInTheDocument();
	});

	it("opens neither for an account outside the auto-launch cohort", async () => {
		getState.mockResolvedValue(
			makeStateData({ eligibleForAutoLaunch: false }),
		);
		renderController();
		await settle();

		expect(screen.queryByTestId("welcome")).not.toBeInTheDocument();
		expect(screen.queryByTestId("drawer")).not.toBeInTheDocument();
	});

	it("starts the tour from the primary action and records the start", async () => {
		eligibleForFirstLogin();
		renderController();
		expect(await screen.findByTestId("welcome")).toBeInTheDocument();

		await userEvent.click(screen.getByText("Take tour"));

		expect(await screen.findByTestId("spotlight")).toBeInTheDocument();
		await waitFor(() =>
			expect(update).toHaveBeenCalledWith({ action: { type: "start" } }),
		);
	});

	it("writes nothing when the user chooses to explore alone", async () => {
		eligibleForFirstLogin();
		renderController();
		expect(await screen.findByTestId("welcome")).toBeInTheDocument();

		await userEvent.click(screen.getByText("Explore alone"));
		await settle();

		// The sidebar badge is gated on the tour status, which declining must
		// leave untouched — so no dismissal of any kind is persisted here.
		expect(screen.queryByTestId("welcome")).not.toBeInTheDocument();
		expect(screen.queryByTestId("spotlight")).not.toBeInTheDocument();
		for (const call of update.mock.calls) {
			expect(call[0].action.type).not.toBe("dismiss");
			expect(call[0].action.type).not.toBe("dismissPointer");
		}
	});

	it("does not reopen once the account has already been auto-launched", async () => {
		getState.mockResolvedValue(
			makeStateData({
				state: { autoLaunched: true },
				eligibleForAutoLaunch: false,
				autoLaunchCohort: true,
			}),
		);
		renderController();
		await settle();

		expect(screen.queryByTestId("welcome")).not.toBeInTheDocument();
	});

	it("still opens the drawer from the launcher, including after the dialog was dismissed", async () => {
		eligibleForFirstLogin();
		renderController();
		expect(await screen.findByTestId("welcome")).toBeInTheDocument();
		await userEvent.click(screen.getByText("Explore alone"));
		await settle();

		await act(async () => {
			window.dispatchEvent(new CustomEvent(GET_STARTED_OPEN_EVENT));
		});

		expect(await screen.findByTestId("drawer")).toBeInTheDocument();
	});
});
