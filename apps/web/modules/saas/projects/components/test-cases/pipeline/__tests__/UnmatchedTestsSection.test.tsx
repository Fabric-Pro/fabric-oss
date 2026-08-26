/**
 * UnmatchedTestsSection — the coverage-gap triage list.
 *
 * The behaviour worth pinning: a created row cannot leave the list until the
 * next sync re-links it, so the row must stop offering "Create case" the moment
 * one succeeds. Without that, a second click files a duplicate case for the same
 * automated test (observed on staging: TC-151 and TC-152, same test, two clicks).
 *
 * next-intl is globally key-mocked in vitest.setup.ts (labels === keys).
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.fn();
const createSpy = vi.fn();

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
	// A create that actually resolves: invoking mutate runs the caller's
	// onSuccess with the variables it was given, which is the contract the
	// component's created-row bookkeeping depends on.
	useMutation: (opts: {
		onSuccess?: (data: unknown, variables: unknown) => void;
		onSettled?: () => void;
	}) => ({
		mutate: (variables: unknown) => {
			createSpy(variables);
			opts.onSuccess?.({ testCase: { id: "tc1" } }, variables);
			opts.onSettled?.();
		},
		isPending: false,
	}),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			pipelineResults: {
				unmatchedTests: {
					queryOptions: (opts: unknown) => opts,
					key: () => ["unmatchedTests"],
				},
			},
			testCases: {
				create: { mutationOptions: (opts: unknown) => opts },
				list: { key: () => ["cases"] },
			},
		},
	},
}));

import { UnmatchedTestsSection } from "../UnmatchedTestsSection";

const mkTest = (name: string) => ({
	name,
	classname: "test/cart.test.js",
	occurrences: 1,
	lastStatus: "PASSED",
	lastSeenAt: null,
	provider: "github-actions",
});

beforeEach(() => {
	vi.clearAllMocks();
	useQueryMock.mockReturnValue({
		data: {
			tests: [
				mkTest("cart > starts empty"),
				mkTest("cart > counts items"),
			],
			totalDistinct: 2,
			scannedRuns: 11,
		},
		isLoading: false,
		isError: false,
	});
});

const props = { projectId: "p1", organizationId: null };

describe("UnmatchedTestsSection", () => {
	it("seeds the new case with the test's own name and file so the cascade claims it", async () => {
		render(<UnmatchedTestsSection {...props} />);

		await userEvent.click(
			screen.getAllByRole("button", { name: /createCase/ })[0],
		);

		expect(createSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "p1",
				title: "cart > starts empty",
				automationStatus: "AUTOMATED",
				automationRef: "cart > starts empty",
				automationFilePath: "test/cart.test.js",
			}),
		);
	});

	it("stops offering Create case on a row whose case was created", async () => {
		render(<UnmatchedTestsSection {...props} />);
		expect(
			screen.getAllByRole("button", { name: /createCase/ }),
		).toHaveLength(2);

		await userEvent.click(
			screen.getAllByRole("button", { name: /createCase/ })[0],
		);

		// The created row swaps to a marker; the untouched row keeps its button,
		// so the list is still usable for the rest of the queue.
		expect(screen.getByText("caseCreated")).toBeInTheDocument();
		expect(
			screen.getAllByRole("button", { name: /createCase/ }),
		).toHaveLength(1);
	});

	it("does not file a second case when the same row is clicked again", async () => {
		render(<UnmatchedTestsSection {...props} />);

		const first = screen.getAllByRole("button", { name: /createCase/ })[0];
		await userEvent.click(first);
		// The row is still on screen (it only drains on the next sync) — clicking
		// where the button was must not create a duplicate.
		await userEvent.click(screen.getByText("caseCreated"));

		expect(createSpy).toHaveBeenCalledTimes(1);
	});

	it("renders nothing when every automated test is tracked", () => {
		useQueryMock.mockReturnValue({
			data: { tests: [], totalDistinct: 0, scannedRuns: 4 },
			isLoading: false,
			isError: false,
		});
		const { container } = render(<UnmatchedTestsSection {...props} />);
		expect(container).toBeEmptyDOMElement();
	});
});
