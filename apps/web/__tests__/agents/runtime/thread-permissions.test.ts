// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	conversation: vi.fn(),
	membership: vi.fn(),
	create: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { agentConversation: { findUnique: m.conversation } },
	createAgentConversation: m.create,
	getAgentConversationById: vi.fn(),
	getOrganizationMembership: m.membership,
	getTenantContext: () => ({ effectiveWriteOrgId: null }),
	grantProjectAccess: vi.fn(),
}));

vi.mock("@repo/api/orpc/procedures", async () => {
	const guards = await import("@repo/api/orpc/middleware/require-permission");
	return {
		authorizeInputOrganization: guards.authorizeInputOrganization,
		Permissions: {
			AGENT_CREATE: "agent:create",
			AGENT_UPDATE: "agent:update",
		},
	};
});

vi.stubEnv("RBAC_DRY_RUN", "false");
const { ensureThread } = await import("@saas/agents/runtime/thread");
afterAll(() => vi.unstubAllEnvs());

const THREAD = "thread-example-research";
const CALLER = {
	userId: "user-example-1",
	organizationId: "org-example-1",
	audit: {},
};
const CREATE = {
	agentId: "fabric-ai",
	title: "Research example",
	metadata: { mode: "deep-research" },
};

beforeEach(() => {
	vi.clearAllMocks();
	m.create.mockResolvedValue({ id: THREAD });
});

describe.each(["absent", "owned"] as const)(
	"runtime conversation writes on an %s thread",
	(state) => {
		beforeEach(() => {
			m.conversation.mockResolvedValue(state === "owned" ? CALLER : null);
		});

		it.each(["viewer", "non-member"])(
			"refuses a %s through the real organization permission check",
			async (role) => {
				m.membership.mockResolvedValue(
					role === "non-member"
						? null
						: { role, organization: { deletedAt: null } },
				);
				await expect(
					ensureThread(THREAD, CALLER, CREATE),
				).resolves.toBe(false);
				expect(m.membership).toHaveBeenCalledWith(
					CALLER.organizationId,
					CALLER.userId,
				);
				expect(m.create).not.toHaveBeenCalled();
			},
		);

		it("admits a member and creates only an absent thread in the caller's organization", async () => {
			m.membership.mockResolvedValue({
				role: "member",
				organization: { deletedAt: null },
			});
			await expect(ensureThread(THREAD, CALLER, CREATE)).resolves.toBe(
				true,
			);
			if (state === "absent") {
				expect(m.create).toHaveBeenCalledExactlyOnceWith({
					id: THREAD,
					userId: CALLER.userId,
					organizationId: CALLER.organizationId,
					...CREATE,
				});
			} else {
				expect(m.create).not.toHaveBeenCalled();
			}
		});
	},
);

it.each([
	{ userId: "user-example-other", organizationId: CALLER.organizationId },
	{ userId: CALLER.userId, organizationId: "org-example-other" },
])(
	"refuses another owner or tenant before judging the organization role: %j",
	async (owner) => {
		m.conversation.mockResolvedValue(owner);
		m.membership.mockResolvedValue({
			role: "owner",
			organization: { deletedAt: null },
		});
		await expect(ensureThread(THREAD, CALLER, CREATE)).resolves.toBe(false);
		expect(m.membership).not.toHaveBeenCalled();
		expect(m.create).not.toHaveBeenCalled();
	},
);
