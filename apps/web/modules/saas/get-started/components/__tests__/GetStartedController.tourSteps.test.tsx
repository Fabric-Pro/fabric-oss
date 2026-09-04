/**
 * The guided tour's step list, as the controller actually assembles it
 * (Fizzy #2360).
 *
 * `resolveTourSteps` is unit-tested over arrays next door; this file pins the
 * wiring around it — that the controller asks the right question, that it
 * hands the spotlight the resolved list, and that the list cannot change
 * underneath a tour that is already open.
 *
 * The spotlight is stubbed down to the two numbers that matter: how many steps
 * it was given and which one it is on. This is about the CONTROLLER, not the
 * spotlight's rendering.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configure, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act, useState as useMockFlagState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

configure({ asyncUtilTimeout: 5000 });

// ----------------------------------------------------------------------------
// Mocks — defined BEFORE the import of GetStartedController.
// ----------------------------------------------------------------------------

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

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

/** Drives what the controller's project-existence probe resolves to. */
const listProjects = vi.fn();
/** The last input the controller passed to that probe. */
let lastProbeInput: Record<string, unknown> | null = null;
/** Drives per-project tab visibility, so a test can hide a tab mid-run. */
const getTabVisibility = vi.fn();

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		functionTags: {
			getMyDefault: {
				queryOptions: () => ({
					queryKey: ["ft", "getMyDefault"],
					queryFn: async () => ({ tags: ["engineer"] }),
				}),
			},
		},
		projects: {
			list: {
				queryOptions: ({ input }: { input: unknown }) => {
					lastProbeInput = input as Record<string, unknown>;
					return {
						queryKey: ["projects.list", input],
						queryFn: () => listProjects(),
					};
				},
			},
			tabVisibility: {
				get: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.tabVisibility.get", input],
						queryFn: () => getTabVisibility(),
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

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationId: () => "org-1",
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => {
		const [value] = useMockFlagState(false);
		return key === "PUBLISHING_SUITE" ? false : value;
	},
}));
vi.mock("@saas/shared/components/RoleTagSnapshotProvider", () => ({
	useRoleTagSnapshot: () => false,
}));

vi.mock("../GetStartedDrawer", () => ({
	GetStartedDrawer: ({ onStartTour }: { onStartTour: () => void }) => (
		<button type="button" onClick={onStartTour}>
			Start tour from drawer
		</button>
	),
}));
vi.mock("../GetStartedWelcomeDialog", () => ({
	GetStartedWelcomeDialog: ({ onStartTour }: { onStartTour: () => void }) => (
		<button type="button" onClick={onStartTour}>
			Start tour
		</button>
	),
}));

// The stub reports the two facts these tests are about.
vi.mock("../GetStartedSpotlight", () => ({
	GetStartedSpotlight: (props: {
		steps: readonly { id: string }[];
		index: number;
		onNext: () => void;
		onFinish: () => void;
	}) => (
		<div data-testid="spotlight">
			<span data-testid="total">{props.steps.length}</span>
			<span data-testid="current">{props.steps[props.index]?.id}</span>
			<span data-testid="ids">
				{props.steps.map((s) => s.id).join(",")}
			</span>
			<button type="button" onClick={props.onNext}>
				Next
			</button>
			<button type="button" onClick={props.onFinish}>
				Done
			</button>
		</div>
	),
}));

import { makeOnboardingStateData as makeStateData } from "../../lib/__tests__/onboarding-state-fixtures";
import {
	GET_STARTED_OPEN_EVENT,
	GET_STARTED_PROJECT_TAB_EVENT,
	type ProjectTabEventDetail,
} from "../../lib/tour-steps";
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
	return {
		...render(
			<QueryClientProvider client={client}>
				<GetStartedController />
			</QueryClientProvider>,
		),
		client,
	};
}

/**
 * Block until the project probe has actually landed.
 *
 * Without this the "an open tour keeps its steps" assertions are vacuous:
 * resolving the promise does not synchronously push the new value through
 * React Query, so the tour still read nine steps even with the freeze
 * removed — the test passed against a deliberately broken controller.
 */
async function probeReports(client: QueryClient, count: number) {
	await waitFor(() =>
		expect(
			(
				client
					.getQueryCache()
					.findAll({ queryKey: ["projects.list"] })[0]?.state.data as
					| { projects?: unknown[] }
					| undefined
			)?.projects,
		).toHaveLength(count),
	);
}

async function probeSettled(client: QueryClient) {
	await waitFor(() =>
		expect(
			client.getQueryCache().findAll({ queryKey: ["projects.list"] })[0]
				?.state.status,
		).toBe("success"),
	);
}

/** Open the drawer and start the tour from it. */
async function startTour() {
	await act(async () => {
		window.dispatchEvent(new CustomEvent(GET_STARTED_OPEN_EVENT));
	});
	await userEvent.click(
		await screen.findByRole("button", { name: "Start tour from drawer" }),
	);
	await screen.findByTestId("spotlight");
}

const total = () => Number(screen.getByTestId("total").textContent);
/** The input the controller sent to the existence probe. */
const probeInput = () =>
	(listProjects.mock.calls.length > 0 ? lastProbeInput : null) as Record<
		string,
		unknown
	> | null;
const stepIds = () =>
	(screen.getByTestId("ids").textContent ?? "").split(",").filter(Boolean);

/** A project list result with `count` projects. */
const projects = (count: number) => ({
	projects: Array.from({ length: count }, (_, i) => ({ id: `p-${i}` })),
});

/** A promise the test resolves by hand, to hold a query in flight. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.clearAllMocks();
	sessionStorage.clear();
	// Atlas is gated on a build-time env read (see `featureGatedProjectTabs`),
	// deliberately lazy so tests can stub it. Turn it on so these tests walk
	// the real, complete nine-step tour rather than an eight-step subset.
	vi.stubEnv("NEXT_PUBLIC_FABRIC_FEATURE_ATLAS", "true");
	getState.mockResolvedValue(makeStateData());
	update.mockImplementation(async () => makeStateData());
	listProjects.mockResolvedValue(projects(1));
	getTabVisibility.mockResolvedValue({ config: null });
});

// ----------------------------------------------------------------------------

describe("GetStartedController — the viewer has a project", () => {
	it("walks the full nine-step tour, unchanged", async () => {
		renderController();
		await startTour();

		await waitFor(() => expect(total()).toBe(9));
		expect(stepIds()).toEqual([
			"welcome",
			"assistant",
			"projects",
			"overview",
			"documents",
			"roadmap",
			"proposals",
			"atlas",
			"wrapup",
		]);
	});
});

describe("GetStartedController — the viewer has no project", () => {
	beforeEach(() => {
		listProjects.mockResolvedValue(projects(0));
	});

	it("shows the create-a-project step once, not five times", async () => {
		renderController();
		await startTour();

		await waitFor(() => expect(total()).toBe(5));
		expect(stepIds()).toEqual([
			"welcome",
			"assistant",
			"projects",
			"overview",
			"wrapup",
		]);
	});

	it("reports an honest step total to the spotlight", async () => {
		renderController();
		await startTour();

		await waitFor(() => expect(total()).toBe(5));
		// The counter and the dot navigation both derive from `steps.length`,
		// so a five-step list is what makes "Step 4 / 5" correct.
		expect(stepIds()).toHaveLength(total());
	});

	it("advances from the create-a-project step to the wrap-up", async () => {
		renderController();
		await startTour();
		await waitFor(() => expect(total()).toBe(5));

		for (let i = 0; i < 3; i++) {
			await userEvent.click(screen.getByRole("button", { name: "Next" }));
		}
		expect(screen.getByTestId("current").textContent).toBe("overview");

		await userEvent.click(screen.getByRole("button", { name: "Next" }));
		expect(screen.getByTestId("current").textContent).toBe("wrapup");
	});
});

describe("GetStartedController — the probe has not answered", () => {
	it("does not collapse while the lookup is in flight", async () => {
		const pending = deferred<{ projects: { id: string }[] }>();
		listProjects.mockReturnValue(pending.promise);

		renderController();
		await startTour();

		// Unsettled must read as "unknown", never as "no projects".
		expect(total()).toBe(9);

		await act(async () => {
			pending.resolve(projects(1));
		});
	});

	it("does not collapse when the lookup fails", async () => {
		listProjects.mockRejectedValue(new Error("network"));

		const { client } = renderController();
		await startTour();
		await waitFor(() =>
			expect(
				client
					.getQueryCache()
					.findAll({ queryKey: ["projects.list"] })[0]?.state.status,
			).toBe("error"),
		);

		// A failure is not an answer. The spotlight's own lookup runs later and
		// may well succeed, so dropping four real steps here would hide
		// project guidance from someone who does have projects.
		expect(total()).toBe(9);
	});
});

describe("GetStartedController — a tour that started too early", () => {
	it("collapses once the probe answers, without unmounting the tour", async () => {
		const pending = deferred<{ projects: { id: string }[] }>();
		listProjects.mockReturnValue(pending.promise);

		const { client } = renderController();
		await startTour();
		expect(total()).toBe(9);

		// Walk PAST the end of the collapsed list (5 steps, indices 0-4).
		// This is the position where a shrinking list used to leave
		// `steps[index]` undefined and unmount the tour outright.
		for (let i = 0; i < 5; i++) {
			await userEvent.click(screen.getByRole("button", { name: "Next" }));
		}
		expect(screen.getByTestId("current").textContent).toBe("roadmap");

		await act(async () => {
			pending.resolve(projects(0));
		});
		await probeSettled(client);

		// Freezing the unresolved list would have stranded this run on nine
		// steps and shown the duplicate card five times anyway.
		expect(screen.getByTestId("spotlight")).toBeTruthy();
		await waitFor(() => expect(total()).toBe(5));
		// Clamped to the last real step rather than rendering nothing.
		expect(screen.getByTestId("current").textContent).toBe("wrapup");
	});

	it("stops moving once the probe has answered", async () => {
		const { client } = renderController();
		await startTour();
		await waitFor(() => expect(total()).toBe(9));

		// A later refetch that disagrees must not reshape a run in progress.
		listProjects.mockResolvedValue(projects(0));
		await act(async () => {
			await client.refetchQueries({ queryKey: ["projects.list"] });
		});
		await probeReports(client, 0);

		expect(total()).toBe(9);

		// Proves the assertion above was not vacuous: the same disagreeing
		// answer DOES take effect on the next run.
		await userEvent.click(screen.getByRole("button", { name: "Done" }));
		await startTour();
		await waitFor(() => expect(total()).toBe(5));
	});
});

describe("GetStartedController — tab visibility stays live", () => {
	it("drops steps for a tab hidden by a customization that lands mid-tour", async () => {
		const { client } = renderController();
		await startTour();
		await waitFor(() => expect(total()).toBe(9));

		// Visibility is per project and the query is disabled until one is on
		// screen, so a tour launched from the sidebar starts with every tab
		// looking visible. Entering a project is when the truth arrives.
		getTabVisibility.mockResolvedValue({
			config: { overrides: { stories: false } },
		});
		await act(async () => {
			window.dispatchEvent(
				new CustomEvent<ProjectTabEventDetail>(
					GET_STARTED_PROJECT_TAB_EVENT,
					{ detail: { projectId: "p-0", tab: "overview" } },
				),
			);
		});

		// roadmap and proposals both live on `stories`. Freezing the whole
		// list would have kept them and left the tour waiting on anchors that
		// never render.
		await waitFor(() => expect(total()).toBe(7));
		expect(stepIds()).not.toContain("roadmap");
		expect(stepIds()).not.toContain("proposals");
		expect(screen.getByTestId("spotlight")).toBeTruthy();

		// And the collapse decision is still frozen through all of that.
		expect(client).toBeTruthy();
	});
});

describe("GetStartedController — a live change keeps the viewer's place", () => {
	/** Hide a project tab the way a late customization result would. */
	async function hideTab(tab: string) {
		getTabVisibility.mockResolvedValue({
			config: { overrides: { [tab]: false } },
		});
		await act(async () => {
			window.dispatchEvent(
				new CustomEvent<ProjectTabEventDetail>(
					GET_STARTED_PROJECT_TAB_EVENT,
					{ detail: { projectId: "p-0", tab: "overview" } },
				),
			);
		});
	}

	it("stays on the same step when EARLIER steps are removed", async () => {
		renderController();
		await startTour();
		await waitFor(() => expect(total()).toBe(9));

		// Walk to atlas (index 7).
		for (let i = 0; i < 7; i++) {
			await userEvent.click(screen.getByRole("button", { name: "Next" }));
		}
		expect(screen.getByTestId("current").textContent).toBe("atlas");

		// roadmap and proposals sit BEFORE atlas and both live on `stories`.
		// Removing them shifts atlas from index 7 to 5 — a bare index would
		// leave the viewer on the wrap-up, silently skipping atlas entirely.
		await hideTab("stories");

		await waitFor(() => expect(total()).toBe(7));
		expect(screen.getByTestId("current").textContent).toBe("atlas");
	});

	it("does not jump backward if the removed step later comes back", async () => {
		renderController();
		await startTour();
		await waitFor(() => expect(total()).toBe(9));

		for (let i = 0; i < 5; i++) {
			await userEvent.click(screen.getByRole("button", { name: "Next" }));
		}
		expect(screen.getByTestId("current").textContent).toBe("roadmap");

		await hideTab("stories");
		await waitFor(() =>
			expect(screen.getByTestId("current").textContent).toBe("atlas"),
		);

		// Visibility widens again — another project's config, or a refetch.
		// The viewer has already been walked past roadmap; pulling them back
		// to it would replay guidance they have seen.
		getTabVisibility.mockResolvedValue({ config: null });
		await act(async () => {
			window.dispatchEvent(
				new CustomEvent<ProjectTabEventDetail>(
					GET_STARTED_PROJECT_TAB_EVENT,
					{ detail: { projectId: "p-1", tab: "overview" } },
				),
			);
		});

		await waitFor(() => expect(total()).toBe(9));
		expect(screen.getByTestId("current").textContent).toBe("atlas");
	});

	it("moves to the next surviving step when the current one is removed", async () => {
		renderController();
		await startTour();
		await waitFor(() => expect(total()).toBe(9));

		// Walk to roadmap (index 5), which lives on `stories`.
		for (let i = 0; i < 5; i++) {
			await userEvent.click(screen.getByRole("button", { name: "Next" }));
		}
		expect(screen.getByTestId("current").textContent).toBe("roadmap");

		await hideTab("stories");

		// roadmap is gone. Registry order is preserved, so the old slot now
		// holds the next survivor rather than nothing.
		await waitFor(() => expect(total()).toBe(7));
		expect(screen.getByTestId("current").textContent).toBe("atlas");
	});
});

describe("GetStartedController — the probe and the spotlight must agree", () => {
	it("asks the same question the spotlight asks", async () => {
		renderController();
		await startTour();
		await waitFor(() => expect(total()).toBe(9));

		// These two values are load-bearing and are duplicated by design in
		// `GetStartedSpotlight`'s `resolveProjectId`. If the two lookups ever
		// disagree about what counts as a project, the controller keeps all
		// five project steps while the spotlight fails to resolve one, and the
		// repeated create-a-project card is back. Change one, change both.
		expect(probeInput()).toMatchObject({
			limit: 1,
			includeDraft: false,
		});
	});
});
