import { beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
	handlers: {} as Record<string, (args: any) => Promise<any>>,
	project: vi.fn(),
	member: vi.fn(),
	list: vi.fn(),
	create: vi.fn(),
	actor: vi.fn(),
	disable: vi.fn(),
	ready: vi.fn(),
	audit: vi.fn(),
	enabled: true,
	defaultConfigured: true,
}));
vi.mock("@repo/database", () => ({
	db: { project: { findUnique: f.project } },
	listRemoteAgentServers: f.list,
	createRemoteAgentServer: f.create,
	disableRemoteAgentServer: f.disable,
	getRemoteAgentServerForActor: f.actor,
}));
vi.mock("../../organizations/lib/membership", () => ({
	requireOrgMembership: f.member,
}));
vi.mock("@repo/temporal/coding-execution-rollout", () => ({
	isFabricAgentsBridgeEnabled: () => f.enabled,
}));
vi.mock("@repo/temporal/coding-execution", () => ({
	getBackgroundAgentsUrl: () => {
		if (!f.defaultConfigured) {
			throw new Error("Missing config");
		}
		return "https://deployment.example.com";
	},
	getBackgroundAgentsSecret: () => "example-secret",
	FabricBackgroundAdapter: class {
		executionReadiness = f.ready;
	},
}));
vi.mock("../../../lib/audit", () => ({ recordAuditFromRequest: f.audit }));
vi.mock("../../../orpc/procedures", () => {
	const root: any = {
		use: () => root,
		route: ({ path, method }: any) => {
			const chain: any = {
				input: () => chain,
				handler: (handler: any) => {
					f.handlers[`${method} ${path}`] = handler;
					return {};
				},
			};
			return chain;
		},
	};
	return {
		tenantProtectedProcedure: root,
		requireProjectPermission: vi.fn(),
		Permissions: { AGENT_EXECUTE: "agent:execute" },
	};
});
import "../procedures/remote-servers";
import { requireRemoteServerAccess } from "../lib/remote-server-access";

const context = { user: { id: "example-user" } };
const input = {
	projectId: "example-project",
	name: "Example server",
	url: "https://agents.example.com",
	scope: "PRIVATE",
	secret: "example-service-secret-with-32-characters",
};
beforeEach(() => {
	vi.clearAllMocks();
	f.enabled = true;
	f.project.mockResolvedValue({ organizationId: "example-org" });
	f.member.mockResolvedValue(null);
	f.ready.mockResolvedValue({ profileId: "example-profile" });
	f.list.mockResolvedValue([
		{ id: "example-server", userId: "example-user", scope: "PRIVATE" },
	]);
	f.create.mockImplementation(async ({ secret, ...data }) => ({
		id: "example-server",
		...data,
	}));
});
it("does not expose the connection owner ID or credentials in list responses", async () => {
	const result = await f.handlers["GET /coding-runs/remote-servers"]({
		input,
		context,
	});
	expect(result.servers[0]).toEqual({
		id: "example-server",
		scope: "PRIVATE",
		ownedByCaller: true,
	});
});
it("requires administrator consent before creating a team connection", async () => {
	await expect(
		f.handlers["POST /coding-runs/remote-servers"]({
			input: { ...input, scope: "TEAM" },
			context,
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(f.ready).not.toHaveBeenCalled();
	expect(f.create).not.toHaveBeenCalled();
});
it.each([
	"http://169.254.169.254",
	"https://user:password@agents.example.com",
	"https://agents.example.com/?token=secret",
	"https://agents.example.com/path",
	"http://agents.example.com",
])(
	"refuses unsafe server URL %s before probing or storing secrets",
	async (url) => {
		await expect(
			f.handlers["POST /coding-runs/remote-servers"]({
				input: { ...input, url },
				context,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(f.ready).not.toHaveBeenCalled();
		expect(f.create).not.toHaveBeenCalled();
	},
);
it("verifies server identity then stores the connection without echoing its secret", async () => {
	const result = await f.handlers["POST /coding-runs/remote-servers"]({
		input,
		context,
	});
	expect(f.create).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: "example-user",
			profileId: "example-profile",
			secret: input.secret,
		}),
	);
	expect(JSON.stringify(result)).not.toContain(input.secret);
	expect(JSON.stringify(f.audit.mock.calls)).not.toContain(input.secret);
});
it("rejects a private or cross-project connection not visible to the caller", async () => {
	f.actor.mockResolvedValue(null);
	await expect(
		requireRemoteServerAccess({
			id: "other-server",
			projectId: "example-project",
			userId: "example-user",
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it("keeps disabled rollout compatible without requiring the new table", async () => {
	f.enabled = false;
	expect(
		await f.handlers["GET /coding-runs/remote-servers"]({ input, context }),
	).toEqual({
		enabled: false,
		hasDefaultServer: false,
		canShare: false,
		servers: [],
	});
	expect(f.list).not.toHaveBeenCalled();
});

it("reports deployment server availability without returning its URL", async () => {
	f.defaultConfigured = true;
	const result = await f.handlers["GET /coding-runs/remote-servers"]({
		input,
		context,
	});
	expect(result.hasDefaultServer).toBe(true);
	expect(JSON.stringify(result)).not.toContain("deployment.example.com");
	f.defaultConfigured = false;
	const absent = await f.handlers["GET /coding-runs/remote-servers"]({
		input,
		context,
	});
	expect(absent.hasDefaultServer).toBe(false);
});
