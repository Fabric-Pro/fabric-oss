import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MutationState = {
	mutate: ReturnType<typeof vi.fn>;
	isPending: boolean;
	variables?: { instanceId: string };
	onError?: (error: Error) => void;
};

const mutation = vi.hoisted(
	(): MutationState => ({
		mutate: vi.fn(),
		isPending: false,
	}),
);

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		reports: {
			instances: {
				list: { key: () => ["instances"] },
				execute: { mutationOptions: (value: unknown) => value },
			},
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useMutation: (options: { onError: (error: Error) => void }) => {
		mutation.onError = options.onError;
		return mutation;
	},
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProjectReportInstancesList } from "@saas/reports/components/ProjectReportInstancesList";
import { STARTED_RUN_WAIT_MS } from "@saas/reports/lib/project-report-suite";

const report = {
	id: "example-report",
	name: "Example weekly digest",
	templateName: "Custom report",
	status: "ACTIVE",
	isActive: true,
	userId: "example-user",
	canGenerate: true,
	generateBlockedReason: null,
	lastRunAt: "2026-01-05T10:00:00.000Z",
	executionCount: 3,
	latestExecutionStatus: "COMPLETED",
	latestSuccessfulReport: null,
};

type Row = {
	latestExecutionStatus?: string | null;
	executionCount?: number;
	lastRunAt?: string | null;
};

function list(row: Row = {}) {
	return (
		<ProjectReportInstancesList
			instances={[{ ...report, ...row }]}
			viewerUserId="example-user"
			organizationId="example-org"
			reportTemplatesPath="/app/example-org/report-templates"
		/>
	);
}

function generateButton() {
	return screen.getByRole("button", { name: /Generate/ });
}

/** Presses Generate, then lets the request succeed: the list is not refetched yet. */
function pressAndSucceed(rerender: ReturnType<typeof render>["rerender"]) {
	fireEvent.click(generateButton());
	mutation.isPending = true;
	mutation.variables = { instanceId: "example-report" };
	rerender(list());
	mutation.isPending = false;
	rerender(list());
}

describe("ProjectReportInstancesList", () => {
	beforeEach(() => {
		mutation.mutate.mockClear();
		mutation.isPending = false;
		mutation.variables = undefined;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("leaves Running now once the refetched list shows the run finished", () => {
		const { rerender } = render(list({ latestExecutionStatus: "RUNNING" }));

		expect(screen.getByText(/Running now/)).toBeInTheDocument();
		expect(generateButton()).toHaveAttribute("aria-disabled", "true");

		rerender(list({ latestExecutionStatus: "COMPLETED" }));

		expect(screen.queryByText(/Running now/)).toBeNull();
		expect(screen.getByText(/Last run/)).toBeInTheDocument();
		expect(generateButton()).not.toHaveAttribute("aria-disabled");
		fireEvent.click(generateButton());
		expect(mutation.mutate).toHaveBeenCalledWith({
			instanceId: "example-report",
			organizationId: "example-org",
		});
	});

	it("keeps focus on Generate while the run starts and runs", () => {
		const { rerender } = render(list());
		const button = generateButton();
		button.focus();

		fireEvent.click(button);
		expect(mutation.mutate).toHaveBeenCalledTimes(1);

		mutation.isPending = true;
		mutation.variables = { instanceId: "example-report" };
		rerender(list());

		expect(generateButton()).toBe(button);
		expect(button).not.toBeDisabled();
		expect(button).toHaveAttribute("aria-disabled", "true");
		expect(button).toHaveFocus();

		mutation.isPending = false;
		rerender(list({ latestExecutionStatus: "PENDING", executionCount: 4 }));

		expect(button).not.toBeDisabled();
		expect(button).toHaveAttribute("aria-disabled", "true");
		expect(button).toHaveFocus();
	});

	it("stays busy after the request succeeds until the refetched list shows the run", () => {
		const { rerender } = render(list());
		const button = generateButton();
		button.focus();

		pressAndSucceed(rerender);

		// The list has not been refetched: the row still shows the last run.
		expect(button).toHaveAttribute("aria-disabled", "true");
		expect(button).toHaveFocus();
		fireEvent.click(button);
		expect(mutation.mutate).toHaveBeenCalledTimes(1);

		rerender(list({ latestExecutionStatus: "PENDING", executionCount: 4 }));

		expect(screen.getByText(/Running now/)).toBeInTheDocument();
		expect(button).toHaveAttribute("aria-disabled", "true");

		rerender(
			list({ latestExecutionStatus: "COMPLETED", executionCount: 4 }),
		);

		expect(button).not.toHaveAttribute("aria-disabled");
	});

	it("is ready again when the refetched list shows a run that already ended", () => {
		const { rerender } = render(list());

		pressAndSucceed(rerender);
		rerender(
			list({
				latestExecutionStatus: "COMPLETED",
				executionCount: 4,
				lastRunAt: "2026-01-05T11:00:00.000Z",
			}),
		);

		expect(generateButton()).not.toHaveAttribute("aria-disabled");
	});

	it("stops waiting for the run after a while", () => {
		vi.useFakeTimers();
		const { rerender } = render(list());

		pressAndSucceed(rerender);
		expect(generateButton()).toHaveAttribute("aria-disabled", "true");

		act(() => {
			vi.advanceTimersByTime(STARTED_RUN_WAIT_MS);
		});

		expect(generateButton()).not.toHaveAttribute("aria-disabled");
	});

	it("is ready again when the run could not start", () => {
		render(list());

		fireEvent.click(generateButton());
		expect(generateButton()).toHaveAttribute("aria-disabled", "true");

		act(() => {
			mutation.onError?.(new Error("Failed"));
		});

		expect(generateButton()).not.toHaveAttribute("aria-disabled");
	});

	it("ignores Generate while the report runs", () => {
		render(list({ latestExecutionStatus: "RUNNING" }));

		fireEvent.click(generateButton());

		expect(mutation.mutate).not.toHaveBeenCalled();
	});
});
