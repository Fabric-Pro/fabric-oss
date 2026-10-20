import { beforeEach, describe, expect, it, vi } from "vitest";

interface ConversationRow {
	agentId: string;
	organizationId: string | null;
	userId: string;
}

interface GroupByArgs {
	where: {
		agentId: { in: string[] };
		organizationId?: string | null;
		userId?: string;
	};
}

const mocks = vi.hoisted(() => ({
	listAgents: vi.fn(),
	countAgents: vi.fn(),
	groupBy: vi.fn(),
	resolveOrganizationId: vi.fn(),
	captured: null as
		| null
		| ((args: {
				input: {
					limit: number;
					offset: number;
					organizationId?: string | null;
				};
				context: { user: { id: string }; session: object };
		  }) => Promise<{
				agents: { agentId: string; conversationCount: number }[];
		  }>),
}));
vi.mock("@repo/database", () => ({
	listRegisteredAgents: mocks.listAgents,
	countRegisteredAgents: mocks.countAgents,
	db: { agentConversation: { groupBy: mocks.groupBy } },
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: any = {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (fn: typeof mocks.captured) => {
			mocks.captured = fn;
			return {};
		},
	};
	return {
		protectedProcedure: chain,
		Permissions: { AGENT_READ: "read" },
		requireInputOrgPermission: vi.fn(),
		resolveOrganizationId: mocks.resolveOrganizationId,
	};
});
import "../list-registered-agents";

// Conversations with one SYSTEM agent, held by two organizations and one
// personal (organization-less) row.
const conversations: ConversationRow[] = [
	{
		agentId: "system-agent",
		organizationId: "example-org",
		userId: "example-user",
	},
	{
		agentId: "system-agent",
		organizationId: "example-org",
		userId: "other-user",
	},
	{
		agentId: "system-agent",
		organizationId: "other-org",
		userId: "third-user",
	},
	{
		agentId: "system-agent",
		organizationId: "other-org",
		userId: "third-user",
	},
	{
		agentId: "system-agent",
		organizationId: "other-org",
		userId: "third-user",
	},
	{ agentId: "system-agent", organizationId: null, userId: "example-user" },
	{ agentId: "system-agent", organizationId: null, userId: "other-user" },
];

/** Apply the `where` the handler sent, the way the database would. */
function fakeGroupBy({ where }: GroupByArgs) {
	const counts = new Map<string, number>();
	for (const row of conversations) {
		if (!where.agentId.in.includes(row.agentId)) {
			continue;
		}
		if (
			"organizationId" in where &&
			row.organizationId !== where.organizationId
		) {
			continue;
		}
		if ("userId" in where && row.userId !== where.userId) {
			continue;
		}
		counts.set(row.agentId, (counts.get(row.agentId) ?? 0) + 1);
	}
	return [...counts].map(([agentId, id]) => ({ agentId, _count: { id } }));
}

const invoke = () => {
	const handler = mocks.captured;
	if (!handler) {
		throw new Error("listRegisteredAgents handler was not captured");
	}
	return handler({
		input: { limit: 50, offset: 0 },
		context: { user: { id: "example-user" }, session: {} },
	});
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.listAgents.mockResolvedValue([
		{ agentId: "system-agent", scope: "SYSTEM" },
	]);
	mocks.countAgents.mockResolvedValue(1);
	mocks.groupBy.mockImplementation(fakeGroupBy);
});

describe("listRegisteredAgents conversation counts", () => {
	it("counts only the caller's organization for a shared SYSTEM agent", async () => {
		mocks.resolveOrganizationId.mockReturnValue("example-org");

		const result = await invoke();

		expect(result.agents[0]?.conversationCount).toBe(2);
		expect(mocks.groupBy.mock.calls[0]?.[0].where).toEqual({
			agentId: { in: ["system-agent"] },
			organizationId: "example-org",
		});
	});

	it("counts only the caller's own personal rows without an organization", async () => {
		mocks.resolveOrganizationId.mockReturnValue(undefined);

		const result = await invoke();

		expect(result.agents[0]?.conversationCount).toBe(1);
		expect(mocks.groupBy.mock.calls[0]?.[0].where).toEqual({
			agentId: { in: ["system-agent"] },
			organizationId: null,
			userId: "example-user",
		});
	});
});
