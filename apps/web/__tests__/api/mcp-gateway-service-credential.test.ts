/**
 * `POST /api/mcp-gateway` — Fabric's own agent runtime acting for a user.
 *
 * The shared agent service secret proves the caller is Fabric's runtime; the
 * acting-user and acting-organization headers say whom it acts for. These
 * tests drive the real route and the real session store:
 *
 * 1. A valid secret and a member of the named organization open a session with
 *    `credential: "service"`, the acting context, and only the service scopes.
 * 2. A wrong or absent secret is a 401 and never falls through to another
 *    credential; a user outside the named organization is refused; a call that
 *    does not say whom it acts for is refused.
 * 3. A session is reused only for the same acting context, and a service call
 *    is not recorded as a CLI connection.
 */

import {
	mintActingGrant,
	mintParlumeActingGrantForTurn,
} from "@repo/api/lib/agent-service-auth";
import { signToken } from "@repo/auth/lib/signed-token";
import { fabricGatewayTool } from "@repo/temporal/fabric-gateway-tools";
import { confirmationMeta } from "@repo/temporal/fabric-tool-definition";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const SECRET = "service-secret-for-tests";
process.env.AGENT_SERVICE_SECRET = SECRET;
process.env.BETTER_AUTH_SECRET = "test-secret-that-is-at-least-32-chars-long";

vi.mock("@repo/api/modules/users/procedures/api-keys", () => ({
	verifyUserApiKey: vi.fn().mockResolvedValue({ valid: false }),
}));

const getSession = vi.fn();
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (...args: unknown[]) => getSession(...args) } },
}));

const executePlatformTool = vi.fn();
const getAggregatedTools = vi.fn();
vi.mock("@saas/mcp/lib/gateway", async () => {
	const store = await import(
		"../../modules/saas/mcp/lib/gateway/session-store"
	);
	return {
		createGatewaySession: store.createGatewaySession,
		getGatewaySession: store.getGatewaySession,
		deleteGatewaySession: store.deleteGatewaySession,
		updateSessionOrganization: store.updateSessionOrganization,
		executePlatformTool: (...args: unknown[]) =>
			executePlatformTool(...args),
		executeConnectedServerTool: vi.fn(),
		getAggregatedTools: (...args: unknown[]) => getAggregatedTools(...args),
	};
});

const recordCliReach = vi.fn();
vi.mock("@saas/mcp/lib/record-cli-reach", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/mcp/lib/record-cli-reach")
	>()),
	recordCliReach: (...args: unknown[]) => recordCliReach(...args),
}));

const isOrganizationMember = vi.fn();
const findUser = vi.fn();
const resolveProjectTarget = vi.fn();
vi.mock("@repo/database", () => ({
	resolveOAuthProjectGrantTarget: (userId: string, projectId: string) =>
		resolveProjectTarget(userId, projectId),
	isOrganizationLive: vi.fn().mockResolvedValue(true),
	db: { user: { findUnique: (...args: unknown[]) => findUser(...args) } },
	isOrganizationMember: (userId: string, organizationId: string) =>
		isOrganizationMember(userId, organizationId),
	resolveUserOrganization: vi.fn(),
	getOrganizationApiKeyByPrefix: vi.fn(),
	updateOrganizationApiKeyUsage: vi.fn(),
}));

const GATEWAY_URL = "http://localhost:3001/api/mcp-gateway";
const USER_ID = "user-1";
const ORG_A = "org-example-alpha";
const ORG_B = "org-example-beta";
const PROJECT_ID = "project-meeting";

function headers(extra: Record<string, string> = {}): Record<string, string> {
	return {
		host: "localhost:3001",
		"content-type": "application/json",
		accept: "application/json",
		...extra,
	};
}

/**
 * A service call as the worker makes it: the shared secret, who it acts for,
 * and the acting grant the web route minted for that person's turn. The grant
 * follows the acting headers unless a test names its own.
 */
function serviceHeaders(
	extra: Record<string, string> = {},
): Record<string, string> {
	const userId = extra["x-fabric-acting-user"] ?? USER_ID;
	const organizationId = extra["x-fabric-acting-organization"] ?? ORG_A;
	return {
		"x-agent-service-token": SECRET,
		"x-fabric-acting-user": userId,
		"x-fabric-acting-organization": organizationId,
		"x-fabric-acting-grant": mintActingGrant({
			userId,
			organizationId,
			conversationId: extra["x-fabric-conversation"],
		}),
		...extra,
	};
}

function body(method: string, params: unknown = {}): unknown {
	return { jsonrpc: "2.0", id: 1, method, params };
}

const loadRoute = () => import("../../app/api/mcp-gateway/route");

beforeAll(async () => {
	await loadRoute();
}, 120_000);

async function post(
	payload: unknown,
	extra: Record<string, string>,
	url = GATEWAY_URL,
) {
	const { POST } = await loadRoute();
	const response = await POST(
		new Request(url, {
			method: "POST",
			headers: headers(extra),
			body: JSON.stringify(payload),
		}) as never,
	);
	return {
		response,
		sessionId: response.headers.get("mcp-session-id"),
		json: (await response.json()) as Record<string, unknown>,
	};
}

function callTool(name: string) {
	return body("tools/call", { name, arguments: {} });
}

beforeEach(() => {
	vi.clearAllMocks();
	isOrganizationMember.mockResolvedValue(true);
	findUser.mockResolvedValue({
		name: "Test User",
		email: "dev@example.com",
		role: "user",
		banned: false,
		banExpires: null,
	});
	getSession.mockResolvedValue(null);
	resolveProjectTarget.mockResolvedValue({
		organizationId: ORG_A,
		projectId: PROJECT_ID,
	});
	executePlatformTool.mockResolvedValue({
		content: [{ type: "text", text: "ok" }],
	});
	getAggregatedTools.mockResolvedValue({ tools: [], servers: [] });
});

describe("MCP gateway — service credential", () => {
	it("opens a service session for a member, with the acting context and the service scopes", async () => {
		const { response } = await post(
			callTool("fabric_list_workflows"),
			serviceHeaders({
				"x-fabric-project": "project-1",
				"x-fabric-workspace": "workspace-1",
				"x-fabric-conversation": "conversation-1",
				"x-fabric-source-run-type": "direct-chat",
				"x-fabric-source-run-id": "run-1",
			}),
		);

		expect(response.status).toBe(200);
		expect(isOrganizationMember).toHaveBeenCalledWith(USER_ID, ORG_A);
		const session = executePlatformTool.mock.calls[0]?.[2];
		expect(session).toMatchObject({
			userId: USER_ID,
			organizationId: ORG_A,
			credential: "service",
			scopes: [
				"workflows:read",
				"workflows:write",
				"workflows:run",
				"frames:read",
				"frames:write",
				"projects:read",
				"instructions:read",
				"mcp:read",
			],
			actingContext: {
				projectId: "project-1",
				workspaceId: "workspace-1",
				conversationId: "conversation-1",
				sourceRunType: "direct-chat",
				sourceRunId: "run-1",
			},
		});
	});

	it("refuses a wrong secret with 401 and does not fall back to the browser session", async () => {
		getSession.mockResolvedValue({
			user: { id: USER_ID, name: "Test User", email: "dev@example.com" },
			session: { activeOrganizationId: ORG_A },
		});

		const { response } = await post(
			callTool("fabric_list_workflows"),
			serviceHeaders({ "x-agent-service-token": "not-the-secret" }),
		);

		expect(response.status).toBe(401);
		expect(executePlatformTool).not.toHaveBeenCalled();
		expect(getSession).not.toHaveBeenCalled();
	});

	it("refuses an empty secret with 401", async () => {
		const { response } = await post(
			callTool("fabric_list_workflows"),
			serviceHeaders({ "x-agent-service-token": "" }),
		);

		expect(response.status).toBe(401);
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it("is not a credential at all without the header", async () => {
		const { "x-agent-service-token": _omitted, ...withoutToken } =
			serviceHeaders();

		const { response } = await post(
			callTool("fabric_list_workflows"),
			withoutToken,
		);

		expect(response.status).toBe(401);
	});

	it("refuses a user who is not a member of the organization it names", async () => {
		isOrganizationMember.mockResolvedValue(false);

		const { response, json } = await post(
			callTool("fabric_list_workflows"),
			serviceHeaders({ "x-fabric-acting-organization": ORG_B }),
		);

		expect(response.status).toBe(403);
		expect(json.reason).toBe("not_a_member");
		expect(isOrganizationMember).toHaveBeenCalledWith(USER_ID, ORG_B);
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it("refuses a user that does not exist, as it refuses a non-member", async () => {
		findUser.mockResolvedValue(null);

		const { response, json } = await post(
			callTool("fabric_list_workflows"),
			serviceHeaders(),
		);

		expect(response.status).toBe(403);
		expect(json.reason).toBe("not_a_member");
	});

	it("refuses a banned user", async () => {
		findUser.mockResolvedValue({
			name: "Test User",
			email: "dev@example.com",
			role: "user",
			banned: true,
			banExpires: null,
		});

		const { response } = await post(
			callTool("fabric_list_workflows"),
			serviceHeaders(),
		);

		expect(response.status).toBe(403);
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it.each([["x-fabric-acting-user"], ["x-fabric-acting-organization"]])(
		"refuses a call missing %s",
		async (missing) => {
			const withoutHeader = serviceHeaders();
			delete withoutHeader[missing];

			const { response, json } = await post(
				callTool("fabric_list_workflows"),
				withoutHeader,
			);

			expect(response.status).toBe(400);
			expect(json.reason).toBe("service_context_required");
			expect(isOrganizationMember).not.toHaveBeenCalled();
			expect(executePlatformTool).not.toHaveBeenCalled();
		},
	);

	it("refuses an acting header that is not an identifier", async () => {
		const { response } = await post(
			callTool("fabric_list_workflows"),
			serviceHeaders({ "x-fabric-acting-user": "user 1; drop" }),
		);

		expect(response.status).toBe(400);
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it("does not admit the service credential at a project's URL", async () => {
		const { handleGatewayPost } = await import(
			"@saas/mcp/lib/gateway-endpoint"
		);

		const response = await handleGatewayPost(
			new Request(`${GATEWAY_URL}/projects/project-1`, {
				method: "POST",
				headers: headers(serviceHeaders()),
				body: JSON.stringify(callTool("fabric_get_project")),
			}) as never,
			{ projectId: "project-1" },
		);

		expect(response.status).toBe(403);
		expect(executePlatformTool).not.toHaveBeenCalled();
	});
});

/**
 * The shared secret says the caller is Fabric's runtime; the ids it sends are
 * not secret. The acting grant is what says this turn acts for this user in
 * this organization, so each way a grant can be wrong refuses before anything
 * about the person is read.
 */
describe("MCP gateway — service credential — acting grant", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	async function expectRefused(
		extra: Record<string, string>,
		reason: string,
	): Promise<void> {
		const { response, json } = await post(
			callTool("fabric_list_workflows"),
			extra,
		);

		expect(response.status).toBe(401);
		expect(json.reason).toBe(reason);
		expect(isOrganizationMember).not.toHaveBeenCalled();
		expect(findUser).not.toHaveBeenCalled();
		expect(executePlatformTool).not.toHaveBeenCalled();
	}

	it("serves a call whose grant was minted for the user, organization and conversation it names", async () => {
		const { response } = await post(
			callTool("fabric_list_workflows"),
			serviceHeaders({ "x-fabric-conversation": "conversation-1" }),
		);

		expect(response.status).toBe(200);
		expect(executePlatformTool).toHaveBeenCalledTimes(1);
	});

	it("refuses a call with the shared secret and no grant", async () => {
		const { "x-fabric-acting-grant": _omitted, ...withoutGrant } =
			serviceHeaders();

		await expectRefused(withoutGrant, "acting_grant_missing");
	});

	it("refuses a grant nobody signed", async () => {
		await expectRefused(
			serviceHeaders({ "x-fabric-acting-grant": "made-up.signature" }),
			"acting_grant_invalid",
		);
	});

	it("refuses a grant that was edited after it was signed", async () => {
		const [head, signature] = mintActingGrant({
			userId: USER_ID,
			organizationId: ORG_A,
		}).split(".");
		const body = JSON.parse(Buffer.from(head, "base64url").toString());
		body.p.organizationId = ORG_B;
		const edited = `${Buffer.from(JSON.stringify(body)).toString("base64url")}.${signature}`;

		await expectRefused(
			serviceHeaders({
				"x-fabric-acting-organization": ORG_B,
				"x-fabric-acting-grant": edited,
			}),
			"acting_grant_invalid",
		);
	});

	it("refuses a grant that has expired, and says the person has to send their message again", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
		const headers = serviceHeaders();

		vi.setSystemTime(new Date("2026-10-14T11:00:05Z"));
		const { response, json } = await post(
			callTool("fabric_list_workflows"),
			headers,
		);

		expect(response.status).toBe(401);
		expect(json.reason).toBe("acting_grant_expired");
		expect(String(json.error)).toContain("send their message again");
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it("refuses a grant minted for another user than the call acts for", async () => {
		await expectRefused(
			serviceHeaders({
				"x-fabric-acting-grant": mintActingGrant({
					userId: "someone-else",
					organizationId: ORG_A,
				}),
			}),
			"acting_grant_mismatch",
		);
	});

	it("refuses a grant minted for another organization than the call acts in", async () => {
		await expectRefused(
			serviceHeaders({
				"x-fabric-acting-grant": mintActingGrant({
					userId: USER_ID,
					organizationId: ORG_B,
				}),
			}),
			"acting_grant_mismatch",
		);
	});

	it("refuses a grant minted for another conversation than the call comes from", async () => {
		await expectRefused(
			serviceHeaders({
				"x-fabric-conversation": "conversation-2",
				"x-fabric-acting-grant": mintActingGrant({
					userId: USER_ID,
					organizationId: ORG_A,
					conversationId: "conversation-1",
				}),
			}),
			"acting_grant_mismatch",
		);
	});

	it("does not fall back to the browser session when the grant is refused", async () => {
		getSession.mockResolvedValue({
			user: { id: USER_ID, name: "Test User", email: "dev@example.com" },
			session: { activeOrganizationId: ORG_A },
		});
		const { "x-fabric-acting-grant": _omitted, ...withoutGrant } =
			serviceHeaders();

		const { response } = await post(
			callTool("fabric_list_workflows"),
			withoutGrant,
		);

		expect(response.status).toBe(401);
		expect(getSession).not.toHaveBeenCalled();
	});
});

describe("MCP gateway — service sessions are stateless", () => {
	it("serves a request that quotes an earlier session id in a fresh session of its own acting context", async () => {
		const { sessionId } = await post(
			body("initialize"),
			serviceHeaders({ "x-fabric-project": "project-1" }),
		);

		const { sessionId: served } = await post(
			callTool("fabric_list_workflows"),
			serviceHeaders({
				"x-fabric-project": "project-2",
				"mcp-session-id": sessionId ?? "",
			}),
		);

		expect(served).not.toBe(sessionId);
		expect(executePlatformTool.mock.calls[0]?.[2].actingContext).toEqual(
			expect.objectContaining({ projectId: "project-2" }),
		);
	});

	it("keeps no session behind: the id a service request was given opens nothing later", async () => {
		const { sessionId } = await post(body("initialize"), serviceHeaders());
		const { getGatewaySession } = await import(
			"../../modules/saas/mcp/lib/gateway/session-store"
		);

		expect(getGatewaySession(sessionId ?? "")).toBeNull();
	});

	it("does not lend a service session to a browser or key credential", async () => {
		const { sessionId } = await post(body("initialize"), serviceHeaders());
		getSession.mockResolvedValue({
			user: { id: USER_ID, name: "Test User", email: "dev@example.com" },
			session: { activeOrganizationId: ORG_A },
		});

		const { sessionId: served } = await post(
			callTool("fabric_get_identity"),
			{ "mcp-session-id": sessionId ?? "" },
		);

		expect(served).not.toBe(sessionId);
		expect(executePlatformTool.mock.calls[0]?.[2].credential).toBe(
			"session",
		);
	});
});

describe("MCP gateway — tools/list", () => {
	it("carries a tool's confirmation policy to the client, as the definition states it", async () => {
		const listing = (name: string) => {
			const definition = fabricGatewayTool(name);
			if (!definition) {
				throw new Error(`${name} is not a gateway tool`);
			}
			return {
				name,
				description: definition.description,
				inputSchema: definition.inputSchema,
				annotations: definition.annotations,
				_meta: confirmationMeta(definition),
			};
		};
		getAggregatedTools.mockResolvedValue({
			tools: [
				listing("fabric_publish_workflow"),
				listing("fabric_create_frame"),
				listing("fabric_list_workflows"),
			],
			servers: [],
		});

		const { json } = await post(body("tools/list"), serviceHeaders());

		const tools = (json.result as { tools: Array<Record<string, unknown>> })
			.tools;
		expect(tools[0]?._meta).toEqual({ "fabric/confirm": true });
		expect(tools[1]?._meta).toEqual({
			"fabric/confirm": { whenArgumentPresent: "runtimeTools" },
		});
		expect(tools[2]).not.toHaveProperty("_meta");
	});
});

describe("MCP gateway — service calls are not CLI connections", () => {
	it("records no CLI reach for a service request", async () => {
		await post(callTool("fabric_list_workflows"), serviceHeaders());

		expect(recordCliReach).toHaveBeenCalledTimes(1);
		const source = recordCliReach.mock.calls[0]?.[0];
		expect(source.credential).toBe("service");
		expect(source.keyIdentity).toBeUndefined();
	});
});

const BASE_SCOPES = [
	"workflows:read",
	"workflows:write",
	"workflows:run",
	"frames:read",
	"frames:write",
	"projects:read",
	"instructions:read",
	"mcp:read",
];

const PORTAL_SCOPES = [
	"orgs:read",
	"projects:read",
	"projects:write",
	"features:read",
	"features:write",
	"instructions:read",
	"instructions:write",
	"workspaces:read",
	"chats:read",
	"mcp:read",
];

/** A call carrying a grant the web app signed, with exactly the payload named. */
function grantedHeaders(
	grantBody: Record<string, unknown>,
): Record<string, string> {
	return serviceHeaders({
		"x-fabric-acting-grant": signToken(
			{
				purpose: "fabric-agent-acting-grant",
				userId: USER_ID,
				organizationId: ORG_A,
				conversationId: null,
				...grantBody,
			},
			{ ttlSec: 3_600 },
		),
	});
}

async function sessionFor(headersForCall: Record<string, string>) {
	const { response, json } = await post(
		callTool("fabric_list_workflows"),
		headersForCall,
	);
	return {
		response,
		json,
		session: executePlatformTool.mock.calls[0]?.[2] as
			| Record<string, unknown>
			| undefined,
	};
}

describe("MCP gateway — a project-limited acting grant", () => {
	it("gives a chat grant exactly the base scopes and no project", async () => {
		const { session } = await sessionFor(serviceHeaders());

		expect(session?.scopes).toEqual(BASE_SCOPES);
		expect(session?.pinnedProjectId ?? null).toBeNull();
		expect(resolveProjectTarget).not.toHaveBeenCalled();
	});

	it("adds the portal scopes a meeting grant names, and limits the session to that project", async () => {
		const { response, session } = await sessionFor(
			serviceHeaders({
				"x-fabric-acting-grant":
					mintParlumeActingGrantForTurn({
						userId: USER_ID,
						organizationId: ORG_A,
						projectId: PROJECT_ID,
						readOnly: false,
					}) ?? "",
			}),
		);

		expect(response.status).toBe(200);
		expect(resolveProjectTarget).toHaveBeenCalledWith(USER_ID, PROJECT_ID);
		expect(session?.scopes).toEqual([
			...new Set([...BASE_SCOPES, ...PORTAL_SCOPES]),
		]);
		expect(session?.pinnedProjectId).toBe(PROJECT_ID);
		expect(session?.projectId ?? null).toBeNull();
	});

	it("refuses a grant that names scopes but no project, which is never minted", async () => {
		const { response, json } = await sessionFor(
			grantedHeaders({ scopes: PORTAL_SCOPES }),
		);

		expect(response.status).toBe(401);
		expect(json.reason).toBe("acting_grant_invalid");
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it("refuses a grant that names a project but no scopes", async () => {
		const { response, json } = await sessionFor(
			grantedHeaders({ projectId: PROJECT_ID }),
		);

		expect(response.status).toBe(401);
		expect(json.reason).toBe("acting_grant_invalid");
	});

	it("drops every scope outside the ceiling, whatever the grant names", async () => {
		const { session } = await sessionFor(
			grantedHeaders({
				projectId: PROJECT_ID,
				scopes: [
					"features:read",
					"mcp:write",
					"*",
					"authority:write",
					"authority:read",
					"orgs:write",
					"chats:write",
					"workflows:admin",
					"made-up:scope",
				],
			}),
		);

		expect(session?.scopes).toEqual([...BASE_SCOPES, "features:read"]);
	});

	it("refuses a project the person cannot open", async () => {
		resolveProjectTarget.mockResolvedValue(null);

		const { response, json } = await sessionFor(
			grantedHeaders({ projectId: PROJECT_ID, scopes: PORTAL_SCOPES }),
		);

		expect(response.status).toBe(403);
		expect(json.reason).toBe("project_not_accessible");
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it("refuses a project that belongs to another organization than the one acted in", async () => {
		resolveProjectTarget.mockResolvedValue({
			organizationId: ORG_B,
			projectId: PROJECT_ID,
		});

		const { response, json } = await sessionFor(
			grantedHeaders({ projectId: PROJECT_ID, scopes: PORTAL_SCOPES }),
		);

		expect(response.status).toBe(403);
		expect(json.reason).toBe("project_not_accessible");
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it("refuses a grant whose scopes were altered after it was signed", async () => {
		const real = grantedHeaders({
			projectId: PROJECT_ID,
			scopes: ["features:read"],
		});
		const [head, signature] = real["x-fabric-acting-grant"].split(".");
		const body = JSON.parse(Buffer.from(head, "base64url").toString());
		body.p.scopes = [...PORTAL_SCOPES];
		const tampered = `${Buffer.from(JSON.stringify(body)).toString("base64url")}.${signature}`;

		const { response, json } = await sessionFor({
			...real,
			"x-fabric-acting-grant": tampered,
		});

		expect(response.status).toBe(401);
		expect(json.reason).toBe("acting_grant_invalid");
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it("refuses an expired meeting grant", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const grant = mintParlumeActingGrantForTurn({
			userId: USER_ID,
			organizationId: ORG_A,
			projectId: PROJECT_ID,
			readOnly: false,
		});
		vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);

		try {
			const { response, json } = await sessionFor(
				serviceHeaders({ "x-fabric-acting-grant": grant ?? "" }),
			);

			expect(response.status).toBe(401);
			expect(json.reason).toBe("acting_grant_expired");
		} finally {
			vi.useRealTimers();
		}
	});

	it("refuses a meeting grant minted for another user", async () => {
		const { response, json } = await sessionFor(
			serviceHeaders({
				"x-fabric-acting-grant":
					mintParlumeActingGrantForTurn({
						userId: "someone-else",
						organizationId: ORG_A,
						projectId: PROJECT_ID,
						readOnly: false,
					}) ?? "",
			}),
		);

		expect(response.status).toBe(401);
		expect(json.reason).toBe("acting_grant_mismatch");
	});

	it("refuses a connected server's tool on a meeting session, though it holds mcp:read", async () => {
		const { response, json } = await post(
			callTool("example_server__list_things"),
			serviceHeaders({
				"x-fabric-acting-grant":
					mintParlumeActingGrantForTurn({
						userId: USER_ID,
						organizationId: ORG_A,
						projectId: PROJECT_ID,
						readOnly: false,
					}) ?? "",
			}),
		);

		const result = json.result as {
			isError?: boolean;
			content: Array<{ text: string }>;
		};
		expect(response.status).toBe(200);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain(
			"not available to the agent runtime on a meeting's project",
		);
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it("keeps a session for another project's grant apart from this one's", async () => {
		const { session } = await sessionFor(
			grantedHeaders({
				projectId: "another-meeting-project",
				scopes: ["features:read"],
			}),
		);

		expect(session?.pinnedProjectId).toBe("another-meeting-project");
	});
});
