// @vitest-environment node
/**
 * /api/agents/runtime — the agent runtime's REST endpoint.
 *
 *   - no session: 401, and no runtime is built;
 *   - an organization the caller has no tie to (header or active one): 403;
 *   - a thread that is someone else's — another user's, or the caller's in
 *     another organization — is refused with 403 on run, connect and stop
 *     before the engine sees the request;
 *   - the caller's own thread reaches the engine, built for the caller in
 *     the resolved organization; routes outside the runtime are 404.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getSession: vi.fn(),
	enterAiInteractiveContext: vi.fn(),
	hasOrganizationTie: vi.fn(),
	findConversation: vi.fn(),
	engineCaller: vi.fn(),
	engineRun: vi.fn(),
	engineConnect: vi.fn(),
	engineStop: vi.fn(),
	orchestratorEngine: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({ getSession: () => m.getSession() }));
vi.mock("@repo/ai/lib/chatgpt-plan/interactive-context", () => ({
	enterAiInteractiveContext: (...args: unknown[]) =>
		m.enterAiInteractiveContext(...args),
}));
vi.mock("@repo/database", () => ({
	hasOrganizationTie: (...args: unknown[]) => m.hasOrganizationTie(...args),
	db: {
		agentConversation: {
			findUnique: (...args: unknown[]) => m.findConversation(...args),
		},
	},
}));
vi.mock("@repo/api/orpc/procedures", () => ({
	authorizeInputOrganization: async () => undefined,
	Permissions: { AGENT_CREATE: "agent:create", AGENT_UPDATE: "agent:update" },
}));
vi.mock("@saas/agents/runtime/direct-engine", () => ({
	DIRECT_AGENT_ID: "fabric-direct",
	DirectEngine: class {
		constructor(caller: unknown) {
			m.engineCaller(caller);
		}
		run = (...args: unknown[]) => m.engineRun(...args);
		connect = (...args: unknown[]) => m.engineConnect(...args);
		isRunning = async () => false;
		stop = (...args: unknown[]) => m.engineStop(...args);
	},
}));

vi.mock("@saas/agents/runtime/orchestrator-engine", () => ({
	ORCHESTRATOR_AGENT_ID: "fabric-orchestrator",
	ORCHESTRATOR_STREAM_WINDOW_MS: 240000,
	OrchestratorEngine: class {
		constructor(caller: unknown, streamWindowMs: unknown) {
			m.orchestratorEngine(caller, streamWindowMs);
		}
		run = async () => undefined;
		connect = async () => undefined;
		isRunning = async () => false;
		stop = async () => false;
	},
}));

const { GET, POST, maxDuration } = await import(
	"@/app/api/agents/runtime/[[...path]]/route"
);

const USER = "user-example-1";
const ORG = "org-example-1";
const OTHER_ORG = "org-example-2";
const THREAD = "thread-example-0001";
const BASE = "http://localhost/api/agents/runtime";

function body(threadId: string) {
	return JSON.stringify({
		threadId,
		runId: "run-example-0001",
		messages: [{ id: "message-1", role: "user", content: "Hello" }],
		tools: [],
		context: [],
		state: {},
		forwardedProps: {},
	});
}

function post(path: string, threadId: string, organizationId?: string) {
	return POST(
		new Request(`${BASE}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(organizationId
					? { "x-fabric-organization-id": organizationId }
					: {}),
			},
			body: body(threadId),
		}),
	);
}

const run = (threadId: string, organizationId?: string) =>
	post("/agent/fabric-direct/run", threadId, organizationId);
const connect = (threadId: string, organizationId?: string) =>
	post("/agent/fabric-direct/connect", threadId, organizationId);
const stop = (threadId: string) =>
	POST(
		new Request(`${BASE}/agent/fabric-direct/stop/${threadId}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ runId: "run-example-0001" }),
		}),
	);

beforeEach(() => {
	vi.clearAllMocks();
	m.getSession.mockResolvedValue({
		user: { id: USER, email: "dev@example.com" },
		session: { id: "session-1", activeOrganizationId: ORG },
	});
	m.hasOrganizationTie.mockImplementation(
		async (_userId: string, organizationId: string) =>
			organizationId === ORG || organizationId === OTHER_ORG,
	);
	m.findConversation.mockResolvedValue({ userId: USER, organizationId: ORG });
	m.engineConnect.mockResolvedValue(undefined);
	m.engineRun.mockResolvedValue(undefined);
	m.engineStop.mockResolvedValue(true);
});

describe("/api/agents/runtime", () => {
	it("answers 401 without a session and builds no runtime", async () => {
		m.getSession.mockResolvedValue(null);

		const response = await run(THREAD);

		expect(response.status).toBe(401);
		expect(m.engineCaller).not.toHaveBeenCalled();
	});

	it("answers 403 for an organization the caller has no tie to", async () => {
		const response = await run(THREAD, "org-example-9");

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: "Forbidden" });
		expect(m.engineCaller).not.toHaveBeenCalled();
	});

	it("answers 403 when the session's active organization is no longer the caller's", async () => {
		m.hasOrganizationTie.mockResolvedValue(false);

		const response = await GET(new Request(`${BASE}/info`));

		expect(response.status).toBe(403);
	});

	it.each([
		[
			"another user's thread",
			{ userId: "user-example-2", organizationId: ORG },
		],
		[
			"the caller's thread in another organization",
			{ userId: USER, organizationId: OTHER_ORG },
		],
	])(
		"refuses %s on run, connect and stop with 403",
		async (_label, owner) => {
			m.findConversation.mockResolvedValue(owner);

			for (const response of [
				await run(THREAD),
				await connect(THREAD),
				await stop(THREAD),
			]) {
				expect(response.status).toBe(403);
				expect(await response.json()).toMatchObject({
					error: "Forbidden",
				});
			}
			expect(m.engineRun).not.toHaveBeenCalled();
			expect(m.engineConnect).not.toHaveBeenCalled();
			expect(m.engineStop).not.toHaveBeenCalled();
		},
	);

	it("serves the caller's own thread through the engine, bound to the caller", async () => {
		const response = await connect(THREAD, ORG);
		await response.text();

		expect(response.status).toBe(200);
		expect(m.engineCaller).toHaveBeenCalledWith(
			expect.objectContaining({ userId: USER, organizationId: ORG }),
		);
		expect(m.engineConnect).toHaveBeenCalledWith(THREAD, expect.anything());
		expect(m.enterAiInteractiveContext).toHaveBeenCalledWith({
			userId: USER,
			impersonated: false,
		});
	});

	it("lets a run start a thread nobody has yet", async () => {
		m.findConversation.mockResolvedValue(null);

		const response = await run("thread-example-new1");
		await response.text();

		expect(response.status).toBe(200);
		expect(m.engineRun).toHaveBeenCalled();
	});

	it("lists the Direct and Orchestrator agents on info and serves no routes beyond the runtime's", async () => {
		const info = await GET(new Request(`${BASE}/info`));
		expect(info.status).toBe(200);
		const listed = JSON.stringify(await info.json());
		expect(listed).toContain("fabric-direct");
		expect(listed).toContain("fabric-orchestrator");
		expect(m.orchestratorEngine).toHaveBeenCalledWith(
			expect.objectContaining({ userId: USER }),
			240000,
		);

		const threads = await GET(new Request(`${BASE}/threads`));
		expect(threads.status).toBe(404);
	});

	it("keeps its function window above the longest stream window", () => {
		expect(maxDuration).toBe(300);
	});
});
