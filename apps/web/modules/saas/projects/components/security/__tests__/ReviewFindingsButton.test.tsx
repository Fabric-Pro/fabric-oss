import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────
const useQueryMock = vi.fn();
const useMutationMock = vi.fn();
const invalidateMock = vi.fn();
const refetchMock = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
	useMutation: (...args: unknown[]) => useMutationMock(...args),
	useQueryClient: () => ({ invalidateQueries: invalidateMock }),
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...a: unknown[]) => toastSuccess(...a),
		error: (...a: unknown[]) => toastError(...a),
		info: (...a: unknown[]) => toastInfo(...a),
	},
}));

// Thin orpc stub — every leaf returns mutation/query options + a key. The cancel
// leaf is present so the component can build its options without the router being
// wired (the real router wiring happens server-side).
vi.mock("@shared/lib/orpc-query-utils", () => {
	const passthrough = {
		queryOptions: (opts: unknown) => opts,
		mutationOptions: (opts: unknown) => opts,
		key: () => ["k"],
	};
	return {
		orpc: {
			projects: {
				scan: {
					findings: { list: passthrough },
					review: {
						latest: passthrough,
						start: passthrough,
						apply: passthrough,
						cancel: passthrough,
					},
				},
			},
		},
	};
});

// Stub the proposals dialog — its behavior is covered by its own test.
vi.mock("../ReviewProposalsDialog", () => ({
	ReviewProposalsDialog: () => null,
}));

import { ReviewFindingsButton } from "../ReviewFindingsButton";

beforeAll(() => {
	HTMLElement.prototype.hasPointerCapture ??= () => false;
	HTMLElement.prototype.scrollIntoView ??= () => {};
});

/** Captured mutate spies, keyed by which mutation registered them. */
const startMutate = vi.fn();
const applyMutate = vi.fn();
const cancelMutate = vi.fn();

/**
 * Route a `useMutation` call to the right spy by reading the registered
 * `onSuccess`/handlers indirectly: we can't see the procedure name, so we tag
 * each mutation by capturing its `mutate` and dispatching on the variables shape
 * at call time (start = no reviewId, apply = has `decisions`, cancel = reviewId
 * without `decisions`).
 */
function makeMutation(opts: { onSuccess?: (r: unknown) => void }) {
	return {
		mutate: (vars: Record<string, unknown> | undefined) => {
			if (vars && "decisions" in vars) {
				applyMutate(vars);
			} else if (vars && "reviewId" in vars) {
				cancelMutate(vars);
				// Drive the success path so the toast + refetch fire.
				opts.onSuccess?.({ cancelled: true });
			} else {
				startMutate(vars);
				// Drive start's success path (sets awaitingResult, toasts, refetch)
				// so the settle-effect is exercised, mirroring the real flow.
				opts.onSuccess?.({ status: "PENDING" });
			}
		},
		isPending: false,
		variables: undefined,
	};
}

beforeEach(() => {
	useQueryMock.mockReset();
	useMutationMock.mockReset();
	invalidateMock.mockReset();
	refetchMock.mockReset();
	toastSuccess.mockReset();
	toastError.mockReset();
	toastInfo.mockReset();
	startMutate.mockReset();
	applyMutate.mockReset();
	cancelMutate.mockReset();

	useMutationMock.mockImplementation((opts: { onSuccess?: () => void }) =>
		makeMutation(opts),
	);
});

/** Prime the latest-review query with a given review (or null). */
function primeReview(review: unknown) {
	useQueryMock.mockReturnValue({
		data: { review },
		refetch: refetchMock,
	});
}

function renderButton(openFindingCount = 3) {
	render(
		<ReviewFindingsButton
			projectId="proj-1"
			organizationId={null}
			getFindingTitle={() => undefined}
			openFindingCount={openFindingCount}
		/>,
	);
}

describe("ReviewFindingsButton — informational tooltip", () => {
	it("describes the AI review and that nothing is applied automatically", async () => {
		const user = userEvent.setup();
		primeReview(null);
		renderButton();

		// Hover the trigger to reveal the tooltip content. Radix renders the copy
		// twice (visible content + an sr-only role="tooltip" mirror), so match all.
		await user.hover(
			screen.getByRole("button", {
				name: /review open findings for false positives/i,
			}),
		);
		expect(
			(await screen.findAllByText(/nothing is applied automatically/i))
				.length,
		).toBeGreaterThan(0);
	});

	it("explains the disabled state when there are no open findings", async () => {
		const user = userEvent.setup();
		primeReview(null);
		renderButton(0);

		await user.hover(
			screen.getByRole("button", {
				name: /review open findings for false positives/i,
			}),
		);
		expect(
			(await screen.findAllByText(/no open findings to review/i)).length,
		).toBeGreaterThan(0);
	});
});

describe("ReviewFindingsButton — cancel a running review", () => {
	it("shows a Cancel button only while the review is running", () => {
		primeReview({ id: "rev-1", status: "RUNNING", proposals: [] });
		renderButton();
		expect(
			screen.getByRole("button", { name: /cancel the running review/i }),
		).toBeInTheDocument();
	});

	it("does NOT show Cancel when the review is settled", () => {
		primeReview({ id: "rev-1", status: "COMPLETED", proposals: [] });
		renderButton();
		expect(
			screen.queryByRole("button", {
				name: /cancel the running review/i,
			}),
		).not.toBeInTheDocument();
	});

	it("cancels with the review id and toasts on success", async () => {
		const user = userEvent.setup();
		primeReview({ id: "rev-1", status: "RUNNING", proposals: [] });
		renderButton();

		await user.click(
			screen.getByRole("button", { name: /cancel the running review/i }),
		);

		expect(cancelMutate).toHaveBeenCalledTimes(1);
		expect(cancelMutate.mock.calls[0][0]).toEqual({
			projectId: "proj-1",
			organizationId: null,
			reviewId: "rev-1",
		});
		expect(toastSuccess).toHaveBeenCalledWith("Review cancelled");
		// Refetches the latest review so the row flips out of the running state.
		expect(refetchMock).toHaveBeenCalled();
	});
});

describe("ReviewFindingsButton — completion toast", () => {
	it("does not re-announce the stale prior review when a new review is started", async () => {
		// Regression: on a fresh mount a prior COMPLETED review (with proposals)
		// sits in the poll cache. Clicking "Review findings" flips
		// `awaitingResult` true on a render where `review` still points at that
		// prior review. The baseline-id guard must keep the settle-effect from
		// announcing / opening the proposals dialog for that stale review (whose
		// suggestions the user could then wrongly apply) — only the review THIS
		// click starts is ever announced.
		const user = userEvent.setup();
		primeReview({
			id: "rev-prior",
			status: "COMPLETED",
			proposals: [{ suggestedStatus: "DISMISSED" }],
		});
		renderButton();

		await user.click(
			screen.getByRole("button", {
				name: /review open findings for false positives/i,
			}),
		);

		// The review was started (in-progress toast fired)…
		expect(toastInfo).toHaveBeenCalled();
		// …but the stale prior COMPLETED review is never announced as this run's
		// result (without the baseline guard this would toast "Review complete —
		// 1 suggestion ready").
		expect(toastSuccess).not.toHaveBeenCalled();
	});
});
