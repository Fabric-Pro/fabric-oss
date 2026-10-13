/**
 * Agent task rows in the inbox read as a person-facing agent name, not the
 * raw `AgentTask.agentId` the server puts in the title (`project_setup`).
 * The global next-intl mock echoes keys, so a translated label renders as
 * its key.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const items = [
	{
		id: "agent-task-1",
		type: "agent_task",
		status: "running",
		title: "Agent task: project_setup",
		description: "Scanning repository",
		createdAt: "2026-10-01T10:00:00.000Z",
		updatedAt: "2026-10-01T10:00:00.000Z",
		metadata: { agentTaskId: "1", agentId: "project_setup" },
	},
	{
		id: "agent-task-2",
		type: "agent_task",
		status: "completed",
		title: "Agent task: release_notes",
		description: null,
		createdAt: "2026-10-01T09:00:00.000Z",
		updatedAt: "2026-10-01T09:00:00.000Z",
		metadata: { agentTaskId: "2", agentId: "release_notes" },
	},
	{
		id: "deployment-execution-1",
		type: "deployment_execution",
		status: "completed",
		title: "Deployment run: example",
		description: null,
		createdAt: "2026-10-01T08:00:00.000Z",
		updatedAt: "2026-10-01T08:00:00.000Z",
		metadata: { agentId: "project_setup" },
	},
];

vi.mock("@tanstack/react-query", async () => {
	const actual = await vi.importActual<
		typeof import("@tanstack/react-query")
	>("@tanstack/react-query");
	return {
		...actual,
		useQuery: () => ({ data: { items }, isLoading: false }),
	};
});

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		agents: { inbox: { list: { queryOptions: () => ({ queryKey: [] }) } } },
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		basePath: "/app/example-org",
	}),
}));

import { AgentInboxView } from "../AgentInboxView";

describe("AgentInboxView", () => {
	it("labels agent task rows by agent, not by raw agent id", () => {
		render(<AgentInboxView />);

		expect(screen.getByText("projectSetup")).toBeInTheDocument();
		expect(screen.getByText("Release Notes")).toBeInTheDocument();
		expect(
			screen.queryByText("Agent task: project_setup"),
		).not.toBeInTheDocument();
	});

	it("keeps the server title for other item types", () => {
		render(<AgentInboxView />);

		expect(screen.getByText("Deployment run: example")).toBeInTheDocument();
	});
});
