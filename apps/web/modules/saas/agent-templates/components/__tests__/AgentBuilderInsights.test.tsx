import { fireEvent, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";

vi.mock("../AgentRunHistory", () => ({
	AgentRunHistory: ({
		instanceId,
		organizationId,
		onSelect,
	}: {
		instanceId: string;
		organizationId: string;
		onSelect: (v: unknown) => void;
	}) => (
		<button
			type="button"
			onClick={() =>
				onSelect({
					id: "example-run",
					instanceId,
					agentName: "Example",
				})
			}
		>
			{organizationId} history for {instanceId}
		</button>
	),
}));
vi.mock("../AgentRunSession", () => ({
	AgentRunSession: ({
		executionId,
		mode,
		onBack,
	}: {
		executionId: string;
		mode: string;
		onBack: () => void;
	}) => (
		<div>
			{mode}: {executionId}
			<button type="button" onClick={onBack}>
				Back to history
			</button>
		</div>
	),
}));

import { AgentBuilderInsights } from "../AgentBuilderInsights";

it("explains how new agents get evidence", () => {
	const v = render(
		<AgentBuilderInsights
			organizationId="example-org"
			agentsHref="/app/example-org/agents"
		/>,
	);
	expect(v.getByText(/Save your agent, then run a task/)).toBeInTheDocument();
	expect(v.queryByRole("button")).not.toBeInTheDocument();
});
it("opens one saved execution read-only and links to scoped paged history", () => {
	const v = render(
		<AgentBuilderInsights
			organizationId="example-org"
			instanceId="example-agent"
			agentsHref="/app/example-org/agents"
		/>,
	);
	expect(
		v.getByRole("link", { name: /Open full run history/ }),
	).toHaveAttribute(
		"href",
		"/app/example-org/agents?tab=tasks&runAgentId=example-agent",
	);
	fireEvent.click(
		v.getByRole("button", {
			name: "example-org history for example-agent",
		}),
	);
	expect(v.getByText("result: example-run")).toBeInTheDocument();
	fireEvent.click(v.getByRole("button", { name: "Back to history" }));
	expect(
		v.getByRole("button", {
			name: "example-org history for example-agent",
		}),
	).toBeInTheDocument();
});
