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
import { EventType } from "@ag-ui/client";
import type { RunStream } from "@saas/agents/runtime/engine";
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
	orchestratorRun: vi.fn(),
	libraryEngine: vi.fn(),
	libraryRun: vi.fn(),
	libraryConnect: vi.fn(),
	sidekickEngine: vi.fn(),
	sidekickRun: vi.fn(),
	weaveEngine: vi.fn(),
	weaveRun: vi.fn(),
	weaveConnect: vi.fn(),
	weaveStop: vi.fn(),
	researchEngine: vi.fn(),
	researchRun: vi.fn(),
	researchConnect: vi.fn(),
	researchStop: vi.fn(),
	cugaEngine: vi.fn(),
	cugaRun: vi.fn(),
	cugaConnect: vi.fn(),
	dataAnalystEngine: vi.fn(),
	dataAnalystRun: vi.fn(),
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
		run = (...args: unknown[]) => m.orchestratorRun(...args);
		connect = async () => undefined;
		isRunning = async () => false;
		stop = async () => false;
	},
}));

vi.mock("@saas/agents/runtime/library-chat-engine", () => ({
	LIBRARY_CHAT_AGENT_ID: "library-chat",
	LibraryChatEngine: class {
		constructor(caller: unknown) {
			m.libraryEngine(caller);
		}
		run = (...args: unknown[]) => m.libraryRun(...args);
		connect = (...args: unknown[]) => m.libraryConnect(...args);
		isRunning = async () => false;
		stop = async () => false;
	},
}));

// The Atlas chat's engine as the route meets it: built per request for the
// caller; a run holds its response open until the test releases it.
const atlas = vi.hoisted(() => ({
	engine: vi.fn(),
	runs: [] as Array<{ request: unknown; stream: RunStream }>,
	connect: vi.fn(),
	release: () => {},
}));

vi.mock("@saas/agents/runtime/atlas-chat-engine", () => ({
	ATLAS_CHAT_AGENT_ID: "atlas-chat",
	AtlasChatEngine: class {
		constructor(caller: unknown) {
			atlas.engine(caller);
		}
		run = (request: unknown, stream: RunStream) => {
			atlas.runs.push({ request, stream });
			return new Promise<void>((resolve) => {
				atlas.release = resolve;
			});
		};
		connect = (...args: unknown[]) => atlas.connect(...args);
		isRunning = async () => false;
		stop = async () => false;
	},
}));

vi.mock("@saas/agents/runtime/sidekick-engine", () => ({
	SIDEKICK_AGENT_ID: "agent-builder-sidekick",
	SidekickEngine: class {
		constructor(caller: unknown) {
			m.sidekickEngine(caller);
		}
		run = (...args: unknown[]) => m.sidekickRun(...args);
		connect = async () => undefined;
		isRunning = async () => false;
		stop = async () => false;
	},
}));

vi.mock("@saas/agents/runtime/weave-refine-engine", () => ({
	WEAVE_REFINE_AGENT_ID: "weave-refine",
	WeaveRefineEngine: class {
		constructor(caller: unknown) {
			m.weaveEngine(caller);
		}
		run = (...args: unknown[]) => m.weaveRun(...args);
		connect = (...args: unknown[]) => m.weaveConnect(...args);
		isRunning = async () => false;
		stop = (...args: unknown[]) => m.weaveStop(...args);
	},
}));

vi.mock("@saas/agents/runtime/research-engine", () => ({
	RESEARCH_AGENT_ID: "deep-researcher",
	ResearchEngine: class {
		constructor(caller: unknown) {
			m.researchEngine(caller);
		}
		run = (...args: unknown[]) => m.researchRun(...args);
		connect = (...args: unknown[]) => m.researchConnect(...args);
		isRunning = async () => false;
		stop = (...args: unknown[]) => m.researchStop(...args);
	},
}));

vi.mock("@saas/agents/runtime/cuga-generalist-engine", () => ({
	CUGA_GENERALIST_AGENT_ID: "cuga-generalist",
	CugaGeneralistEngine: class {
		constructor(caller: unknown) {
			m.cugaEngine(caller);
		}
		run = (...args: unknown[]) => m.cugaRun(...args);
		connect = (...args: unknown[]) => m.cugaConnect(...args);
		isRunning = async () => false;
		stop = async () => false;
	},
}));

vi.mock("@saas/agents/runtime/data-analyst-engine", () => ({
	DATA_ANALYST_AGENT_ID: "data-analyst",
	DataAnalystEngine: class {
		constructor(caller: unknown) {
			m.dataAnalystEngine(caller);
		}
		run = (...args: unknown[]) => m.dataAnalystRun(...args);
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
	m.orchestratorRun.mockResolvedValue(undefined);
	m.libraryRun.mockResolvedValue(undefined);
	m.libraryConnect.mockResolvedValue(undefined);
	m.sidekickRun.mockResolvedValue(undefined);
	m.weaveRun.mockResolvedValue(undefined);
	m.weaveConnect.mockResolvedValue(undefined);
	m.weaveStop.mockResolvedValue(true);
	m.cugaRun.mockResolvedValue(undefined);
	m.cugaConnect.mockResolvedValue(undefined);
	m.dataAnalystRun.mockResolvedValue(undefined);
});

describe("/api/agents/runtime", () => {
	it("refuses an announced body over 8 MiB before building a runtime", async () => {
		const response = await POST(
			new Request(`${BASE}/agent/fabric-direct/run`, {
				method: "POST",
				headers: { "Content-Length": String(8 * 1024 * 1024 + 1) },
				body: body(THREAD),
			}),
		);
		expect(response.status).toBe(413);
		expect(m.engineCaller).not.toHaveBeenCalled();
		expect(m.engineRun).not.toHaveBeenCalled();
	});

	it.each(["run", "connect", "stop/thread-example-0001"])(
		"refuses an actual oversized body on %s even with a lying length",
		async (path) => {
			const response = await POST(
				new Request(`${BASE}/agent/fabric-direct/${path}`, {
					method: "POST",
					headers: { "content-length": "1" },
					body: "x".repeat(8 * 1024 * 1024 + 1),
				}),
			);
			expect(response.status).toBe(413);
			expect(m.engineCaller).not.toHaveBeenCalled();
			expect(m.findConversation).not.toHaveBeenCalled();
		},
	);

	it.each([401, 403])(
		"checks admission before reading a body (%s)",
		async (status) => {
			if (status === 401) {
				m.getSession.mockResolvedValue(null);
			} else {
				m.hasOrganizationTie.mockResolvedValue(false);
			}
			const request = new Request(`${BASE}/agent/fabric-direct/run`, {
				method: "POST",
				headers: { "content-length": String(8 * 1024 * 1024 + 1) },
				body: body(THREAD),
			});
			expect((await POST(request)).status).toBe(status);
			expect(request.bodyUsed).toBe(false);
		},
	);

	it("reports accurate named engine capabilities from /info before the first run", async () => {
		const response = await GET(new Request(`${BASE}/info`));
		expect(response.status).toBe(200);
		const info = await response.json();
		expect(info.agents["fabric-direct"].capabilities).toMatchObject({
			transport: { streaming: true, resumable: true },
			humanInTheLoop: {
				supported: false,
				approvals: false,
				interrupts: false,
			},
		});
		expect(
			info.agents["fabric-orchestrator"].capabilities.humanInTheLoop,
		).toEqual({ supported: true, approvals: true, interrupts: true });
	});
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

	it("detaches a durable response without asking the engine to stop its workflow", async () => {
		let stream: RunStream | undefined;
		let release = () => {};
		const running = new Promise<void>((resolve) => {
			release = resolve;
		});
		m.engineRun.mockImplementation(
			async (_request: unknown, tail: RunStream) => {
				stream = tail;
				await running;
			},
		);
		const response = await run(THREAD);
		await vi.waitFor(() => expect(stream).toBeDefined());
		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("Expected an SSE response body");
		}
		const cancelled = reader.cancel();
		try {
			await vi.waitFor(() => expect(stream?.isClosed()).toBe(true));
			expect(m.engineStop).not.toHaveBeenCalled();
		} finally {
			release();
			await cancelled;
			reader.releaseLock();
		}
	});

	it("lists the Direct and Orchestrator agents on info and serves no routes beyond the runtime's", async () => {
		const info = await GET(new Request(`${BASE}/info`));
		expect(info.status).toBe(200);
		const listed = JSON.stringify(await info.json());
		expect(listed).toContain("fabric-direct");
		expect(listed).toContain("fabric-orchestrator");
		expect(listed).toContain("deep-researcher");
		expect(m.orchestratorEngine).toHaveBeenCalledWith(
			expect.objectContaining({ userId: USER }),
			240000,
		);
		expect(m.researchEngine).toHaveBeenCalledWith(
			expect.objectContaining({ userId: USER, organizationId: ORG }),
		);

		const threads = await GET(new Request(`${BASE}/threads`));
		expect(threads.status).toBe(404);
	});

	it("leaves a request/reply agent's thread to its engine, and still checks the conversation agents' threads", async () => {
		// The thread id names someone else's conversation.
		m.findConversation.mockResolvedValue({
			userId: "user-example-2",
			organizationId: ORG,
		});

		const libraryRun = await post("/agent/library-chat/run", THREAD);
		await libraryRun.text();
		const libraryConnect = await post(
			"/agent/library-chat/connect",
			THREAD,
		);
		await libraryConnect.text();

		expect(libraryRun.status).toBe(200);
		expect(libraryConnect.status).toBe(200);
		expect(m.libraryEngine).toHaveBeenCalledWith(
			expect.objectContaining({ userId: USER, organizationId: ORG }),
		);
		expect(m.libraryRun).toHaveBeenCalledWith(
			expect.objectContaining({ threadId: THREAD }),
			expect.anything(),
		);
		expect(m.libraryConnect).toHaveBeenCalledWith(
			THREAD,
			expect.anything(),
		);

		for (const response of [
			await post("/agent/fabric-direct/run", THREAD),
			await post("/agent/fabric-orchestrator/run", THREAD),
			await post("/agent/fabric-orchestrator/connect", THREAD),
			await post("/agent/deep-researcher/run", THREAD),
			await post("/agent/deep-researcher/connect", THREAD),
			// A stop names only a thread and reaches every engine.
			await POST(
				new Request(`${BASE}/agent/library-chat/stop/${THREAD}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ runId: "run-example-0001" }),
				}),
			),
		]) {
			expect(response.status).toBe(403);
		}
		expect(m.engineRun).not.toHaveBeenCalled();
		expect(m.orchestratorRun).not.toHaveBeenCalled();
		expect(m.engineStop).not.toHaveBeenCalled();
		expect(m.researchRun).not.toHaveBeenCalled();
		expect(m.researchConnect).not.toHaveBeenCalled();
		expect(m.researchStop).not.toHaveBeenCalled();
	});

	it("lists the library chat on info", async () => {
		const info = await GET(new Request(`${BASE}/info`));

		expect(JSON.stringify(await info.json())).toContain("library-chat");
	});

	it("a Sidekick run reaches the Sidekick engine built for the caller without a conversation check", async () => {
		const response = await post(
			"/agent/agent-builder-sidekick/run",
			THREAD,
			OTHER_ORG,
		);
		await response.text();

		expect(response.status).toBe(200);
		expect(m.sidekickEngine).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: USER,
				organizationId: OTHER_ORG,
			}),
		);
		expect(m.sidekickRun).toHaveBeenCalledWith(
			expect.objectContaining({ threadId: THREAD }),
			expect.anything(),
		);
		expect(m.findConversation).not.toHaveBeenCalled();
	});

	it("lists agent-builder-sidekick on info", async () => {
		const info = await GET(new Request(`${BASE}/info`));

		expect(JSON.stringify(await info.json())).toContain(
			'"agent-builder-sidekick"',
		);
	});

	it("leaves a weave-refine run and connect to its engine, built for the caller, and still checks a stop", async () => {
		// The thread id names someone else's conversation.
		m.findConversation.mockResolvedValue({
			userId: "user-example-2",
			organizationId: ORG,
		});

		const weaveRun = await post("/agent/weave-refine/run", THREAD);
		await weaveRun.text();
		const weaveConnect = await post("/agent/weave-refine/connect", THREAD);
		await weaveConnect.text();
		const weaveStop = await POST(
			new Request(`${BASE}/agent/weave-refine/stop/${THREAD}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ runId: "run-example-0001" }),
			}),
		);

		expect(weaveRun.status).toBe(200);
		expect(weaveConnect.status).toBe(200);
		expect(m.weaveEngine).toHaveBeenCalledWith(
			expect.objectContaining({ userId: USER, organizationId: ORG }),
		);
		expect(m.weaveRun).toHaveBeenCalledWith(
			expect.objectContaining({ threadId: THREAD }),
			expect.anything(),
		);
		expect(m.weaveConnect).toHaveBeenCalledWith(THREAD, expect.anything());
		expect(weaveStop.status).toBe(403);
		expect(m.weaveStop).not.toHaveBeenCalled();
	});

	it("lists weave-refine on info", async () => {
		const info = await GET(new Request(`${BASE}/info`));

		expect(JSON.stringify(await info.json())).toContain('"weave-refine"');
	});

	it("does not instantiate the retired CUGA engine for direct run or connect links", async () => {
		m.findConversation.mockResolvedValue({
			userId: USER,
			organizationId: ORG,
		});

		const cugaRun = await post("/agent/cuga-generalist/run", THREAD);
		await cugaRun.text();
		const cugaConnect = await post(
			"/agent/cuga-generalist/connect",
			THREAD,
		);
		await cugaConnect.text();

		expect(cugaRun.status).toBeGreaterThanOrEqual(400);
		expect(cugaConnect.status).toBeGreaterThanOrEqual(400);
		expect(m.cugaEngine).not.toHaveBeenCalled();
		expect(m.cugaRun).not.toHaveBeenCalled();
		expect(m.cugaConnect).not.toHaveBeenCalled();

		const stopped = await POST(
			new Request(`${BASE}/agent/cuga-generalist/stop/${THREAD}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ runId: "run-example-0001" }),
			}),
		);
		expect(stopped.status).toBeGreaterThanOrEqual(400);
	});

	it("does not advertise the retired CUGA chat on info", async () => {
		const info = await GET(new Request(`${BASE}/info`));

		expect(JSON.stringify(await info.json())).not.toContain(
			"cuga-generalist",
		);
	});

	it("routes the data analyst to the engine bound to the resolved organization", async () => {
		m.findConversation.mockResolvedValue({
			userId: "another-example-user",
			organizationId: ORG,
		});
		const response = await post(
			"/agent/data-analyst/run",
			THREAD,
			OTHER_ORG,
		);
		await response.text();
		expect(response.status).toBe(200);
		expect(m.dataAnalystEngine).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: USER,
				organizationId: OTHER_ORG,
			}),
		);
		expect(m.dataAnalystRun).toHaveBeenCalledWith(
			expect.objectContaining({ threadId: THREAD }),
			expect.anything(),
		);
		expect(m.findConversation).not.toHaveBeenCalled();
	});

	it("lists the data analyst on info", async () => {
		const info = await GET(new Request(`${BASE}/info`));
		expect(JSON.stringify(await info.json())).toContain('"data-analyst"');
	});

	it("keeps its function window above the longest stream window", () => {
		expect(maxDuration).toBe(300);
	});
});

describe("/api/agents/runtime — the Atlas chat", () => {
	beforeEach(() => {
		atlas.runs.length = 0;
		atlas.connect.mockResolvedValue(undefined);
	});

	it("lists atlas-chat on info and builds its engine for the caller", async () => {
		const info = await GET(
			new Request(`${BASE}/info`, {
				headers: { "x-fabric-organization-id": ORG },
			}),
		);

		expect(JSON.stringify(await info.json())).toContain("atlas-chat");
		expect(atlas.engine).toHaveBeenCalledWith(
			expect.objectContaining({ userId: USER, organizationId: ORG }),
		);
	});

	it("leaves its run and connect on any thread to the engine, and still refuses a stop on someone else's conversation", async () => {
		// The thread id names another user's AgentConversation.
		m.findConversation.mockResolvedValue({
			userId: "user-example-2",
			organizationId: ORG,
		});

		const running = await post("/agent/atlas-chat/run", THREAD);
		await vi.waitFor(() => expect(atlas.runs).toHaveLength(1));
		atlas.release();
		await running.text();
		const connected = await post("/agent/atlas-chat/connect", THREAD);
		await connected.text();
		const stopped = await POST(
			new Request(`${BASE}/agent/atlas-chat/stop/${THREAD}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ runId: "run-example-0001" }),
			}),
		);

		expect(running.status).toBe(200);
		expect(connected.status).toBe(200);
		expect(atlas.runs[0]?.request).toMatchObject({ threadId: THREAD });
		expect(atlas.connect).toHaveBeenCalledWith(THREAD, expect.anything());
		expect(stopped.status).toBe(403);
	});

	it("closes the engine's stream when the client aborts the request", async () => {
		const client = new AbortController();

		const response = await POST(
			new Request(`${BASE}/agent/atlas-chat/run`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: body(THREAD),
				signal: client.signal,
			}),
		);
		await vi.waitFor(() => expect(atlas.runs).toHaveLength(1));
		const stream = atlas.runs[0]?.stream;
		expect(stream?.isClosed()).toBe(false);

		client.abort();

		await vi.waitFor(() => expect(stream?.isClosed()).toBe(true));
		atlas.release();
		expect(response.status).toBe(200);
	});

	it("closes the engine's stream when the response reader cancels without aborting the request", async () => {
		const client = new AbortController();
		const response = await POST(
			new Request(`${BASE}/agent/atlas-chat/run`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: body(THREAD),
				signal: client.signal,
			}),
		);
		await vi.waitFor(() => expect(atlas.runs).toHaveLength(1));
		const stream = atlas.runs[0]?.stream;
		expect(stream?.isClosed()).toBe(false);
		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("Expected an SSE response body");
		}
		const cancelled = reader.cancel();
		try {
			expect(client.signal.aborted).toBe(false);
			await vi.waitFor(() => expect(stream?.isClosed()).toBe(true));
		} finally {
			atlas.release();
			await cancelled;
			reader.releaseLock();
		}
	});

	it("cancels a started response promptly and clears the SDK keep-alive timers", async () => {
		const timeout = vi.spyOn(globalThis, "setTimeout");
		const clear = vi.spyOn(globalThis, "clearTimeout");
		try {
			const response = await post("/agent/atlas-chat/run", THREAD);
			await vi.waitFor(() => expect(atlas.runs).toHaveLength(1));
			const stream = atlas.runs[0]?.stream;
			const reader = response.body?.getReader();
			if (!reader || !stream) {
				throw new Error("Expected a running SSE response");
			}
			try {
				stream.emit({
					type: EventType.RUN_STARTED,
					threadId: THREAD,
					runId: "run-example-0001",
				});
				const first = await reader.read();
				expect(new TextDecoder().decode(first.value)).toContain(
					"RUN_STARTED",
				);
				await reader.cancel();
				await vi.waitFor(() => expect(stream.isClosed()).toBe(true));
				const keepAliveTimers = timeout.mock.calls.flatMap(
					(args, index) =>
						args[1] === 15_000
							? [timeout.mock.results[index]?.value]
							: [],
				);
				expect(keepAliveTimers.length).toBeGreaterThan(0);
				await vi.waitFor(() => {
					for (const timer of keepAliveTimers) {
						expect(clear).toHaveBeenCalledWith(timer);
					}
				});
			} finally {
				atlas.release();
				await reader.cancel();
				reader.releaseLock();
			}
		} finally {
			timeout.mockRestore();
			clear.mockRestore();
		}
	});
});
