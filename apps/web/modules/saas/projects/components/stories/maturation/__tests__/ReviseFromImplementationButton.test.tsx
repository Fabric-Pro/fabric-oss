/**
 * The control that asks for revised steps checked against the pull request.
 *
 * One behaviour carries the weight and it is not the button. A proposal is only
 * reachable from the out-of-date list, so a success that does not invalidate
 * that list leaves the proposal written, billed, and stranded with no way to
 * accept or reject it. That is the thing worth pinning.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mutateSpy = vi.hoisted(() => vi.fn());
const toastSpy = vi.hoisted(() => ({
	success: vi.fn(),
	warning: vi.fn(),
	error: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toastSpy }));

// The real client is generated from the router; the component only needs the one
// branch it reads. Captured so the test can drive onSuccess directly, which is
// where the invalidation lives.
let captured: { onSuccess?: (r: unknown) => void } = {};
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			testCases: {
				drift: {
					list: { key: () => ["drift"] },
					proposeFromImplementation: {
						mutationOptions: (o: {
							onSuccess?: (r: unknown) => void;
						}) => {
							captured = o;
							return { mutationFn: mutateSpy, ...o };
						},
					},
				},
			},
		},
	},
}));

import { ReviseFromImplementationButton } from "../ReviseFromImplementationButton";

function renderButton(client: QueryClient, props: { compact?: boolean } = {}) {
	return render(
		<QueryClientProvider client={client}>
			<ReviseFromImplementationButton
				projectId="p1"
				storyId="s1"
				testCaseId="tc1"
				identifier="TC-1"
				organizationId={null}
				{...props}
			/>
		</QueryClientProvider>,
	);
}

describe("ReviseFromImplementationButton", () => {
	let client: QueryClient;

	beforeEach(() => {
		vi.clearAllMocks();
		captured = {};
		client = new QueryClient({
			defaultOptions: {
				mutations: { retry: false },
				queries: { retry: false },
			},
		});
	});

	it("invalidates the out-of-date list on success, so the proposal is reachable", () => {
		const invalidate = vi.spyOn(client, "invalidateQueries");
		renderButton(client);

		captured.onSuccess?.({
			proposed: true,
			prNumber: 42,
			diffTruncated: false,
		});

		// Without this the case keeps its proposal and never appears in the list
		// that owns Accept and Reject.
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["drift"] });
	});

	it("reports a revision that found nothing, and does not claim one was made", () => {
		const invalidate = vi.spyOn(client, "invalidateQueries");
		renderButton(client);

		captured.onSuccess?.({
			proposed: false,
			rationale: "The diff removes this flow entirely.",
		});

		expect(toastSpy.warning).toHaveBeenCalledWith(
			"The diff removes this flow entirely.",
		);
		expect(toastSpy.success).not.toHaveBeenCalled();
		// Nothing was stored, so nothing became reachable.
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("says so when the diff was too large to read in full", () => {
		renderButton(client);

		captured.onSuccess?.({
			proposed: true,
			prNumber: 42,
			diffTruncated: true,
		});

		expect(toastSpy.success).toHaveBeenCalledWith(
			expect.stringContaining("too large to read in full"),
		);
	});

	it("names the case and the pull request it was revised from", () => {
		renderButton(client);

		captured.onSuccess?.({
			proposed: true,
			prNumber: 42,
			diffTruncated: false,
		});

		const [message] = toastSpy.success.mock.calls[0];
		expect(message).toContain("TC-1");
		expect(message).toContain("#42");
	});

	it("does not navigate when it sits inside a link", () => {
		// On the case list each row is an anchor. Without the preventDefault the
		// click follows the link before the request is sent.
		renderButton(client);
		const button = screen.getByRole("button");
		const event = new MouseEvent("click", {
			bubbles: true,
			cancelable: true,
		});

		fireEvent(button, event);

		expect(event.defaultPrevented).toBe(true);
	});

	it("carries an accessible name naming the case", async () => {
		renderButton(client);

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: /TC-1/ }),
			).toBeInTheDocument(),
		);
	});

	/**
	 * The visible label has two lengths because it sits in two places of very
	 * different width. Measured on a real feature: the case-list row is 363px,
	 * and the full label makes the button 192px — 53% of the row — which
	 * truncated the case title. A bare icon fixed the width and lost the
	 * affordance. These pin both ends of that trade so neither drifts back.
	 */
	describe("label length", () => {
		it("uses the full label by default, for the wider section", () => {
			renderButton(client);
			expect(screen.getByText("From implementation")).toBeInTheDocument();
			expect(screen.queryByText("Revise")).not.toBeInTheDocument();
		});

		it("uses a short label when compact, for the dense case row", () => {
			renderButton(client, { compact: true });
			expect(screen.getByText("Revise")).toBeInTheDocument();
			expect(
				screen.queryByText("From implementation"),
			).not.toBeInTheDocument();
		});

		it("keeps the same accessible name either way", async () => {
			// The visible text shortens; what a screen reader announces must
			// not, or the compact variant becomes the ambiguous one.
			const { unmount } = renderButton(client);
			const full = screen
				.getByRole("button", { name: /TC-1/ })
				.getAttribute("aria-label");
			unmount();

			renderButton(client, { compact: true });
			expect(
				screen
					.getByRole("button", { name: /TC-1/ })
					.getAttribute("aria-label"),
			).toBe(full);
		});
	});
});
