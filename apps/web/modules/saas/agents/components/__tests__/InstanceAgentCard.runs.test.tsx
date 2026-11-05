import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

import { InstanceAgentCard } from "../InstanceAgentCard";
import { UnifiedAgentListView } from "../UnifiedAgentListView";

beforeEach(() => push.mockReset());
afterEach(cleanup);

describe("saved agent directory entry", () => {
	it("opens the run-capable detail from the default list view", () => {
		render(
			<UnifiedAgentListView
				items={[
					{
						_type: "instance",
						id: "example-agent",
						name: "Delivery report",
						status: "ACTIVE",
						organizationId: "example-org",
					},
				]}
				basePath="/app/example-org"
				onDeleteInstance={vi.fn()}
			/>,
		);
		expect(
			screen.getByRole("link", { name: "Delivery report", exact: true }),
		).toHaveAttribute("href", "/app/example-org/agents/example-agent");
	});
	it.each(["click", "keyboard"])(
		"opens the run-capable detail page using %s",
		(method) => {
			render(
				<InstanceAgentCard
					instance={{
						id: "example-agent",
						name: "Delivery report",
						status: "ACTIVE",
						scope: "ORGANIZATION",
					}}
					basePath="/app/example-org"
					onDelete={vi.fn()}
				/>,
			);
			const tile = screen.getByRole("button", {
				name: "Open Delivery report",
			});
			expect(screen.queryByText("No runs yet")).not.toBeInTheDocument();
			expect(screen.getByText("Run & results")).toBeInTheDocument();
			if (method === "keyboard")
				fireEvent.keyDown(tile, { key: "Enter" });
			else fireEvent.click(tile);
			expect(push).toHaveBeenCalledExactlyOnceWith(
				"/app/example-org/agents/example-agent",
			);
		},
	);
});
