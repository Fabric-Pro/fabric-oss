import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	data: undefined as any,
	error: false,
	pending: false,
	mutate: vi.fn(),
	refetch: vi.fn(),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		workflows: {
			starters: {
				list: { queryOptions: () => ({}) },
				create: { mutationOptions: (v: unknown) => v },
			},
			readiness: { queryOptions: () => ({}) },
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: m.data,
		isError: m.error,
		isPending: m.pending,
		isFetching: false,
		refetch: m.refetch,
	}),
	useMutation: () => ({ mutate: m.mutate, isPending: false }),
}));

import { WorkflowReadiness } from "../WorkflowReadiness";
import { WorkflowStarters } from "../WorkflowStarters";

beforeEach(() => {
	vi.clearAllMocks();
	m.data = undefined;
	m.error = false;
	m.pending = false;
});
it("creates a draft using the selected starter with current organization", () => {
	m.data = [
		{
			id: "action-plan",
			name: "Notes to action plan",
			description: "Summarize supplied notes.",
		},
	];
	render(
		<WorkflowStarters organizationId="example-org" onCreated={vi.fn()} />,
	);
	fireEvent.click(
		screen.getByRole("button", {
			name: "Use Notes to action plan starter",
		}),
	);
	expect(m.mutate).toHaveBeenCalledWith({
		starterId: "action-plan",
		organizationId: "example-org",
	});
	expect(
		screen.getByText(/Nothing runs or publishes automatically/),
	).toBeVisible();
});
it("distinguishes missing setup and runtime-only checks from live certification", () => {
	m.data = {
		ready: false,
		errors: [],
		checks: [
			{
				nodeId: "a",
				label: "Draft",
				status: "needs-setup",
				message: "Connect AI",
			},
			{
				nodeId: "b",
				label: "HTTP",
				status: "runtime-check",
				message: "Credentials checked when running",
			},
		],
		limitation:
			"Configuration check only. External services have not been live-tested.",
	};
	render(
		<WorkflowReadiness
			id="example-workflow"
			organizationId="example-org"
		/>,
	);
	expect(screen.getByText("Draft · Needs setup")).toBeVisible();
	expect(screen.getByText("HTTP · Checked at runtime")).toBeVisible();
	expect(screen.getByText(/not been live-tested/)).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "Check again" }));
	expect(m.refetch).toHaveBeenCalled();
});
it("offers retry rather than claiming a failed check is ready", () => {
	m.error = true;
	render(
		<WorkflowReadiness
			id="example-workflow"
			organizationId="example-org"
		/>,
	);
	expect(screen.getByRole("alert")).toHaveTextContent(
		"Could not check configuration",
	);
	expect(screen.queryByText(/No setup issues/)).toBeNull();
});
