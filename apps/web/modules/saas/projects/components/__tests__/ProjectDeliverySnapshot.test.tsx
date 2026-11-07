import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	data: undefined as unknown,
	error: false,
	refetch: vi.fn(),
	navigate: vi.fn(),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ basePath: "/app/example-org" }),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			delivery: { queryOptions: () => ({ queryKey: ["delivery"] }) },
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: m.data,
		isLoading: false,
		isError: m.error,
		refetch: m.refetch,
	}),
}));

import { ProjectDeliverySnapshot } from "../ProjectDeliverySnapshot";

beforeEach(() => {
	vi.clearAllMocks();
	m.error = false;
	m.data = {
		work: {
			available: true,
			runsAvailable: true,
			hasMore: false,
			items: [
				{
					id: "example-story",
					identifier: "US-1",
					title: "Review the result",
					tasks: [],
					runs: [
						{ status: "COMPLETED", deliveryEvidence: "PR_MERGED" },
					],
					sourceRef: "REQ-1",
				},
			],
		},
		context: { available: true, attention: 1, sources: [] },
		documents: {
			available: true,
			items: [{ id: "example-doc", title: "Project brief" }],
		},
		decisions: { available: true, items: [] },
		nextAction: {
			kind: "REVIEW_CONTEXT",
			label: "Review sources that need attention",
		},
	};
});
describe("project delivery overview", () => {
	it("links actual work and files while keeping unknown deployment explicit", () => {
		render(
			<ProjectDeliverySnapshot
				projectId="example-project"
				onNavigateToTab={m.navigate}
			/>,
		);
		expect(screen.getByRole("link", { name: /US-1/ })).toHaveAttribute(
			"href",
			"/app/example-org/projects/example-project/stories/example-story",
		);
		expect(
			screen.getByRole("link", { name: "Project brief" }),
		).toHaveAttribute(
			"href",
			"/app/example-org/projects/example-project/documents/example-doc",
		);
		expect(
			screen.getByText("PR merged · deployment unknown"),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Review sources/ }));
		expect(m.navigate).toHaveBeenCalledWith("context");
	});
	it("distinguishes unreadable documents and decisions from empty evidence", () => {
		const data = m.data as {
			documents: { available: boolean; items: unknown[] };
			decisions: { available: boolean; items: unknown[] };
		};
		data.documents = { available: false, items: [] };
		data.decisions = { available: false, items: [] };
		render(<ProjectDeliverySnapshot projectId="example-project" />);
		expect(screen.getByText(/Decisions: unavailable/)).toBeInTheDocument();
		expect(screen.getByText(/Documents: unavailable/)).toBeInTheDocument();
		expect(
			screen.queryByText(/0 recent documents/),
		).not.toBeInTheDocument();
	});
	it("does not report unreadable session evidence as zero", () => {
		const data = m.data as {
			work: { runsAvailable: boolean; items: unknown[] };
		};
		data.work.runsAvailable = false;
		data.work.items = [];
		render(
			<ProjectDeliverySnapshot
				projectId="example-project"
				onNavigateToTab={m.navigate}
			/>,
		);
		expect(
			screen.getByText("Implementation sessions: unavailable"),
		).toBeInTheDocument();
		expect(
			screen.getByText("PR merge evidence: unavailable"),
		).toBeInTheDocument();
		expect(
			screen.queryByText("0 observed PR merges"),
		).not.toBeInTheDocument();
	});
	it("shows an actionable unavailable state instead of invented zero counts", () => {
		m.error = true;
		render(<ProjectDeliverySnapshot projectId="example-project" />);
		expect(
			screen.getByText(/Delivery evidence is unavailable/),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(m.refetch).toHaveBeenCalled();
		expect(
			screen.queryByText(/0 active implementation/),
		).not.toBeInTheDocument();
	});
});
