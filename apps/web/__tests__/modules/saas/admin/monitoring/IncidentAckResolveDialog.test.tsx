/**
 * Unit tests for `IncidentAckResolveDialog`.
 * criteria:
 *   - Acknowledge / resolve / comment actions each dispatch the correct
 *     procedure on submit.
 *   - Comment action requires a non-empty message (button disabled,
 *     toast error if forced).
 *   - Successful submit triggers `onOpenChange(false)`.
 *   - Acknowledge action is disabled when the incident is already
 *     ACKNOWLEDGED; Resolve action is disabled when RESOLVED.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockAckErrorRate,
	mockResolveErrorRate,
	mockAddCommentErrorRate,
	mockAckIntegration,
	mockResolveIntegration,
	mockAddCommentIntegration,
	mockToastSuccess,
	mockToastError,
} = vi.hoisted(() => ({
	mockAckErrorRate: vi.fn(),
	mockResolveErrorRate: vi.fn(),
	mockAddCommentErrorRate: vi.fn(),
	mockAckIntegration: vi.fn(),
	mockResolveIntegration: vi.fn(),
	mockAddCommentIntegration: vi.fn(),
	mockToastSuccess: vi.fn(),
	mockToastError: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		incidents: {
			errorRate: {
				acknowledge: (input: unknown) => mockAckErrorRate(input),
				resolve: (input: unknown) => mockResolveErrorRate(input),
				addComment: (input: unknown) => mockAddCommentErrorRate(input),
			},
		},
		integrationHealth: {
			acknowledgeIntegrationIncident: (input: unknown) =>
				mockAckIntegration(input),
			resolveIntegrationIncident: (input: unknown) =>
				mockResolveIntegration(input),
			addComment: (input: unknown) => mockAddCommentIntegration(input),
		},
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useMutation: ({
		mutationFn,
		onSuccess,
		onError,
	}: {
		mutationFn: (input: unknown) => Promise<unknown>;
		onSuccess?: (data: unknown) => void;
		onError?: (err: unknown) => void;
	}) => ({
		mutate: async (input: unknown) => {
			try {
				const result = await mutationFn(input);
				onSuccess?.(result);
			} catch (err) {
				onError?.(err);
			}
		},
		isPending: false,
	}),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("sonner", () => ({
	toast: {
		success: (msg: string) => mockToastSuccess(msg),
		error: (msg: string, opts?: unknown) => mockToastError(msg, opts),
	},
}));

import { IncidentAckResolveDialog } from "../../../../../modules/saas/admin/component/monitoring/IncidentAckResolveDialog";

function flushPromises() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	vi.clearAllMocks();
	mockAckErrorRate.mockResolvedValue({ incident: { id: "e1" } });
	mockResolveErrorRate.mockResolvedValue({ incident: { id: "e1" } });
	mockAddCommentErrorRate.mockResolvedValue({ event: { id: "ev1" } });
	mockAckIntegration.mockResolvedValue({ incident: { id: "i1" } });
	mockResolveIntegration.mockResolvedValue({ incident: { id: "i1" } });
	mockAddCommentIntegration.mockResolvedValue({ event: { id: "ev1" } });
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("IncidentAckResolveDialog", () => {
	it("dispatches acknowledge for an error-rate incident", async () => {
		const onOpenChange = vi.fn();
		render(
			<IncidentAckResolveDialog
				open
				onOpenChange={onOpenChange}
				target={{
					kind: "errorRate",
					incidentId: "e1",
					alertName: "AppErrorBudgetBurn",
					status: "FIRING",
				}}
				defaultAction="acknowledge"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /^Acknowledge$/ }));
		await flushPromises();
		expect(mockAckErrorRate).toHaveBeenCalledWith({ id: "e1" });
		expect(mockToastSuccess).toHaveBeenCalledWith(
			"Alert claimed — other admins will see it's ack'd",
		);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("dispatches resolve for an integration incident with a note", async () => {
		const onOpenChange = vi.fn();
		render(
			<IncidentAckResolveDialog
				open
				onOpenChange={onOpenChange}
				target={{
					kind: "integration",
					incidentId: "i1",
					providerName: "OpenAI",
					status: "FIRING",
				}}
				defaultAction="resolve"
			/>,
		);
		const note = screen.getByLabelText(/^Note \(optional\)$/);
		fireEvent.change(note, { target: { value: "manual close" } });
		// Submit label was renamed to make the cross-tenant "Hide for all
		// admins" semantics explicit — the action still maps to the
		// `resolve` mutation because the DB enum value is unchanged.
		fireEvent.click(
			screen.getByRole("button", { name: /^Hide for all admins$/ }),
		);
		await flushPromises();
		expect(mockResolveIntegration).toHaveBeenCalledWith({
			id: "i1",
			note: "manual close",
		});
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("requires a comment when the comment action is selected", async () => {
		const onOpenChange = vi.fn();
		render(
			<IncidentAckResolveDialog
				open
				onOpenChange={onOpenChange}
				target={{
					kind: "errorRate",
					incidentId: "e1",
					alertName: "AppErrorBudgetBurn",
					status: "FIRING",
				}}
				defaultAction="comment"
			/>,
		);
		const submit = screen.getByRole("button", { name: /Add comment/i });
		expect(submit).toBeDisabled();
		expect(mockAddCommentErrorRate).not.toHaveBeenCalled();
	});

	it("dispatches addComment when a comment is provided", async () => {
		const onOpenChange = vi.fn();
		render(
			<IncidentAckResolveDialog
				open
				onOpenChange={onOpenChange}
				target={{
					kind: "errorRate",
					incidentId: "e1",
					alertName: "AppErrorBudgetBurn",
					status: "FIRING",
				}}
				defaultAction="comment"
			/>,
		);
		const textarea = screen.getByLabelText(/^Comment \(required\)$/);
		fireEvent.change(textarea, { target: { value: "investigating" } });
		fireEvent.click(screen.getByRole("button", { name: /Add comment/i }));
		await flushPromises();
		expect(mockAddCommentErrorRate).toHaveBeenCalledWith({
			id: "e1",
			message: "investigating",
		});
		expect(mockToastSuccess).toHaveBeenCalledWith("Comment added");
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("disables the Acknowledge radio when the incident is already ACKNOWLEDGED", () => {
		render(
			<IncidentAckResolveDialog
				open
				onOpenChange={vi.fn()}
				target={{
					kind: "errorRate",
					incidentId: "e1",
					alertName: "AppErrorBudgetBurn",
					status: "ACKNOWLEDGED",
				}}
				defaultAction="resolve"
			/>,
		);
		// Click the acknowledge radio — it should remain inactive.
		const radio = document.getElementById("action-acknowledge");
		expect(radio).toBeDisabled();
	});
});
