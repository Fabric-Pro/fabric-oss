import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listInputs: [] as unknown[],
	workflows: [] as unknown[],
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
			create: { mutationOptions: () => ({}) },
			list: {
				queryOptions: ({ input }: { input: unknown }) => {
					mocks.listInputs.push(input);
					return { input };
				},
			},
		},
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ mutate: vi.fn() }),
	useQuery: () => ({
		data: { workflows: mocks.workflows },
		isLoading: false,
		refetch: vi.fn(),
	}),
}));

vi.mock("../WorkflowCard", () => ({
	WorkflowCard: ({ workflow }: { workflow: { name: string } }) => (
		<div>{workflow.name}</div>
	),
}));

vi.mock("../WorkflowsHero", () => ({ WorkflowsHero: () => null }));

import { WorkflowsList } from "../WorkflowsList";

function workflow(id: string, triggerType: string, status = "PUBLISHED") {
	return { id, name: `Workflow ${id}`, triggerType, status };
}

function lastInput() {
	return mocks.listInputs.at(-1) as Record<string, unknown>;
}

function scheduledPill() {
	return screen.getByRole("button", { name: /scheduled/ });
}

beforeEach(() => {
	mocks.listInputs.length = 0;
	mocks.workflows = [
		workflow("a", "SCHEDULE"),
		workflow("b", "MANUAL"),
		workflow("c", "SCHEDULE", "PAUSED"),
	];
});

describe("WorkflowsList — the Scheduled filter", () => {
	it("counts the scheduled workflows on its pill", () => {
		render(<WorkflowsList />);

		expect(scheduledPill()).toHaveTextContent("scheduled (2)");
	});

	it("asks for every trigger type until the pill is pressed", () => {
		render(<WorkflowsList />);

		expect(lastInput().triggerType).toBeUndefined();
		expect(scheduledPill()).toHaveAttribute("aria-pressed", "false");
	});

	it("asks only for scheduled workflows once it is pressed", () => {
		render(<WorkflowsList />);

		fireEvent.click(scheduledPill());

		expect(lastInput().triggerType).toBe("SCHEDULE");
		expect(scheduledPill()).toHaveAttribute("aria-pressed", "true");
	});

	it("stops filtering when it is pressed again", () => {
		render(<WorkflowsList />);

		fireEvent.click(scheduledPill());
		fireEvent.click(scheduledPill());

		expect(lastInput().triggerType).toBeUndefined();
		expect(scheduledPill()).toHaveAttribute("aria-pressed", "false");
	});

	it("combines with a status filter instead of replacing it", () => {
		render(<WorkflowsList />);

		fireEvent.click(screen.getByRole("button", { name: /^Paused/ }));
		fireEvent.click(scheduledPill());

		expect(lastInput()).toMatchObject({
			status: "PAUSED",
			triggerType: "SCHEDULE",
		});
	});

	it("says the filters matched nothing, rather than inviting a first workflow", () => {
		mocks.workflows = [];
		render(<WorkflowsList />);

		fireEvent.click(scheduledPill());

		expect(
			screen.getByText("No workflows found matching your filters"),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Create Your First Workflow"),
		).not.toBeInTheDocument();
	});

	it("still invites a first workflow when there are none and nothing is filtered", () => {
		mocks.workflows = [];
		render(<WorkflowsList />);

		expect(
			screen.getByText("Create Your First Workflow"),
		).toBeInTheDocument();
	});
});
