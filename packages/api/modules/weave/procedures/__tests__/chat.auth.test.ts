import { afterEach, expect, it, vi } from "vitest";
import { chatProcedure } from "../chat";

const { sendMessageSecure, assertWeaveServiceHealthy } = vi.hoisted(() => ({
	sendMessageSecure: vi.fn(),
	assertWeaveServiceHealthy: vi.fn(async () => "https://readers.example.com"),
}));

vi.mock("@repo/agent-core", () => ({
	SecureA2AClient: class {
		sendMessageSecure = sendMessageSecure;
	},
}));
vi.mock("@repo/database", () => ({
	db: { project: { findUnique: vi.fn(async () => null) } },
	hasProjectAccess: vi.fn(async () => true),
}));
vi.mock("../../lib/weave-preflight", () => ({ assertWeaveServiceHealthy }));
// Match the nearby procedure tests: expose the handler and isolate middleware.
vi.mock("../../../../orpc/procedures", () => {
	const chainable = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		handler: (handler: unknown) => ({ _handler: handler }),
	};
	return {
		protectedProcedure: chainable,
		Permissions: { AGENT_UPDATE: "agent:update" },
		requireProjectPermission: vi.fn(),
		resolveOrganizationIdForCaller: vi.fn(async () => "example-org"),
	};
});

afterEach(() => vi.clearAllMocks());

it.each(["thread", "spindle"] as const)(
	"opts the preflighted %s reader into service authentication",
	async (agent) => {
		sendMessageSecure.mockResolvedValue({ text: "Example answer" });
		const input = {
			projectId: "example-project",
			organizationId: "example-org",
			message: "Example question",
			agent,
		};
		const context = { user: { id: "example-user" }, session: {} };
		const { _handler: handler } = chatProcedure as unknown as {
			_handler: (args: {
				input: typeof input;
				context: typeof context;
			}) => Promise<unknown>;
		};

		await expect(handler({ input, context })).resolves.toMatchObject({
			success: true,
		});

		expect(assertWeaveServiceHealthy).toHaveBeenCalledWith(
			expect.objectContaining({ envVarName: "WEAVE_READERS_URL" }),
		);
		expect(sendMessageSecure).toHaveBeenCalledExactlyOnceWith(
			`https://readers.example.com/${agent}`,
			expect.objectContaining({ role: "user" }),
			{ userId: "example-user", organizationId: "example-org" },
			expect.objectContaining({ trustedDestination: true }),
		);
	},
);
