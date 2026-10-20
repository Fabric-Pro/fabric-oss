/**
 * `agents.conversations.create` — authorization (Fizzy #3146).
 *
 * The caller's role in the organization the request runs in must grant
 * `AGENT_CREATE`. An explicit `organizationId: null` resolves to no
 * organization; before this fix the middleware passed that through with no
 * role check, so a viewer could create a conversation (stored with a null
 * organization) by sending it. There is no personal conversation (ADR-018), so
 * a request that resolves no organization is refused.
 *
 * These tests drive the REAL authorization: the procedure's own middleware
 * stack (`requireInputOrgPermission`, as mounted by the procedure), the real
 * `resolveOrganizationId` and the real `checkRegisteredAgentAccess`. Only the
 * procedure builder is replaced, so the test can run the mounted middlewares
 * and then the handler in order, and only the database edges are mocked.
 *
 * Run with: pnpm --filter @repo/api exec vitest run modules/agents/procedures/conversations/__tests__/create-conversation-authorization.test.ts
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<unknown>;
type Middleware = (
	options: { context: Record<string, unknown>; next: () => Promise<unknown> },
	input: unknown,
) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
	createAgentConversation: vi.fn(),
	getRegisteredAgentByAgentId: vi.fn(),
	getOrganizationMembership: vi.fn(),
	// Keyed by route path: create-conversation.ts imports
	// update-conversation.ts, whose procedures register through the same
	// builder first.
	procedures: {} as Record<
		string,
		{ middlewares: unknown[]; handler: Handler | null }
	>,
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	createAgentConversation: mocks.createAgentConversation,
	getRegisteredAgentByAgentId: mocks.getRegisteredAgentByAgentId,
	getOrganizationMembership: mocks.getOrganizationMembership,
}));

vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async (
		organizationId: string,
		userId: string,
	) => await mocks.getOrganizationMembership(organizationId, userId),
}));

vi.mock("../../../../../orpc/procedures", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../../../orpc/procedures")>();
	const startChain = (first: unknown) => {
		const procedure = {
			middlewares: [first] as unknown[],
			handler: null as Handler | null,
		};
		const chain: Record<string, unknown> = {};
		Object.assign(chain, {
			use: (mw: unknown) => {
				procedure.middlewares.push(mw);
				return chain;
			},
			route: (route: { path: string }) => {
				mocks.procedures[route.path] = procedure;
				return chain;
			},
			input: () => chain,
			output: () => chain,
			handler: (fn: Handler) => {
				procedure.handler = fn;
				return { _handler: fn };
			},
		});
		return chain;
	};
	return {
		...actual,
		tenantProtectedProcedure: { use: startChain },
	};
});

await import("../create-conversation");

const USER_ID = "user-1";
const ACTIVE_ORG = "org-active";
const OTHER_ORG = "org-other";
const AGENT_ID = "fabric-workspace-assistant";

/** Runs the create procedure's mounted middlewares, then its handler. */
async function invoke(input: Record<string, unknown>): Promise<unknown> {
	const procedure = mocks.procedures["/agents/conversations"];
	if (!procedure?.handler) {
		throw new Error("createConversation handler was not captured");
	}
	const handler = procedure.handler;
	const context = {
		user: { id: USER_ID, email: "dev@example.com", name: "Dev" },
		session: { id: "sess-1", activeOrganizationId: ACTIVE_ORG },
		activeOrganizationRole: "viewer",
		tenantContext: {
			userId: USER_ID,
			type: "organization",
			organizationId: ACTIVE_ORG,
		},
		headers: new Headers(),
	};
	const run = async (index: number): Promise<unknown> => {
		if (index === procedure.middlewares.length) {
			return { output: await handler({ input, context }) };
		}
		return await (procedure.middlewares[index] as Middleware)(
			{ context, next: () => run(index + 1) },
			input,
		);
	};
	const result = (await run(0)) as { output: unknown };
	return result.output;
}

/** The caller's role in each organization; absent means not a member. */
function rolesByOrganization(roles: Record<string, string>) {
	mocks.getOrganizationMembership.mockImplementation(
		async (organizationId: string, userId: string) =>
			userId === USER_ID && roles[organizationId]
				? {
						role: roles[organizationId],
						organization: { deletedAt: null },
					}
				: null,
	);
}

async function refusal(promise: Promise<unknown>) {
	const error = await promise.then(
		() => {
			throw new Error("expected a refusal");
		},
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ORPCError);
	return error as ORPCError<string, unknown>;
}

beforeEach(() => {
	mocks.createAgentConversation.mockReset();
	mocks.getRegisteredAgentByAgentId.mockReset();
	mocks.getOrganizationMembership.mockReset();
	// A SYSTEM agent is usable by anyone, so registry access never refuses
	// here: every refusal below comes from the authorization middleware.
	mocks.getRegisteredAgentByAgentId.mockResolvedValue({
		agentId: AGENT_ID,
		scope: "SYSTEM",
		status: "ACTIVE",
		userId: null,
		organizationId: null,
	});
	mocks.createAgentConversation.mockResolvedValue({
		id: "conv-1",
		agentId: AGENT_ID,
		title: null,
		createdAt: new Date("2026-10-19T00:00:00Z"),
	});
	rolesByOrganization({ [ACTIVE_ORG]: "member" });
});

describe("agents.conversations.create — authorization", () => {
	it("creates the conversation in the named organization for a role that grants AGENT_CREATE", async () => {
		await invoke({ agentId: AGENT_ID, organizationId: ACTIVE_ORG });

		expect(mocks.createAgentConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: USER_ID,
				organizationId: ACTIVE_ORG,
				agentId: AGENT_ID,
			}),
		);
	});

	it("uses the session's organization when the request names none", async () => {
		await invoke({ agentId: AGENT_ID });

		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			ACTIVE_ORG,
			USER_ID,
		);
		expect(mocks.createAgentConversation).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ACTIVE_ORG }),
		);
	});

	it("refuses an explicit null organization with the missing-organization error", async () => {
		const error = await refusal(
			invoke({ agentId: AGENT_ID, organizationId: null }),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(error.message).toBe(
			"This operation requires an organization context",
		);
		expect(mocks.createAgentConversation).not.toHaveBeenCalled();
	});

	it("refuses a viewer who sends an explicit null organization", async () => {
		rolesByOrganization({ [ACTIVE_ORG]: "viewer" });

		const error = await refusal(
			invoke({ agentId: AGENT_ID, organizationId: null }),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.createAgentConversation).not.toHaveBeenCalled();
	});

	it("refuses a viewer in the named organization, whose role lacks AGENT_CREATE", async () => {
		rolesByOrganization({ [ACTIVE_ORG]: "member", [OTHER_ORG]: "viewer" });

		const error = await refusal(
			invoke({ agentId: AGENT_ID, organizationId: OTHER_ORG }),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			OTHER_ORG,
			USER_ID,
		);
		expect(mocks.createAgentConversation).not.toHaveBeenCalled();
	});

	it("refuses an organization the caller is not a member of", async () => {
		const error = await refusal(
			invoke({ agentId: AGENT_ID, organizationId: OTHER_ORG }),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(error.message).toBe("You are not a member of this organization");
		expect(mocks.createAgentConversation).not.toHaveBeenCalled();
	});
});
