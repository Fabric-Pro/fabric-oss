/**
 * AnalysisVersionHistory — the version-history drawer for a topic's Planning
 * & Analysis prose (Fizzy #1851, Task 10).
 *
 * The behaviour that makes this component correct: restoring a revision
 * writes a NEW revision through the same save path, and that new revision
 * COPIES the restored row's `sourceAnalysisVersion` rather than adopting
 * `currentVersion`'s own source. The fixture below is built so this is not
 * an accident of the data: `CURRENT_REVISION` (the row matching the
 * `currentVersion` prop) is seeded from AI v3, while `RESTORABLE_REVISION`
 * (the one under test) is seeded from AI v1. If a restore wrongly copied the
 * CURRENT revision's `sourceAnalysisVersion` instead of the restored one's,
 * the assertions below would see `3`, not `1`, and fail — a fixture where
 * both rows carried the same `sourceAnalysisVersion` would let that bug
 * through silently.
 *
 * `VersionDiffViewer` is mocked: it is an existing, separately-tested
 * component (`@saas/projects/components/VersionDiffViewer`) this task reuses
 * rather than rebuilds, and mounting its real TipTap/diff machinery in jsdom
 * is neither needed nor reliable for a test of THIS component's own
 * list/restore wiring. `Sheet`/`Dialog`/`Badge`/`ScrollArea`/`Button` are
 * plain UI atoms and are rendered for real, the same way
 * `CoverageOverrideDialog.test.tsx` renders a real `Dialog`.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const { diffViewerPropsRef } = vi.hoisted(() => ({
	diffViewerPropsRef: {
		current: null as Record<string, unknown> | null,
	},
}));
vi.mock("@saas/projects/components/VersionDiffViewer", () => ({
	VersionDiffViewer: (props: Record<string, unknown>) => {
		diffViewerPropsRef.current = props;
		return <div data-testid="version-diff-viewer-stub" />;
	},
}));

const { saveMutationMock, mutationState, capturedMutationOptionsRef } =
	vi.hoisted(() => ({
		saveMutationMock: vi.fn(),
		mutationState: { isPending: false },
		capturedMutationOptionsRef: {
			current: null as {
				onSuccess?: (result: unknown) => void;
				onError?: (error: unknown) => void;
			} | null,
		},
	}));

const { queryStateRef, invalidateQueriesMock, fetchNextPageMock } = vi.hoisted(
	() => ({
		queryStateRef: {
			current: {
				data: undefined as
					| {
							pages: {
								revisions: unknown[];
								nextCursor: number | null;
							}[];
					  }
					| undefined,
				isLoading: false,
				hasNextPage: false,
				isFetchingNextPage: false,
				fetchNextPage: () => {},
			},
		},
		invalidateQueriesMock: vi.fn(),
		fetchNextPageMock: vi.fn(),
	}),
);

/**
 * Wrap revisions as the single first page of an infinite query.
 *
 * A helper rather than a literal at each site so a test that cares only about
 * a row does not have to restate the paging shape, and so the shape lives in
 * one place when it changes again.
 */
function onePage(revisions: unknown[], nextCursor: number | null = null) {
	return { pages: [{ revisions, nextCursor }] };
}

vi.mock("@tanstack/react-query", () => ({
	useInfiniteQuery: () => queryStateRef.current,
	useMutation: (opts: {
		onSuccess?: (result: unknown) => void;
		onError?: (error: unknown) => void;
	}) => {
		capturedMutationOptionsRef.current = opts;
		return {
			mutate: (vars: unknown) => {
				saveMutationMock(vars);
			},
			isPending: mutationState.isPending,
		};
	},
	useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
}));

// Spies (not plain functions) so a test can read back what the drawer's own
// list query actually registered, instead of hand-typing a second literal to
// compare against — see the "invalidates the list by the same topic the list
// query read" test below.
const { orpcSpies } = vi.hoisted(() => ({
	orpcSpies: {
		infiniteOptions: vi.fn((o: Record<string, unknown>) => ({
			queryKey: ["listAnalysisRevisions", o],
			queryFn: vi.fn(),
		})),
		key: vi.fn((o: Record<string, unknown>) => [
			"listAnalysisRevisions",
			o,
		]),
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			publishingSuite: {
				listAnalysisRevisions: {
					infiniteOptions: orpcSpies.infiniteOptions,
					// `key`, not `queryKey`: the drawer must invalidate with
					// the PARTIAL form, because the exact form stamps
					// `type: "query"` and would miss an infinite entry. A
					// mock exposing `queryKey` here would let that regression
					// back in without a red test.
					key: orpcSpies.key,
				},
				saveAnalysisRevision: {
					mutationOptions: (o: Record<string, unknown>) => ({
						mutationKey: ["saveAnalysisRevision"],
						...o,
					}),
				},
			},
		},
	},
}));

import { AnalysisVersionHistory } from "@saas/projects/components/publishing-suite/AnalysisVersionHistory";
import { toast } from "sonner";

const CURRENT_REVISION = {
	id: "rev-3",
	version: 3,
	body: "current body text",
	sourceAnalysisVersion: 3,
	changeSummary: null,
	authorUserId: "user-1",
	author: { id: "user-1", name: "Ada Lovelace" },
	createdAt: "2026-09-01T00:00:00.000Z",
};

const RESTORABLE_REVISION = {
	id: "rev-1",
	version: 1,
	body: "version one text",
	sourceAnalysisVersion: 1,
	changeSummary: "Initial hand edit",
	authorUserId: null,
	author: null as { id: string; name: string } | null,
	createdAt: "2026-08-01T00:00:00.000Z",
};

const baseProps = {
	open: true,
	onOpenChange: vi.fn(),
	projectId: "proj-1",
	topicId: "topic-1",
	organizationId: null as string | null,
	currentVersion: 3 as number | null,
};

beforeEach(() => {
	vi.clearAllMocks();
	mutationState.isPending = false;
	capturedMutationOptionsRef.current = null;
	diffViewerPropsRef.current = null;
	queryStateRef.current = {
		data: onePage([CURRENT_REVISION, RESTORABLE_REVISION]),
		isLoading: false,
		hasNextPage: false,
		isFetchingNextPage: false,
		fetchNextPage: fetchNextPageMock,
	};
});

describe("AnalysisVersionHistory — restore keeps the restored body's own source version", () => {
	it("restores by writing a new revision that keeps the old source version", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(
			screen.getAllByRole("button", { name: /restore/i })[0],
		);
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

		expect(saveMutationMock).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				topicId: "topic-1",
				organizationId: null,
				expectedVersion: 3,
				sourceAnalysisVersion: 1,
				body: "version one text",
			}),
		);
	});
});

describe("AnalysisVersionHistory — current revision", () => {
	it("does not offer Restore for the current revision, only for older ones", () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		expect(
			screen.getAllByRole("button", { name: /restore/i }),
		).toHaveLength(1);
		expect(screen.getByText("Current")).toBeInTheDocument();
	});
});

describe("AnalysisVersionHistory — author fallback", () => {
	it("renders 'Unknown author' for a revision with no resolved author, without hiding the row", () => {
		render(<AnalysisVersionHistory {...baseProps} />);

		// The row itself (its version number and change summary) is still
		// there — only the author name is substituted.
		expect(screen.getByText("v1")).toBeInTheDocument();
		expect(screen.getByText("Initial hand edit")).toBeInTheDocument();
		expect(screen.getByText("Unknown author")).toBeInTheDocument();
	});
});

describe("AnalysisVersionHistory — empty state", () => {
	it("shows an empty state instead of a blank drawer when there is no history yet", () => {
		queryStateRef.current = {
			...queryStateRef.current,
			data: onePage([]),
		};
		render(<AnalysisVersionHistory {...baseProps} currentVersion={null} />);

		expect(screen.getByText(/no version history yet/i)).toBeInTheDocument();
	});
});

describe("AnalysisVersionHistory — paging", () => {
	it("offers to load older versions only while the server says there are more", () => {
		queryStateRef.current = {
			...queryStateRef.current,
			data: onePage([CURRENT_REVISION], 2),
			hasNextPage: true,
		};
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		expect(
			screen.getByRole("button", { name: /load older versions/i }),
		).toBeInTheDocument();
	});

	it("hides the control on the last page, so a full final page does not invite an empty fetch", () => {
		// `hasNextPage` comes from the server's `nextCursor`, never from the
		// row count: a last page that happens to be exactly full looks
		// identical to a middle one from here.
		queryStateRef.current = {
			...queryStateRef.current,
			data: onePage([CURRENT_REVISION, RESTORABLE_REVISION]),
			hasNextPage: false,
		};
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		expect(
			screen.queryByRole("button", { name: /load older versions/i }),
		).not.toBeInTheDocument();
	});

	it("renders every page as one list, so a restored version from page two is reachable", () => {
		queryStateRef.current = {
			...queryStateRef.current,
			data: {
				pages: [
					{ revisions: [CURRENT_REVISION], nextCursor: 2 },
					{ revisions: [RESTORABLE_REVISION], nextCursor: null },
				],
			},
		};
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		expect(screen.getByText("v3")).toBeInTheDocument();
		expect(screen.getByText("v1")).toBeInTheDocument();
	});

	it("asks for the next page when the control is used", async () => {
		queryStateRef.current = {
			...queryStateRef.current,
			data: onePage([CURRENT_REVISION], 2),
			hasNextPage: true,
		};
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(
			screen.getByRole("button", { name: /load older versions/i }),
		);

		expect(fetchNextPageMock).toHaveBeenCalled();
	});
});

describe("AnalysisVersionHistory — compare view", () => {
	it("opens the diff viewer with the clicked revision's content against the current body", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(screen.getByText("v1"));

		await waitFor(() => {
			expect(
				screen.getByTestId("version-diff-viewer-stub"),
			).toBeInTheDocument();
		});

		expect(diffViewerPropsRef.current).toMatchObject({
			currentContent: "current body text",
			currentVersion: 3,
			selectedVersion: expect.objectContaining({
				version: 1,
				content: "version one text",
				author: null,
			}),
		});
	});

	it("labels the current pane with the version whose body it shows, never v0", async () => {
		// The tab's own `getPlanningAnalysis` can sit a request behind this
		// drawer's list: another client saves a revision, so the list has rows
		// while `currentVersion` is still null. The pane then falls back to the
		// newest row's BODY, and its label has to name that same row — calling
		// real text "v0" claims a version that never existed. `expectedVersion`
		// is untouched by this: it stays the null the caller passed, so the
		// compare-and-set still refuses the save.
		render(<AnalysisVersionHistory {...baseProps} currentVersion={null} />);

		await userEvent.click(screen.getByText("v1"));

		await waitFor(() => {
			expect(
				screen.getByTestId("version-diff-viewer-stub"),
			).toBeInTheDocument();
		});

		expect(diffViewerPropsRef.current).toMatchObject({
			currentContent: "current body text",
			currentVersion: 3,
		});
	});

	it("resolves a known author into a HUMAN-kind author for the diff viewer", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(screen.getByText("v3"));

		await waitFor(() => {
			expect(
				screen.getByTestId("version-diff-viewer-stub"),
			).toBeInTheDocument();
		});

		expect(
			(diffViewerPropsRef.current?.selectedVersion as { author: unknown })
				.author,
		).toEqual({ kind: "HUMAN", name: "Ada Lovelace" });
	});

	it("clicking Restore does not also open the compare view", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(
			screen.getAllByRole("button", { name: /restore/i })[0],
		);

		expect(
			screen.queryByTestId("version-diff-viewer-stub"),
		).not.toBeInTheDocument();
	});
});

describe("AnalysisVersionHistory — restore failures are recoverable, not crashes", () => {
	it("surfaces a lost-race CONFLICT with a refresh-and-retry message", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(
			screen.getAllByRole("button", { name: /restore/i })[0],
		);
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
		expect(saveMutationMock).toHaveBeenCalled();

		await act(async () => {
			capturedMutationOptionsRef.current?.onError?.({ code: "CONFLICT" });
		});

		expect(toast.error).toHaveBeenCalledWith(
			expect.stringMatching(/changed while you were editing/i),
		);
	});

	it("surfaces a stale sourceAnalysisVersion BAD_REQUEST with its own message, not the CONFLICT one", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(
			screen.getAllByRole("button", { name: /restore/i })[0],
		);
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

		await act(async () => {
			capturedMutationOptionsRef.current?.onError?.({
				code: "BAD_REQUEST",
			});
		});

		expect(toast.error).toHaveBeenCalledWith(
			expect.stringMatching(/no longer available/i),
		);
		expect(toast.error).not.toHaveBeenCalledWith(
			expect.stringMatching(/changed while you were editing/i),
		);
	});
});

describe("AnalysisVersionHistory — restore success", () => {
	it("shows a success toast naming the version the restore landed on", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(
			screen.getAllByRole("button", { name: /restore/i })[0],
		);
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

		await act(async () => {
			capturedMutationOptionsRef.current?.onSuccess?.({ version: 4 });
		});

		expect(toast.success).toHaveBeenCalledWith("Restored to version 4");
	});

	it("invalidates the list by the same topic the list query read, through the partial key form", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		// The input the drawer's OWN list query registered, read back off its
		// real `infiniteOptions()` call and never re-typed here. `input` is a
		// function of the cursor, so the first page is what it returns for
		// "no cursor yet".
		const registeredInput = (
			orpcSpies.infiniteOptions.mock.calls.at(-1)?.[0] as {
				input: (cursor: number | undefined) => Record<string, unknown>;
			}
		).input(undefined);

		await userEvent.click(
			screen.getAllByRole("button", { name: /restore/i })[0],
		);
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

		await act(async () => {
			capturedMutationOptionsRef.current?.onSuccess?.({ version: 4 });
		});

		// Same topic as the read, and NO cursor: a key carrying one would
		// match a single page and leave the rest of the list stale. The exact
		// `queryKey()` form is not merely unused here, it is absent from the
		// mock — it stamps `type: "query"` and would silently match nothing
		// now that the list is an infinite query.
		expect(orpcSpies.key).toHaveBeenCalledWith({
			input: {
				projectId: registeredInput.projectId,
				topicId: registeredInput.topicId,
				organizationId: registeredInput.organizationId,
			},
		});
		expect(invalidateQueriesMock).toHaveBeenCalledWith({
			queryKey: orpcSpies.key.mock.results.at(-1)?.value,
		});
	});

	it("closes the confirm dialog and the diff viewer after a successful restore", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(screen.getByText("v1"));
		await waitFor(() => {
			expect(
				screen.getByTestId("version-diff-viewer-stub"),
			).toBeInTheDocument();
		});

		await userEvent.click(
			screen.getAllByRole("button", { name: /restore/i })[0],
		);
		expect(
			screen.getByRole("button", { name: /confirm/i }),
		).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

		await act(async () => {
			capturedMutationOptionsRef.current?.onSuccess?.({ version: 4 });
		});

		expect(
			screen.queryByRole("button", { name: /confirm/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("version-diff-viewer-stub"),
		).not.toBeInTheDocument();
	});

	it("calls onRestore with the restored version when the prop is supplied", async () => {
		const onRestore = vi.fn();
		render(
			<AnalysisVersionHistory
				{...baseProps}
				currentVersion={3}
				onRestore={onRestore}
			/>,
		);

		await userEvent.click(
			screen.getAllByRole("button", { name: /restore/i })[0],
		);
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

		await act(async () => {
			capturedMutationOptionsRef.current?.onSuccess?.({ version: 7 });
		});

		expect(onRestore).toHaveBeenCalledWith(7);
	});

	it("does not throw when onRestore is not supplied", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(
			screen.getAllByRole("button", { name: /restore/i })[0],
		);
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

		// The assertion is reaching this line at all: with no `onRestore`
		// prop, a call to it inside `onSuccess` that isn't optionally
		// chained throws synchronously inside `act`, and the `await` below
		// would reject before the `expect` ever runs.
		await act(async () => {
			capturedMutationOptionsRef.current?.onSuccess?.({ version: 9 });
		});

		expect(toast.success).toHaveBeenCalledWith("Restored to version 9");
	});
});
