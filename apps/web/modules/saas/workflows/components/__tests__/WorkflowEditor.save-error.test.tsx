import { ORPCError } from "@orpc/client";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	updateError: undefined as unknown,
	toastError: vi.fn(),
	toastSuccess: vi.fn(),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-example",
		basePath: "/app/org-example",
	}),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		workflows: {
			get: { queryOptions: () => ({}) },
			update: { mutationOptions: (options: unknown) => options },
			executions: {
				start: { mutationOptions: (options: unknown) => options },
			},
		},
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: {
			workflow: {
				id: "wf-1",
				name: "Weekly digest",
				status: "PUBLISHED",
				version: 1,
				publishedVersion: 1,
				nodes: [],
				edges: [],
			},
		},
		isLoading: false,
		error: null,
	}),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	useMutation: (options: {
		onError?: (error: unknown) => void;
		onSuccess?: (result: unknown) => void;
	}) => ({
		isPending: false,
		mutate: () => {
			if (mocks.updateError !== undefined) {
				options.onError?.(mocks.updateError);
			} else {
				options.onSuccess?.({});
			}
		},
	}),
}));

vi.mock("sonner", () => ({
	toast: {
		error: mocks.toastError,
		success: mocks.toastSuccess,
		warning: vi.fn(),
	},
}));

vi.mock("../WorkflowBuilder", () => ({
	WorkflowBuilder: ({
		onSave,
	}: {
		onSave: (n: unknown[], e: unknown[]) => void;
	}) => (
		<button type="button" onClick={() => onSave([], [])}>
			Save
		</button>
	),
}));
vi.mock("../WorkflowRunHistory", () => ({ WorkflowRunHistory: () => null }));
vi.mock("../ExecutionPanel", () => ({ ExecutionPanel: () => null }));

import { WorkflowEditor } from "../WorkflowEditor";

beforeEach(() => {
	mocks.updateError = undefined;
	mocks.toastError.mockClear();
	mocks.toastSuccess.mockClear();
	window.matchMedia = vi.fn().mockReturnValue({
		matches: false,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
	});
});

function save() {
	render(<WorkflowEditor workflowId="wf-1" />);
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

describe("WorkflowEditor — a save the server refuses", () => {
	it("tells the person why, when the server's refusal is written for them", () => {
		mocks.updateError = new ORPCError("BAD_REQUEST", {
			message:
				'Schedule: "*/5 * * * *" runs every 5 minutes. An agent task may run at most every 15 minutes.',
		});

		save();

		expect(mocks.toastError).toHaveBeenCalledWith(
			"Failed to save workflow",
			{
				description:
					'Schedule: "*/5 * * * *" runs every 5 minutes. An agent task may run at most every 15 minutes.',
			},
		);
	});

	it("says only that the save failed for an error that may carry internals", () => {
		mocks.updateError = new ORPCError("INTERNAL_SERVER_ERROR", {
			message:
				'duplicate key value violates unique constraint "workflow_pkey"',
		});

		save();

		expect(mocks.toastError).toHaveBeenCalledWith(
			"Failed to save workflow",
			{
				description: undefined,
			},
		);
	});

	it("says only that the save failed for an error that is not the server's answer at all", () => {
		mocks.updateError = new TypeError(
			"Failed to fetch https://internal.example/rpc",
		);

		save();

		expect(mocks.toastError).toHaveBeenCalledWith(
			"Failed to save workflow",
			{
				description: undefined,
			},
		);
	});

	it("confirms a save that went through", () => {
		save();

		expect(mocks.toastSuccess).toHaveBeenCalledWith("Workflow saved");
		expect(mocks.toastError).not.toHaveBeenCalled();
	});
});
