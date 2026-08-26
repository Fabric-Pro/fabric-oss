import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────
const useMutationMock = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
const mutateSpy = vi.fn();
let capturedOpts: {
	onSuccess?: (r: { cancelled: boolean }) => void;
	onError?: (e: { message: string }) => void;
} | null = null;

vi.mock("@tanstack/react-query", () => ({
	useMutation: (...args: unknown[]) => useMutationMock(...args),
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...a: unknown[]) => toastSuccess(...a),
		error: (...a: unknown[]) => toastError(...a),
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const passthrough = {
		mutationOptions: (opts: unknown) => opts,
		key: () => ["k"],
	};
	return {
		orpc: {
			reports: { instances: { cancelExecution: passthrough } },
		},
	};
});

import { CancelExecutionButton } from "../CancelExecutionButton";

beforeAll(() => {
	HTMLElement.prototype.hasPointerCapture ??= () => false;
	HTMLElement.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
	vi.clearAllMocks();
	capturedOpts = null;
	useMutationMock.mockImplementation((opts: typeof capturedOpts) => {
		capturedOpts = opts;
		return {
			mutate: (vars: unknown) => mutateSpy(vars),
			isPending: false,
		};
	});
});

const base = {
	executionId: "e1",
	executionUserId: "owner1",
	organizationId: null as string | null,
	viewerUserId: "owner1",
	viewerIsOrgAdmin: false,
	onCancelled: vi.fn(),
};

const cancelButton = () =>
	screen.queryByRole("button", { name: /cancel this report generation/i });

describe("CancelExecutionButton — visibility (R11)", () => {
	it("renders for a RUNNING run when the viewer is the owner", () => {
		render(
			<CancelExecutionButton
				{...base}
				executionStatus="RUNNING"
				onCancelled={vi.fn()}
			/>,
		);
		expect(cancelButton()).toBeInTheDocument();
	});

	it("renders for a PENDING run when the viewer is the owner", () => {
		render(
			<CancelExecutionButton
				{...base}
				executionStatus="PENDING"
				onCancelled={vi.fn()}
			/>,
		);
		expect(cancelButton()).toBeInTheDocument();
	});

	it("does not render for a terminal (COMPLETED) run", () => {
		render(
			<CancelExecutionButton
				{...base}
				executionStatus="COMPLETED"
				onCancelled={vi.fn()}
			/>,
		);
		expect(cancelButton()).not.toBeInTheDocument();
	});

	it("does not render for an org run when the viewer is neither owner nor admin", () => {
		render(
			<CancelExecutionButton
				{...base}
				executionStatus="RUNNING"
				executionUserId="someoneElse"
				organizationId="org1"
				viewerUserId="member1"
				viewerIsOrgAdmin={false}
				onCancelled={vi.fn()}
			/>,
		);
		expect(cancelButton()).not.toBeInTheDocument();
	});

	it("renders for an org run when the viewer is an org admin/owner (not the starter)", () => {
		render(
			<CancelExecutionButton
				{...base}
				executionStatus="RUNNING"
				executionUserId="someoneElse"
				organizationId="org1"
				viewerUserId="admin1"
				viewerIsOrgAdmin={true}
				onCancelled={vi.fn()}
			/>,
		);
		expect(cancelButton()).toBeInTheDocument();
	});

	it("does not render for a personal run the viewer does not own (admin flag is org-only)", () => {
		render(
			<CancelExecutionButton
				{...base}
				executionStatus="RUNNING"
				executionUserId="someoneElse"
				organizationId={null}
				viewerUserId="admin1"
				viewerIsOrgAdmin={true}
				onCancelled={vi.fn()}
			/>,
		);
		expect(cancelButton()).not.toBeInTheDocument();
	});
});

describe("CancelExecutionButton — confirm + feedback", () => {
	it("confirms with progress-loss + no-refund copy, then fires the mutation with the execution id (R2)", async () => {
		const user = userEvent.setup();
		render(
			<CancelExecutionButton
				{...base}
				executionStatus="RUNNING"
				organizationId="org1"
				onCancelled={vi.fn()}
			/>,
		);

		await user.click(cancelButton() as HTMLElement);

		expect(screen.getByText("Stop this report?")).toBeInTheDocument();
		expect(
			screen.getByText(/tokens\s+already used won't be refunded/i),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /stop report/i }));
		expect(mutateSpy).toHaveBeenCalledWith({
			executionId: "e1",
			organizationId: "org1",
		});
	});

	it("shows a success toast and calls onCancelled when cancellation sticks (R14)", () => {
		const onCancelled = vi.fn();
		render(
			<CancelExecutionButton
				{...base}
				executionStatus="RUNNING"
				onCancelled={onCancelled}
			/>,
		);
		capturedOpts?.onSuccess?.({ cancelled: true });
		expect(toastSuccess).toHaveBeenCalledWith(
			"Report generation cancelled",
		);
		expect(onCancelled).toHaveBeenCalled();
	});

	it("treats a completed-before-cancel race as success, not an error (R8/F2)", () => {
		render(
			<CancelExecutionButton
				{...base}
				executionStatus="RUNNING"
				onCancelled={vi.fn()}
			/>,
		);
		capturedOpts?.onSuccess?.({ cancelled: false });
		expect(toastSuccess).toHaveBeenCalledWith("Report already finished");
		expect(toastError).not.toHaveBeenCalled();
	});

	it("surfaces a persistent error toast on failure (R13)", () => {
		render(
			<CancelExecutionButton
				{...base}
				executionStatus="RUNNING"
				onCancelled={vi.fn()}
			/>,
		);
		capturedOpts?.onError?.({ message: "worker unreachable" });
		expect(toastError).toHaveBeenCalledWith(
			expect.stringContaining("worker unreachable"),
		);
	});
});
