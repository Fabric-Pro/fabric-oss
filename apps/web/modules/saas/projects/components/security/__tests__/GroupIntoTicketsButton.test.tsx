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

// Thin orpc stub — the "propose → review → apply" button only reads the grouping
// latest poll + the start/cancel mutations. Every leaf returns options + a key.
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
					grouping: {
						latest: passthrough,
						start: passthrough,
						cancel: passthrough,
					},
				},
			},
		},
	};
});

// Stub the review dialog — its own behavior is covered by its own test. Capture
// the props it's rendered with so we can assert when a started run opens it.
const { dialogSpy } = vi.hoisted(() => ({ dialogSpy: vi.fn() }));
vi.mock("../GroupingResultsDialog", () => ({
	GroupingResultsDialog: (props: { isOpen: boolean }) => {
		dialogSpy(props);
		return null;
	},
}));

import { GroupIntoTicketsButton } from "../GroupIntoTicketsButton";

beforeAll(() => {
	HTMLElement.prototype.hasPointerCapture ??= () => false;
	HTMLElement.prototype.scrollIntoView ??= () => {};
});

/** Captured mutate spies, keyed by which mutation registered them. */
const startMutate = vi.fn();
const cancelMutate = vi.fn();

/**
 * Route a `useMutation` call to the right spy by dispatching on the variables
 * shape at call time (start = no groupingId, cancel = has groupingId). Both
 * paths drive their real `onSuccess` handler so the toast/refetch effects the
 * component wires up in `mutationOptions` actually fire.
 */
function makeMutation(opts: { onSuccess?: (r: unknown) => void }) {
	return {
		mutate: (vars: Record<string, unknown> | undefined) => {
			if (vars && "groupingId" in vars) {
				cancelMutate(vars);
				opts.onSuccess?.({ cancelled: true });
			} else {
				startMutate(vars);
				opts.onSuccess?.({ groupingId: "grp-new", status: "PENDING" });
			}
		},
		isPending: false,
		variables: undefined,
	};
}

/**
 * The single `scan.grouping.latest` poll the button reads. `currentGrouping` is
 * mutable so a test can have `refetch` (fired inside the start mutation's
 * onSuccess) reveal the run the click produced — mirroring the poll seeing the
 * run advance to AWAITING_REVIEW / FAILED on the next tick.
 */
let currentGrouping: unknown = null;

function primeGrouping(grouping: unknown) {
	currentGrouping = grouping;
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
	cancelMutate.mockReset();
	dialogSpy.mockReset();
	currentGrouping = null;

	useQueryMock.mockImplementation(() => ({
		data: { grouping: currentGrouping },
		refetch: refetchMock,
	}));
	useMutationMock.mockImplementation((opts: { onSuccess?: () => void }) =>
		makeMutation(opts),
	);
});

function renderButton(openFindingCount = 3) {
	render(
		<GroupIntoTicketsButton
			projectId="proj-1"
			organizationId={null}
			openFindingCount={openFindingCount}
		/>,
	);
}

const mainButtonName = /group open findings into thematic tickets/i;
/** The review dialog's `isOpen` on the most recent render. */
const dialogIsOpen = () => dialogSpy.mock.calls.at(-1)?.[0]?.isOpen;

describe("GroupIntoTicketsButton — enablement", () => {
	it("is disabled with the no-findings tooltip when openFindingCount is 0", async () => {
		const user = userEvent.setup();
		primeGrouping(null);
		renderButton(0);

		const button = screen.getByRole("button", { name: mainButtonName });
		expect(button).toBeDisabled();

		await user.hover(button);
		expect(
			(
				await screen.findAllByText(
					/no open findings to group into tickets/i,
				)
			).length,
		).toBeGreaterThan(0);
	});

	it("is enabled when there are open findings and no run is in flight", () => {
		primeGrouping(null);
		renderButton(3);
		expect(
			screen.getByRole("button", { name: mainButtonName }),
		).toBeEnabled();
	});
});

describe("GroupIntoTicketsButton — starting a run", () => {
	it("starts grouping, shows the preparing toast, and refetches", async () => {
		const user = userEvent.setup();
		primeGrouping(null);
		renderButton();

		await user.click(screen.getByRole("button", { name: mainButtonName }));

		expect(startMutate).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
		});
		expect(toastInfo).toHaveBeenCalledWith(
			expect.stringMatching(/preparing tickets to review/i),
			expect.objectContaining({ description: expect.any(String) }),
		);
		expect(refetchMock).toHaveBeenCalled();
	});
});

describe("GroupIntoTicketsButton — a started run settles", () => {
	it("opens the review dialog when a run the user started reaches AWAITING_REVIEW", async () => {
		const user = userEvent.setup();
		primeGrouping(null);
		// The click starts a run; refetch (called inside the start onSuccess)
		// surfaces it as AWAITING_REVIEW — the settle-effect must open the review.
		refetchMock.mockImplementation(() => {
			currentGrouping = {
				id: "grp-new",
				status: "AWAITING_REVIEW",
				results: { proposedCreate: [], proposedUpdate: [] },
			};
		});
		renderButton();

		await user.click(screen.getByRole("button", { name: mainButtonName }));

		expect(dialogIsOpen()).toBe(true);
		// …and it surfaces the "Review tickets" re-open affordance.
		expect(
			screen.getByRole("button", { name: /review tickets/i }),
		).toBeInTheDocument();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("shows an error toast (and does NOT open the dialog) when a started run FAILS", async () => {
		const user = userEvent.setup();
		primeGrouping(null);
		refetchMock.mockImplementation(() => {
			currentGrouping = {
				id: "grp-new",
				status: "FAILED",
				error: "pipeline crashed",
			};
		});
		renderButton();

		await user.click(screen.getByRole("button", { name: mainButtonName }));

		expect(toastError).toHaveBeenCalledWith(
			expect.stringMatching(/grouping couldn't finish/i),
			expect.objectContaining({ description: "pipeline crashed" }),
		);
		expect(dialogIsOpen()).toBe(false);
	});
});

describe("GroupIntoTicketsButton — re-open affordances", () => {
	it("disables the main button and shows 'Review tickets' while AWAITING_REVIEW", async () => {
		const user = userEvent.setup();
		primeGrouping({ id: "grp-1", status: "AWAITING_REVIEW", results: {} });
		renderButton();

		expect(
			screen.getByRole("button", { name: mainButtonName }),
		).toBeDisabled();

		await user.click(
			screen.getByRole("button", { name: /review tickets/i }),
		);
		expect(dialogIsOpen()).toBe(true);
	});

	it("shows 'View last run' when the latest run is COMPLETED and reopens it", async () => {
		const user = userEvent.setup();
		primeGrouping({ id: "grp-1", status: "COMPLETED", results: {} });
		renderButton();

		await user.click(
			screen.getByRole("button", { name: /view last run/i }),
		);
		expect(dialogIsOpen()).toBe(true);
	});
});

describe("GroupIntoTicketsButton — cancel a running grouping", () => {
	it("shows a Cancel button only while the run is running", () => {
		primeGrouping({ id: "grp-1", status: "RUNNING" });
		renderButton();
		expect(
			screen.getByRole("button", {
				name: /cancel the running grouping/i,
			}),
		).toBeInTheDocument();
	});

	it("does NOT show Cancel when the run is settled", () => {
		primeGrouping({ id: "grp-1", status: "COMPLETED", results: {} });
		renderButton();
		expect(
			screen.queryByRole("button", {
				name: /cancel the running grouping/i,
			}),
		).not.toBeInTheDocument();
	});

	it("cancels with the grouping id and toasts on success", async () => {
		const user = userEvent.setup();
		primeGrouping({ id: "grp-1", status: "RUNNING" });
		renderButton();

		await user.click(
			screen.getByRole("button", {
				name: /cancel the running grouping/i,
			}),
		);

		expect(cancelMutate).toHaveBeenCalledTimes(1);
		expect(cancelMutate.mock.calls[0][0]).toEqual({
			projectId: "proj-1",
			organizationId: null,
			groupingId: "grp-1",
		});
		expect(toastSuccess).toHaveBeenCalledWith("Grouping cancelled");
		expect(refetchMock).toHaveBeenCalled();
	});
});

describe("GroupIntoTicketsButton — baseline guard", () => {
	it("does not open the dialog or toast for a settled run it did not start", () => {
		// A COMPLETED run already sits in the poll cache on first render (e.g.
		// after a refresh). The component never set awaitingResult for it, so the
		// settle-effect must stay a no-op: no toast, dialog closed.
		primeGrouping({ id: "grp-1", status: "COMPLETED", results: {} });
		renderButton();

		expect(toastInfo).not.toHaveBeenCalled();
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
		expect(dialogIsOpen()).toBe(false);
	});

	it("does not announce the stale prior run when a new run is started", async () => {
		// On click, awaitingResult flips true on a render where `grouping` still
		// points at the prior COMPLETED run (the started run hasn't surfaced yet).
		// The baseline-id guard keeps the settle-effect from announcing / opening
		// for that prior run — only the run THIS click starts is ever announced.
		const user = userEvent.setup();
		primeGrouping({ id: "grp-prior", status: "COMPLETED", results: {} });
		// refetch does NOT surface a new run — the poll still returns the prior run.
		renderButton();

		await user.click(screen.getByRole("button", { name: mainButtonName }));

		expect(toastInfo).toHaveBeenCalled(); // the run WAS started
		expect(toastError).not.toHaveBeenCalled();
		expect(dialogIsOpen()).toBe(false);
	});
});
