/**
 * `removeMessage` — authorization and tenant scoping (Fizzy #2958).
 *
 * The Advisor calls this to take a refused first question back out of the
 * conversation it was created in. It must act only in an organization the
 * caller belongs to AND holds `AGENT_UPDATE` in — judged in the organization
 * the request names, not the session's — and never without an organization
 * filter.
 *
 * These tests drive the REAL authorization: the procedure's own middleware
 * stack (`requireInputOrgPermission`, as mounted by the procedure) and the
 * real `resolveOrganizationId`, both from the real `orpc/procedures` module.
 * Only the procedure builder is replaced, so the test can run the mounted
 * middlewares and then the handler in order, and only the database edges
 * (`getOrganizationMembership`, `removeConversationMessage`) are mocked.
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
	removeConversationMessage: vi.fn(),
	getOrganizationMembership: vi.fn(),
	middlewares: [] as unknown[],
	handler: null as null | Handler,
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	removeConversationMessage: mocks.removeConversationMessage,
	getOrganizationMembership: mocks.getOrganizationMembership,
}));

// The procedure no longer calls this; mocked over the same roles so a build
// of the procedure that checks only membership here is judged on the same
// data, rather than failing on a database it cannot reach.
vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async (
		organizationId: string,
		userId: string,
	) => await mocks.getOrganizationMembership(organizationId, userId),
}));

vi.mock("../../../../../orpc/procedures", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../../../orpc/procedures")>();
	const builder: Record<string, unknown> = {};
	Object.assign(builder, {
		use: (mw: unknown) => {
			mocks.middlewares.push(mw);
			return builder;
		},
		route: () => builder,
		input: () => builder,
		output: () => builder,
		handler: (fn: Handler) => {
			mocks.handler = fn;
			return { _handler: fn };
		},
	});
	return { ...actual, tenantProtectedProcedure: builder };
});

const { ConversationNotFoundError } = await import("@repo/database");
await import("../remove-message");

const USER_ID = "user-1";
const ACTIVE_ORG = "org-active";
const OTHER_ORG = "org-other";

/** Runs the procedure's mounted middlewares, then its handler. */
async function invoke(input: Record<string, unknown>): Promise<unknown> {
	const handler = mocks.handler;
	if (!handler) {
		throw new Error("removeMessage handler was not captured");
	}
	const context = {
		user: { id: USER_ID, email: "dev@example.com", name: "Dev" },
		session: { id: "sess-1", activeOrganizationId: ACTIVE_ORG },
		// What the tenant middleware sets from the session: the caller's role
		// in the ACTIVE organization, which grants AGENT_UPDATE.
		activeOrganizationRole: "member",
		tenantContext: {
			userId: USER_ID,
			type: "organization",
			organizationId: ACTIVE_ORG,
		},
		headers: new Headers(),
	};
	const run = async (index: number): Promise<unknown> => {
		if (index === mocks.middlewares.length) {
			return { output: await handler({ input, context }) };
		}
		return await (mocks.middlewares[index] as Middleware)(
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
	mocks.removeConversationMessage.mockReset();
	mocks.getOrganizationMembership.mockReset();
	mocks.removeConversationMessage.mockResolvedValue({ removed: true });
	rolesByOrganization({ [ACTIVE_ORG]: "member" });
});

describe("removeMessage — authorized in the named organization", () => {
	it("removes the message from the caller's own conversation in that organization", async () => {
		const result = await invoke({
			conversationId: "conv-1",
			messageId: "msg-seed",
			organizationId: ACTIVE_ORG,
		});

		expect(result).toEqual({ removed: true });
		expect(mocks.removeConversationMessage).toHaveBeenCalledWith({
			id: "conv-1",
			userId: USER_ID,
			organizationId: ACTIVE_ORG,
			messageId: "msg-seed",
		});
	});

	it("uses the session's organization when the request names none", async () => {
		await invoke({ conversationId: "conv-1", messageId: "msg-seed" });

		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			ACTIVE_ORG,
			USER_ID,
		);
		expect(mocks.removeConversationMessage).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ACTIVE_ORG }),
		);
	});

	it("refuses an explicit null organization instead of removing without a tenant filter", async () => {
		const error = await refusal(
			invoke({
				conversationId: "conv-1",
				messageId: "msg-seed",
				organizationId: null,
			}),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.removeConversationMessage).not.toHaveBeenCalled();
	});

	it("refuses in an organization where the caller's role lacks AGENT_UPDATE, though the active one grants it", async () => {
		rolesByOrganization({ [ACTIVE_ORG]: "member", [OTHER_ORG]: "viewer" });

		const error = await refusal(
			invoke({
				conversationId: "conv-1",
				messageId: "msg-seed",
				organizationId: OTHER_ORG,
			}),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			OTHER_ORG,
			USER_ID,
		);
		expect(mocks.removeConversationMessage).not.toHaveBeenCalled();
	});

	it("refuses an organization the caller is not a member of", async () => {
		const error = await refusal(
			invoke({
				conversationId: "conv-1",
				messageId: "msg-seed",
				organizationId: OTHER_ORG,
			}),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(error.message).toBe("You are not a member of this organization");
		expect(mocks.removeConversationMessage).not.toHaveBeenCalled();
	});

	it("reports an already-removed message as removed: false", async () => {
		mocks.removeConversationMessage.mockResolvedValueOnce({
			removed: false,
		});

		await expect(
			invoke({
				conversationId: "conv-1",
				messageId: "msg-seed",
				organizationId: ACTIVE_ORG,
			}),
		).resolves.toEqual({ removed: false });
	});
});

describe("removeMessage — not found", () => {
	it("maps ConversationNotFoundError to a generic NOT_FOUND", async () => {
		mocks.removeConversationMessage.mockRejectedValueOnce(
			new ConversationNotFoundError(),
		);

		const error = await refusal(
			invoke({
				conversationId: "conv-foreign",
				messageId: "msg-seed",
				organizationId: ACTIVE_ORG,
			}),
		);

		expect(error.code).toBe("NOT_FOUND");
		expect(error.message).toBe("Conversation not found");
	});

	it("does not disguise any other failure as NOT_FOUND", async () => {
		mocks.removeConversationMessage.mockRejectedValueOnce(
			new Error("could not serialize access"),
		);

		const error = await invoke({
			conversationId: "conv-1",
			messageId: "msg-seed",
			organizationId: ACTIVE_ORG,
		}).catch((e: unknown) => e);

		expect(error).not.toBeInstanceOf(ORPCError);
		expect((error as Error).message).toBe("could not serialize access");
	});
});
