import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MyWorkResult } from "@repo/database";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: {
			inProgress: { items: [], total: 0 },
			needsReview: { items: [], total: 0 },
			blocked: {
				total: 1,
				items: [
					{
						id: "run-1",
						kind: "codingRun",
						title: "Billing export",
						subtitle: "Provider timed out",
						projectName: "Example Portal",
						status: "Run failed",
						href: "/app/example-org/projects/project-1/stories/story-1",
						updatedAt: new Date("2026-11-05T09:00:00.000Z"),
					},
				],
			},
			drafts: { items: [], total: 0 },
			assignedFeatures: { items: [], total: 0 },
			projectCount: 1,
			projectVisits: [],
		} satisfies MyWorkResult,
		isLoading: false,
	}),
}));
vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));

import { MyWorkPanel } from "../MyWorkPanel";

describe("MyWorkPanel", () => {
	it("renders coding runs without an unknown-kind crash", async () => {
		const user = userEvent.setup();
		render(
			<MyWorkPanel
				organizationId="org-1"
				organizationSlug="example-org"
			/>,
		);
		await user.click(screen.getByRole("tab", { name: /Blocked/ }));

		expect(screen.getByText("Billing export")).toBeInTheDocument();
		expect(screen.getByText(/Provider timed out/)).toBeInTheDocument();
	});
});
