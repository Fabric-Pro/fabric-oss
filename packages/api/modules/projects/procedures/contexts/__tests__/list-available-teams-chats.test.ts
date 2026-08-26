import { executeMicrosoftTeamsTool } from "@repo/integrations/microsoft";
import { describe, expect, it, vi } from "vitest";

const { mockHasProjectAccess } = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		hasProjectAccess: mockHasProjectAccess,
	};
});

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: vi.fn(),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => input ?? session?.activeOrganizationId ?? undefined,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

async function loadHandler() {
	const mod = await import("../list-available-teams-chats");
	return (
		mod.listAvailableTeamsChatsProcedure as unknown as {
			handler: (...args: unknown[]) => Promise<{
				chats: Array<{ id: string; topic: string; type: string }>;
				channels: unknown[];
				count: number;
				isConnected: boolean;
			}>;
		}
	).handler;
}

describe("listAvailableTeamsChatsProcedure", () => {
	const mockContext = {
		user: { id: "user-1", email: "test@example.com" },
		session: { id: "session-1", activeOrganizationId: "org-1" },
		tenantContext: { organizationId: "org-1" },
	};

	it("returns group chats and 1:1 direct chats while filtering out meeting chats", async () => {
		mockHasProjectAccess.mockResolvedValue(true);
		vi.mocked(executeMicrosoftTeamsTool).mockImplementation(
			async (toolName: string) => {
				if (toolName === "list_chats") {
					return {
						chats: [
							{
								id: "chat-group-1",
								topic: "Feature Team Alpha",
								type: "group",
								lastUpdated: "2026-08-25T10:00:00Z",
								members: "Alice, Bob, Charlie",
								lastMessage: null,
							},
							{
								id: "chat-direct-1",
								topic: "1:1 with Jane Doe",
								type: "oneOnOne",
								lastUpdated: "2026-08-25T11:00:00Z",
								members: "Jane Doe",
								lastMessage: null,
							},
							{
								id: "chat-meeting-1",
								topic: "Weekly Standup",
								type: "meeting",
								lastUpdated: "2026-08-25T12:00:00Z",
								members: "Alice, Bob",
								lastMessage: null,
							},
						],
						count: 3,
						nextCursor: null,
					};
				}
				if (toolName === "list_teams") {
					return { teams: [], count: 0 };
				}
				return {};
			},
		);

		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "proj-1", organizationId: "org-1" },
			context: mockContext,
		});

		expect(result.isConnected).toBe(true);
		expect(result.chats).toHaveLength(2); // Meeting chat filtered out
		expect(result.chats[0]).toMatchObject({
			id: "chat-group-1",
			topic: "Feature Team Alpha",
			type: "group",
		});
		expect(result.chats[1]).toMatchObject({
			id: "chat-direct-1",
			topic: "1:1 with Jane Doe",
			type: "oneOnOne",
		});
		expect(result.count).toBe(2);
	});
});
