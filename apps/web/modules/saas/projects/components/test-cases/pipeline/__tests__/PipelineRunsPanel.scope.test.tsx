/**
 * `PipelineRunsPanel` is rendered by two tabs, and they differ by exactly one
 * input: `storyId`.
 *
 * The QaPanel suite already pins the feature-tab half. This pins the half that
 * is easy to break silently and that nobody would notice for a release: the
 * PROJECT QA tab must keep showing everything. A scoping change that
 * quietly narrows the project-level surface too would hide failures from the
 * only view that can triage them, and every existing test would still pass.
 *
 * next-intl is globally key-mocked in vitest.setup.ts (labels === keys).
 */

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.fn();
const useInfiniteQueryMock = vi.fn();
const useMutationMock = vi.fn();

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
	useInfiniteQuery: (...args: unknown[]) => useInfiniteQueryMock(...args),
	useMutation: (...args: unknown[]) => useMutationMock(...args),
	useQueryClient: () => ({
		invalidateQueries: vi.fn(),
		setQueryData: vi.fn(),
	}),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

/**
 * The child sections own their own queries and are exercised elsewhere. Stubbed
 * to props-echoing markers so this suite can assert WHAT THEY WERE GIVEN — the
 * scoping contract — without dragging their internals in.
 */
vi.mock("../FindingsSection", () => ({
	FindingsSection: ({ storyId }: { storyId?: string }) => (
		<div data-testid="findings" data-story-id={storyId ?? ""} />
	),
}));
vi.mock("../UnmatchedTestsSection", () => ({
	UnmatchedTestsSection: () => <div data-testid="unmatched" />,
}));
vi.mock("../TriggerRunDialog", () => ({
	TriggerRunDialog: () => null,
}));
vi.mock("../PipelineRunDetailSheet", () => ({
	PipelineRunDetailSheet: () => null,
}));
vi.mock("../../HistoryMoreDialog", () => ({
	HISTORY_DIALOG_PAGE: 20,
	HISTORY_PANEL_PREVIEW: 5,
	HistoryMoreDialog: ({ description }: { description: string }) => (
		<div data-testid="history-description">{description}</div>
	),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			pipelineResults: {
				listRuns: {
					queryOptions: (opts: unknown) => ({
						...(opts as object),
						__key: "runs",
					}),
					key: () => ["runs"],
				},
				listRunsPage: {
					infiniteOptions: (opts: unknown) => ({
						...(opts as object),
						__key: "runsPage",
					}),
					key: () => ["runsPage"],
				},
				syncStates: {
					queryOptions: (opts: unknown) => ({
						...(opts as object),
						__key: "syncStates",
					}),
					key: () => ["syncStates"],
				},
				sources: {
					queryOptions: (opts: unknown) => ({
						...(opts as object),
						__key: "sources",
					}),
					key: () => ["sources"],
				},
				sync: { mutationOptions: (opts: unknown) => opts },
			},
			testCases: { list: { key: () => ["cases"] } },
		},
	},
}));

import { PipelineRunsPanel } from "../PipelineRunsPanel";

/** The input the named query was constructed with. */
function inputFor(key: string) {
	const call = useQueryMock.mock.calls.find(
		(c) => (c[0] as { __key?: string })?.__key === key,
	);
	return (call?.[0] as { input?: Record<string, unknown> })?.input;
}

beforeEach(() => {
	vi.clearAllMocks();
	useQueryMock.mockImplementation((opts: { __key?: string }) =>
		opts?.__key === "syncStates"
			? { data: [], isLoading: false, isError: false }
			: { data: [], isLoading: false, isError: false },
	);
	useInfiniteQueryMock.mockReturnValue({
		data: { pages: [{ runs: [], total: 0 }] },
		isLoading: false,
		isError: false,
		hasNextPage: false,
		isFetchingNextPage: false,
		fetchNextPage: vi.fn(),
	});
	useMutationMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
});

describe("PipelineRunsPanel — the two tabs differ by exactly one input", () => {
	it("asks for every run in the project when given no feature", () => {
		render(<PipelineRunsPanel projectId="p1" />);

		expect(inputFor("runs")).toEqual({ projectId: "p1", limit: 5 });
		expect(inputFor("runs")).not.toHaveProperty("storyId");
	});

	it("keeps the untracked-tests triage list, the only place those can be seen", () => {
		const { getByTestId } = render(<PipelineRunsPanel projectId="p1" />);

		expect(getByTestId("unmatched")).toBeInTheDocument();
	});

	it("passes no feature down to the failure list", () => {
		const { getByTestId } = render(<PipelineRunsPanel projectId="p1" />);

		expect(getByTestId("findings")).toHaveAttribute("data-story-id", "");
	});

	it("scopes the history dialog's pages together with the preview", () => {
		// The preview and the "View all" dialog must agree. A scoped list that
		// opens an unscoped dialog contradicts the empty state above the button.
		render(<PipelineRunsPanel projectId="p1" storyId="s1" />);

		const opts = useInfiniteQueryMock.mock.calls[0][0] as {
			input?: (offset: number) => Record<string, unknown>;
		};
		expect(opts.input?.(0)).toMatchObject({
			projectId: "p1",
			storyId: "s1",
		});
	});

	it("does not promise 'every run in this project' once the dialog is scoped", () => {
		// The dialog is the one place a user goes to check whether the list
		// above was hiding something, so its description is exactly the wrong
		// place for a stale project-wide claim. (Keys, not prose — next-intl is
		// key-mocked in vitest.setup.ts.)
		const project = render(<PipelineRunsPanel projectId="p1" />);
		expect(
			project.getByTestId("history-description"),
			// Anchored: toHaveTextContent matches substrings, so the bare key
			// would also "pass" against historyDescriptionForFeature and this
			// half of the assertion would prove nothing.
		).toHaveTextContent(/^historyDescription$/);
		project.unmount();

		const feature = render(
			<PipelineRunsPanel projectId="p1" storyId="s1" />,
		);
		expect(feature.getByTestId("history-description")).toHaveTextContent(
			"historyDescriptionForFeature",
		);
	});

	it("drops the untracked-tests list once a feature is named", () => {
		const { queryByTestId } = render(
			<PipelineRunsPanel projectId="p1" storyId="s1" />,
		);

		expect(queryByTestId("unmatched")).toBeNull();
	});
});

/**
 * "Nothing is connected" and "what you connected cannot return test runs" are
 * different problems with different fixes. The sentence that tells them apart
 * is composed server-side and was rendered only on Settings ▸ Testing — one
 * navigation away from the tab where the emptiness is actually seen, which
 * left a project that HAS connected something with no way to learn it
 * connected the wrong kind.
 */
describe("PipelineRunsPanel — why the list is empty", () => {
	const REASON =
		"Jira is connected as a project-management tool, which cannot return test runs — Fabric reads results from your CI pipeline.";

	function mockSources(data: {
		sources: unknown[];
		noSourcesReason: string | null;
	}) {
		useQueryMock.mockImplementation((opts: { __key?: string }) =>
			opts?.__key === "sources"
				? { data, isLoading: false, isError: false }
				: { data: [], isLoading: false, isError: false },
		);
	}

	it("explains an unsupported PM tool on the QA tab itself", () => {
		mockSources({ sources: [], noSourcesReason: REASON });

		const { getByText } = render(<PipelineRunsPanel projectId="p1" />);

		expect(getByText(REASON)).toBeInTheDocument();
	});

	it("stays a neutral empty state, never an error", () => {
		mockSources({ sources: [], noSourcesReason: REASON });

		const { container } = render(<PipelineRunsPanel projectId="p1" />);

		// The reason explains; it must not be styled as a failure, or a project
		// that simply has not connected a repo yet reads as broken.
		expect(container.querySelector(".text-destructive")).toBeNull();
	});

	it("says nothing extra once a source IS connected", () => {
		// `noSourcesReason` is resolved unconditionally server-side, so the
		// component — not the API — decides when it is relevant. If that gate
		// inverted, every project with a working pipeline would be told it had
		// none.
		mockSources({
			sources: [{ id: "r1" }],
			noSourcesReason: REASON,
		});

		const { queryByText } = render(<PipelineRunsPanel projectId="p1" />);

		expect(queryByText(REASON)).toBeNull();
	});
});
