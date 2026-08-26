/**
 * The AI failure analysis as it appears on a finding row.
 *
 * This block sits directly beneath the assertion CI actually printed, so the
 * thing worth testing is not that it renders — it is that a reader can tell the
 * two apart. A hypothesis presented with the same weight as CI's own output is
 * how someone spends an afternoon fixing the wrong thing.
 *
 * So: the label and the model attribution must be present, an unanalysed finding
 * must show nothing rather than an empty shell, and every refusal reason must
 * reach the user as words.
 *
 * next-intl is globally key-mocked in vitest.setup.ts (labels === keys).
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.fn();
const useMutationMock = vi.fn();
const promoteMutate = vi.fn();
const analyseMutate = vi.fn();
const dismissMutate = vi.fn();
const mergeMutate = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();
const invalidateQueries = vi.fn();
/** Captured so a refusal can be replayed through the real onSuccess. */
let analyseOptions: {
	onSuccess?: (r: unknown) => void;
	onSettled?: (d: unknown, e: unknown, v: unknown) => void;
} = {};

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
	useMutation: (...args: unknown[]) => useMutationMock(...args),
	useQueryClient: () => ({ invalidateQueries, setQueryData: vi.fn() }),
}));

vi.mock("sonner", () => ({
	toast: {
		error: (...a: unknown[]) => toastError(...a),
		success: (...a: unknown[]) => toastSuccess(...a),
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			pipelineResults: {
				findings: {
					queryOptions: (opts: unknown) => opts,
					key: () => ["findings"],
				},
				promoteFinding: { mutationOptions: (opts: unknown) => opts },
				dismissFinding: { mutationOptions: (opts: unknown) => opts },
				mergeFindings: { mutationOptions: (opts: unknown) => opts },
				analyseFinding: {
					mutationOptions: (opts: unknown) => {
						analyseOptions = opts as typeof analyseOptions;
						return opts;
					},
				},
			},
		},
	},
}));

import { FindingsSection } from "../FindingsSection";

const UNANALYSED = {
	id: "f1",
	fingerprint: "fp1",
	testName: "resets the password",
	classname: "auth/password.spec.ts",
	failureMessage: "AssertionError: expected 200 to equal 401",
	status: "OPEN",
	occurrences: 4,
	firstSeenAt: "2026-07-01T00:00:00.000Z",
	lastSeenAt: "2026-07-05T00:00:00.000Z",
	testCaseId: "c1",
	promotedStoryId: null,
	suspectedCause: null,
	suspectedKind: null,
	analysedAt: null,
	analysisModel: null,
	analysisDiff: null,
};

const ANALYSED = {
	...UNANALYSED,
	suspectedCause: "The reset endpoint returns 200 for an expired token.",
	suspectedKind: "PRODUCT_BUG",
	analysedAt: "2026-07-06T00:00:00.000Z",
	analysisModel: "Claude Opus",
};

const ANALYSED_WITH_DIFF = {
	...ANALYSED,
	analysisDiff: {
		commitRange: {
			baseSha: "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			headSha: "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		},
		changedFiles: [
			{
				path: "auth/password.spec.ts",
				reason: "This is the test's own spec file, and it changed between the last passing run and this failure.",
			},
			{
				path: "src/auth/reset-token.ts",
				reason: 'Its filename shares "password", "reset" with the test.',
			},
		],
		truncated: false,
	},
};

let findings: unknown[] = [];

beforeEach(() => {
	vi.clearAllMocks();
	findings = [UNANALYSED];
	useQueryMock.mockImplementation(() => ({
		data: findings,
		isLoading: false,
		isError: false,
	}));
	// The component constructs its four mutations in a fixed order every render,
	// and this harness can only tell them apart by that order. Modulo the count,
	// NOT the raw count: the mock is called afresh on each re-render, so a
	// cumulative index sends every mutation after the first render to whichever
	// spy sits at the end. That is not hypothetical — the previous
	// "first is promote, everything else is analyse" version did exactly this,
	// and it is why a click that fired `merge` looked like it fired nothing.
	const MUTATIONS = [
		promoteMutate,
		dismissMutate,
		mergeMutate,
		analyseMutate,
	];
	useMutationMock.mockImplementation(() => ({
		mutate: MUTATIONS[(useMutationMock.mock.calls.length - 1) % 4],
		isPending: false,
	}));
});

describe("FindingsSection — the AI analysis", () => {
	it("shows nothing at all until an analysis exists", () => {
		render(<FindingsSection projectId="p1" />);

		// Not an empty shell, not a placeholder: an unanalysed finding simply has
		// no hypothesis, and inventing a box for one implies the feature failed.
		expect(screen.queryByText("analysis.label")).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /analysis.analyse/ }),
		).toBeInTheDocument();
	});

	it("labels the cause as a hypothesis and names the model that produced it", () => {
		findings = [ANALYSED];
		render(<FindingsSection projectId="p1" />);

		expect(screen.getByText("analysis.label")).toBeInTheDocument();
		expect(
			screen.getByText(
				"The reset endpoint returns 200 for an expired token.",
			),
		).toBeInTheDocument();
		// The load-bearing assertion. This block sits under the real assertion CI
		// printed; without attribution the two read as equally authoritative.
		expect(screen.getByText("analysis.byModel")).toBeInTheDocument();
		expect(
			screen.getByText("analysis.kind.PRODUCT_BUG"),
		).toBeInTheDocument();
	});

	it("shows the changed files the analysis read, each with its reason", () => {
		// The half of the analysis that shipped as backend-only: the ranked files reached
		// the model's prompt and were then discarded, so a reader saw a verdict
		// with none of the evidence behind it and no way to judge the suspects.
		findings = [ANALYSED_WITH_DIFF];
		render(<FindingsSection projectId="p1" />);

		expect(screen.getByText("analysis.changedSince")).toBeInTheDocument();
		expect(screen.getByText("src/auth/reset-token.ts")).toBeInTheDocument();
		// The reason is the point. A bare list of paths beside a confident cause
		// invites the reader to assume the ranking means more than it does.
		expect(
			screen.getByText(
				'Its filename shares "password", "reset" with the test.',
			),
		).toBeInTheDocument();
		// Abbreviated, and both ends present — a range with one sha is not a range.
		expect(screen.getByText("1111111…2222222")).toBeInTheDocument();
	});

	it("keeps the order the ranking produced", () => {
		findings = [ANALYSED_WITH_DIFF];
		render(<FindingsSection projectId="p1" />);

		// Scoped to the diff block, not the whole row: this finding's `classname`
		// is also `auth/password.spec.ts`, so a page-wide query counts the header
		// as a third file and the order assertion passes or fails for the wrong
		// reason.
		const block = screen
			.getByText("analysis.changedSince")
			.closest("div")?.parentElement;
		const rendered = [
			...(block?.querySelectorAll("li p:first-child") ?? []),
		].map((node) => node.textContent);
		// The test's own spec file scores 1 and must lead. Re-sorting in the view
		// would quietly discard the one judgement this feature makes.
		expect(rendered).toEqual([
			"auth/password.spec.ts",
			"src/auth/reset-token.ts",
		]);
	});

	it("says so when the provider capped the comparison", () => {
		findings = [
			{
				...ANALYSED_WITH_DIFF,
				analysisDiff: {
					...ANALYSED_WITH_DIFF.analysisDiff,
					truncated: true,
				},
			},
		];
		render(<FindingsSection projectId="p1" />);

		expect(screen.getByText("analysis.diffTruncated")).toBeInTheDocument();
	});

	it("renders no diff block when the analysis had none", () => {
		// Null covers "no commit range", "no connected repo", "expired token" and
		// "nothing relevant changed". An empty block would be a claim about the
		// repository; in most of those cases Fabric simply could not look.
		findings = [ANALYSED];
		render(<FindingsSection projectId="p1" />);

		expect(screen.getByText("analysis.label")).toBeInTheDocument();
		expect(
			screen.queryByText("analysis.changedSince"),
		).not.toBeInTheDocument();
	});

	it("renders a kind the UI does not know about as Inconclusive, not a crash", () => {
		// The database enum and this component's tone map live in different
		// packages, so they will drift. `t("analysis.kind.REGRESSION")` on a value
		// only the database knows is a thrown missing-message — the same
		// unknown-enum crash TestCaseResultPill shipped once already.
		findings = [{ ...ANALYSED, suspectedKind: "REGRESSION" }];

		expect(() => render(<FindingsSection projectId="p1" />)).not.toThrow();
		expect(screen.getByText("analysis.kind.UNKNOWN")).toBeInTheDocument();
		// And the badge must not keep a confident tone it no longer earns.
		expect(
			screen.queryByText("analysis.kind.REGRESSION"),
		).not.toBeInTheDocument();
	});

	it("still disclaims when the model that produced it was not recorded", () => {
		findings = [{ ...ANALYSED, analysisModel: null }];
		render(<FindingsSection projectId="p1" />);

		// A missing model must cost the attribution, never the disclaimer.
		expect(screen.getByText("analysis.disclaimer")).toBeInTheDocument();
	});

	it("offers re-analysis rather than a second opinion alongside the first", () => {
		findings = [ANALYSED];
		render(<FindingsSection projectId="p1" />);

		expect(
			screen.getByRole("button", { name: /analysis.reanalyse/ }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /analysis.analyse$/ }),
		).not.toBeInTheDocument();
	});

	it("does not promote anything when analysing", async () => {
		// The product ruling in the one place a user could confuse the two: the
		// buttons sit side by side, and "Analyse" must never file a bug.
		render(<FindingsSection projectId="p1" />);

		await userEvent.click(
			screen.getByRole("button", { name: /analysis.analyse/ }),
		);

		expect(analyseMutate).toHaveBeenCalledWith({
			projectId: "p1",
			findingId: "f1",
		});
		expect(promoteMutate).not.toHaveBeenCalled();
	});

	it("says every refusal out loud instead of failing silently", () => {
		render(<FindingsSection projectId="p1" />);

		// The procedure returns non-answers as DATA, so a component that only
		// handled onError would show a spinner stopping and nothing else.
		for (const reason of [
			"NOT_FOUND",
			"MODEL_ERROR",
			"PROMPT_UNAVAILABLE",
			"NO_CONCLUSION",
		]) {
			toastError.mockClear();
			analyseOptions.onSuccess?.({ analysed: false, reason });
			expect(toastError).toHaveBeenCalledWith(`analysisFailed.${reason}`);
		}
	});

	it("only marks the clicked row busy, never the whole list", async () => {
		// Found in review: a single in-flight id forced the button state to be
		// "is anything running", so analysing one row disabled all eight and read
		// as the whole list being busy — while the comment above it claimed that
		// was the thing being avoided.
		findings = [
			UNANALYSED,
			{ ...UNANALYSED, id: "f2", testName: "logs out" },
		];
		render(<FindingsSection projectId="p1" />);

		const buttons = screen.getAllByRole("button", {
			name: /analysis\.(analyse|running)/,
		});
		await userEvent.click(buttons[0]);

		const after = screen.getAllByRole("button", {
			name: /analysis\.(analyse|running)/,
		});
		expect(after[0]).toHaveAttribute("aria-busy", "true");
		// The other row is untouched and still actionable.
		expect(after[1]).toHaveAttribute("aria-busy", "false");
		expect(after[1]).toHaveAttribute("aria-disabled", "false");
	});

	it("keeps the clicked button focusable while it works", async () => {
		// `disabled` on the element that was just activated drops focus to <body>
		// in Chromium and Firefox, stranding a keyboard user mid-action. The
		// accessible-disable pattern is aria-disabled plus a guarded handler.
		render(<FindingsSection projectId="p1" />);

		const button = screen.getByRole("button", {
			name: /analysis.analyse/,
		});
		await userEvent.click(button);

		expect(button).not.toBeDisabled();
		expect(button).toHaveAttribute("aria-disabled", "true");
		expect(document.activeElement).not.toBe(document.body);
		// aria-disabled buys the focus behaviour but no styling: the shared
		// button only dresses the native `disabled:` pseudo-class, so without
		// this the busy button still looks pressable.
		expect(button.className).toContain("cursor-not-allowed");
	});

	it("ignores a second click on a row already being analysed", async () => {
		render(<FindingsSection projectId="p1" />);

		const button = screen.getByRole("button", {
			name: /analysis.analyse/,
		});
		await userEvent.click(button);
		await userEvent.click(button);

		// Each analysis is a billable model call; aria-disabled does not stop a
		// click on its own, so the handler has to.
		expect(analyseMutate).toHaveBeenCalledTimes(1);
	});

	it("announces success, not only failure", () => {
		// A screen-reader user otherwise gets silence from the moment they press
		// the button. It also covers the case where the analysed finding was
		// resolved meanwhile and its row vanishes on refetch — an unexplained
		// disappearing row reads as a broken feature.
		render(<FindingsSection projectId="p1" />);

		analyseOptions.onSuccess?.({ analysed: true });

		expect(toastSuccess).toHaveBeenCalledWith("analysis.done");
	});

	it("refreshes the list only when an analysis actually landed", () => {
		render(<FindingsSection projectId="p1" />);

		analyseOptions.onSuccess?.({ analysed: false, reason: "MODEL_ERROR" });
		expect(invalidateQueries).not.toHaveBeenCalled();

		analyseOptions.onSuccess?.({ analysed: true });
		expect(invalidateQueries).toHaveBeenCalled();
	});
});

describe("FindingsSection — dismissing and merging", () => {
	/** Two rows of the same fault, written before the fingerprint fix. */
	const OLDER = {
		...UNANALYSED,
		id: "older",
		testName: "TC-001 renders the accent",
		occurrences: 1,
		firstSeenAt: "2026-07-01T00:00:00.000Z",
		lastSeenAt: "2026-07-20T00:00:00.000Z",
	};
	const NEWER = {
		...UNANALYSED,
		id: "newer",
		testName: "TC-001 renders the accent",
		occurrences: 1,
		firstSeenAt: "2026-07-15T00:00:00.000Z",
		lastSeenAt: "2026-07-25T00:00:00.000Z",
	};

	it("dismisses a finding without touching promotion", async () => {
		findings = [OLDER];
		render(<FindingsSection projectId="p1" />);

		await userEvent.click(screen.getByRole("button", { name: "dismiss" }));

		expect(dismissMutate).toHaveBeenCalledWith({
			projectId: "p1",
			findingId: "older",
		});
		expect(promoteMutate).not.toHaveBeenCalled();
	});

	it("offers no merge until at least two rows are selected", async () => {
		findings = [OLDER, NEWER];
		render(<FindingsSection projectId="p1" />);

		expect(
			screen.queryByRole("button", { name: "mergeAction" }),
		).not.toBeInTheDocument();

		await userEvent.click(screen.getAllByRole("checkbox")[0]);
		// One row is a selection, not a duplicate — merging it into itself is a
		// no-op, and offering the button would imply otherwise.
		expect(
			screen.queryByRole("button", { name: "mergeAction" }),
		).not.toBeInTheDocument();

		await userEvent.click(screen.getAllByRole("checkbox")[1]);
		expect(
			screen.getByRole("button", { name: "mergeAction" }),
		).toBeInTheDocument();
	});

	it("keeps the OLDEST row and folds the newer ones into it", async () => {
		// firstSeenAt on the survivor is the true start of the fault. Keeping the
		// newest would make a problem that has been rotting since 1 July look like
		// it appeared on the 15th — the opposite of what this list is for. The
		// rows are supplied newest-first so a naive "take the first" fails here.
		findings = [NEWER, OLDER];
		render(<FindingsSection projectId="p1" />);

		for (const box of screen.getAllByRole("checkbox")) {
			await userEvent.click(box);
		}
		await userEvent.click(
			screen.getByRole("button", { name: "mergeAction" }),
		);

		expect(mergeMutate).toHaveBeenCalledWith({
			projectId: "p1",
			findingId: "older",
			duplicateIds: ["newer"],
		});
	});

	it("clears the selection without merging on cancel", async () => {
		findings = [OLDER, NEWER];
		render(<FindingsSection projectId="p1" />);

		for (const box of screen.getAllByRole("checkbox")) {
			await userEvent.click(box);
		}
		await userEvent.click(
			screen.getByRole("button", { name: "mergeCancel" }),
		);

		expect(mergeMutate).not.toHaveBeenCalled();
		expect(
			screen.queryByRole("button", { name: "mergeAction" }),
		).not.toBeInTheDocument();
	});
});
