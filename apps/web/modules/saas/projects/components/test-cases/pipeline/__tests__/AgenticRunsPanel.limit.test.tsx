/**
 * A run covers at most `MAX_CASES_PER_RUN` cases, and the panel refuses before
 * sending so a doomed request is never made.
 *
 * The refusal itself was already in place; what was missing is the part a user
 * can see. Selecting every case disabled the button and said nothing — the
 * explanatory copy was gated on the EMPTY selection only, and `title` was
 * undefined above the limit. So the original defect ("Input validation failed")
 * became a dead control with no stated reason, which is the failure mode the
 * empty-selection branch right beside it exists to avoid.
 *
 * These pin the visible half: the limit and the remedy must be on screen, and
 * must NOT be on screen for a selection that can actually run.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The panel runs THREE queries — runs, QA settings, environments — and the last
 * two decide whether a run has a target at all. A single blanket mock cannot
 * serve them, so each is answered by the key its queryOptions carries.
 */
const RUN_TARGET = { id: "env-1" };
let qaSettingsData: unknown = { defaultEnvironmentId: RUN_TARGET.id };
let environmentsData: unknown = [RUN_TARGET];

const useQueryMock = vi.fn((options?: { __query?: string }) => {
	if (options?.__query === "qaSettings") {
		return { data: qaSettingsData, isLoading: false };
	}
	if (options?.__query === "environments") {
		return { data: environmentsData, isLoading: false };
	}
	if (options?.__query === "runConfigurations") {
		return { data: [], isLoading: false };
	}
	return { data: [], isLoading: false };
});

vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: unknown) => useQueryMock(options as never),
	// The runs list pages rather than taking a fixed 25, so the panel reads
	// `data.pages`. An empty page keeps these tests about the run BUTTON, which
	// is what they are for.
	useInfiniteQuery: () => ({
		data: { pages: [{ runs: [], total: 0 }] },
		isLoading: false,
		hasNextPage: false,
		isFetchingNextPage: false,
		fetchNextPage: vi.fn(),
	}),
	useMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			agenticRuns: {
				list: {
					queryOptions: (o: unknown) => ({ ...(o as object) }),
					key: () => ["agenticRuns"],
				},
				listPage: {
					infiniteOptions: (o: unknown) => ({ ...(o as object) }),
					key: () => ["agenticRunsPage"],
				},
				get: { queryOptions: (o: unknown) => ({ ...(o as object) }) },
				dispatch: { mutationOptions: (o: unknown) => o },
				cancel: { mutationOptions: (o: unknown) => o },
				// The run-configuration dialog (mocks C2) queries these as soon as
				// the panel renders it, so the mock has to carry them even for
				// tests that never open the dialog.
				configurations: {
					list: {
						queryOptions: (o: unknown) => ({
							...(o as object),
							__query: "runConfigurations",
						}),
						key: () => ["runConfigurations"],
					},
					create: { mutationOptions: (o: unknown) => o },
				},
			},
			qaSettings: {
				get: {
					queryOptions: (o: unknown) => ({
						...(o as object),
						__query: "qaSettings",
					}),
				},
			},
			environments: {
				list: {
					queryOptions: (o: unknown) => ({
						...(o as object),
						__query: "environments",
					}),
				},
			},
		},
	},
}));

import { AgenticRunsPanel } from "../AgenticRunsPanel";

/**
 * The server bound this mirrors. Kept local so a drift shows up as a failure —
 * which is exactly what happened when durable batching raised it from a
 * 50-case feature CAP to a 500-case request-size bound.
 */
const MAX = 500;

const ids = (n: number) => Array.from({ length: n }, (_, i) => `case-${i}`);

beforeEach(() => {
	// Default: a run HAS a target, so these tests keep exercising the limit
	// rather than the missing-target refusal.
	qaSettingsData = { defaultEnvironmentId: RUN_TARGET.id };
	environmentsData = [RUN_TARGET];
});

/**
 * The panel takes the SELECTION, not a resolved id list.
 *
 * It used to take ids, which is what left the Run button dead on "Select all N
 * matching": that selection carries its intent as a predicate and deliberately
 * holds no ids, so the panel received an empty array. These tests drive the
 * `ids` mode because the limit they exercise is about how many cases are
 * selected, not how the selection was expressed.
 */
function renderPanel(selected: string[]) {
	return render(
		<AgenticRunsPanel
			projectId="p1"
			selection={{ mode: "ids", ids: selected }}
			selectionCount={selected.length}
			canRun={true}
		/>,
	);
}

describe("AgenticRunsPanel — the case limit is stated, not just enforced", () => {
	it("names the count, the limit and the remedy above the limit", () => {
		renderPanel(ids(MAX + 50));

		// The number selected and the cap both have to be readable, or the
		// disabled button is unexplained.
		expect(
			screen.getByText(new RegExp(`${MAX + 50} cases selected`)),
		).toBeInTheDocument();
		expect(
			screen.getByText(/a single run covers at most/i),
		).toBeInTheDocument();
		expect(screen.getByText(String(MAX))).toBeInTheDocument();
		// The remedy no longer tells people to split the selection themselves —
		// Fabric batches it. Asserted so the copy cannot silently regress to
		// advice that is now wrong.
		expect(
			screen.getByText(/runs large selections in batches/i),
		).toBeInTheDocument();
	});

	it("disables the run button and gives it a reason above the limit", () => {
		renderPanel(ids(MAX + 1));

		const button = screen.getByRole("button", {
			name: new RegExp(`Run ${MAX + 1} cases`),
		});
		expect(button).toBeDisabled();
		// A disabled control with no title is what a pointer user gets left with.
		expect(button).toHaveAttribute(
			"title",
			expect.stringContaining(String(MAX)),
		);
	});

	it("says nothing about the limit for a selection that can run", () => {
		renderPanel(ids(MAX));

		expect(screen.queryByText(/covers at most/i)).toBeNull();
		expect(
			screen.getByRole("button", {
				name: new RegExp(`Run ${MAX} cases`),
			}),
		).toBeEnabled();
	});
});

describe("AgenticRunsPanel — a run with no target refuses before dispatch", () => {
	it("refuses, and names Environments, when none are configured", () => {
		// The G3 defect: the button was enabled, the dispatch 400'd, and the
		// message pointed at a different screen — so the only way to learn a run
		// had no target was to start one.
		qaSettingsData = { defaultEnvironmentId: null };
		environmentsData = [];
		renderPanel(ids(3));

		expect(
			screen.getByText(/no environments are configured/i),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /run 3 cases/i }),
		).toBeDisabled();
	});

	it("asks for a DEFAULT when environments exist but none is chosen", () => {
		// A different remedy from the case above, and telling someone to add an
		// environment they already have is how a correct message wastes time.
		qaSettingsData = { defaultEnvironmentId: null };
		environmentsData = [RUN_TARGET];
		renderPanel(ids(3));

		expect(
			screen.getByText(/no default environment is set/i),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/no environments are configured/i),
		).not.toBeInTheDocument();
	});

	it("refuses when the default points at an environment that no longer exists", () => {
		// `defaultEnvironmentId` is deliberately NOT a foreign key, so a deleted
		// environment leaves a dangling reference. Checking mere presence would
		// enable the button for a target the server cannot resolve.
		qaSettingsData = { defaultEnvironmentId: "env-deleted" };
		environmentsData = [RUN_TARGET];
		renderPanel(ids(3));

		expect(
			screen.getByRole("button", { name: /run 3 cases/i }),
		).toBeDisabled();
	});

	it("says nothing about targets once a default resolves", () => {
		renderPanel(ids(3));

		// Matched on the two refusal sentences specifically — the panel's own
		// description mentions "environments", so a bare /environment/ match
		// would pass or fail for the wrong reason.
		expect(
			screen.queryByText(/no environments are configured/i),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText(/no default environment is set/i),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /run 3 cases/i }),
		).toBeEnabled();
	});
});
