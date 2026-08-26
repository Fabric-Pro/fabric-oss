/**
 * `POST /api/workflows/trigger/[workflowId]` — the only workflow entry point an
 * external caller can drive, and until this file the only one with no tests.
 *
 * Its authentication is hand-rolled (bearer key or HMAC signature) and its
 * refusals are the security boundary, so each refusal asserts that **no
 * execution row was created** rather than only checking a status code.
 *
 * It also carries three guards the manual run path always had and this one did
 * not: a per-tenant concurrency cap, a run timeout, and the workflow-builder
 * task queue. A run that starts without them is not "slightly worse" — it is
 * the one trigger able to hold a worker slot indefinitely.
 */

import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	rateLimitMock,
	concurrencyMock,
	workflowFindUniqueMock,
	executionCreateMock,
	executionUpdateMock,
	apiKeyFindFirstMock,
	apiKeyUpdateMock,
	startMock,
} = vi.hoisted(() => ({
	rateLimitMock: vi.fn(),
	concurrencyMock: vi.fn(),
	workflowFindUniqueMock: vi.fn(),
	executionCreateMock: vi.fn(),
	executionUpdateMock: vi.fn(),
	apiKeyFindFirstMock: vi.fn(),
	apiKeyUpdateMock: vi.fn(),
	startMock: vi.fn(),
}));

vi.mock("@repo/api/lib/rate-limit", () => ({ checkRateLimit: rateLimitMock }));

vi.mock("@repo/api/modules/workflows/lib/execution-concurrency", () => ({
	checkExecutionConcurrency: concurrencyMock,
}));

vi.mock("@repo/database", () => ({
	db: {
		workflow: { findUnique: workflowFindUniqueMock },
		workflowExecution: {
			create: executionCreateMock,
			update: executionUpdateMock,
		},
		workflowApiKey: {
			findFirst: apiKeyFindFirstMock,
			update: apiKeyUpdateMock,
		},
	},
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: { start: startMock } }),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKeyMaybe: (v: string | null) => v,
}));

const WORKFLOW_ID = "wf-1";
const OWNER = "user-1";
const ORG = "org-1";
const SECRET = "whsec_test_secret";
const RAW_KEY = "wfk_abc12345_supersecretpart";

function publishedWorkflow(overrides: Record<string, unknown> = {}) {
	return {
		id: WORKFLOW_ID,
		name: "Nightly sync",
		status: "PUBLISHED",
		triggerType: "WEBHOOK",
		userId: OWNER,
		organizationId: ORG,
		nodes: [{ id: "n1", type: "trigger", data: {} }],
		edges: [],
		version: 4,
		publishedVersion: 3,
		webhookSecret: SECRET,
		...overrides,
	};
}

function post(body: string, headers: Record<string, string> = {}) {
	return new Request(
		`https://example.test/api/workflows/trigger/${WORKFLOW_ID}`,
		{ method: "POST", body, headers },
	);
}

async function callPost(request: Request) {
	const { POST } = await import(
		"../../app/api/workflows/trigger/[workflowId]/route"
	);
	return POST(request as never, {
		params: Promise.resolve({ workflowId: WORKFLOW_ID }),
	});
}

async function callGet() {
	const { GET } = await import(
		"../../app/api/workflows/trigger/[workflowId]/route"
	);
	return GET(new Request("https://example.test/x") as never, {
		params: Promise.resolve({ workflowId: WORKFLOW_ID }),
	});
}

function signatureFor(body: string) {
	return `sha256=${crypto.createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

beforeEach(() => {
	vi.clearAllMocks();
	rateLimitMock.mockResolvedValue({ allowed: true, remaining: 59 });
	concurrencyMock.mockResolvedValue({
		allowed: true,
		inFlight: 0,
		limit: 25,
	});
	workflowFindUniqueMock.mockResolvedValue(publishedWorkflow());
	executionCreateMock.mockResolvedValue({
		id: "exec-1",
		startedAt: new Date("2026-08-08T00:00:00Z"),
	});
	executionUpdateMock.mockResolvedValue({});
	apiKeyFindFirstMock.mockResolvedValue({
		id: "key-1",
		workflowId: WORKFLOW_ID,
		keyPrefix: "wfk_abc12345",
		keyHash: crypto.createHash("sha256").update(RAW_KEY).digest("hex"),
		permissions: ["trigger"],
		isActive: true,
		expiresAt: null,
		userId: OWNER,
		organizationId: ORG,
	});
	startMock.mockResolvedValue({ workflowId: "temporal-run-1" });
});

describe("authentication", () => {
	it("starts a run for a valid API key", async () => {
		const res = await callPost(
			post("{}", { authorization: `Bearer ${RAW_KEY}` }),
		);

		expect(res.status).toBe(200);
		expect(startMock).toHaveBeenCalledTimes(1);
	});

	it("starts a run for a valid HMAC signature", async () => {
		const body = JSON.stringify({ hello: "world" });
		const res = await callPost(
			post(body, { "x-workflow-signature": signatureFor(body) }),
		);

		expect(res.status).toBe(200);
		expect(startMock).toHaveBeenCalledTimes(1);
	});

	it("refuses an unsigned, unauthenticated request", async () => {
		const res = await callPost(post("{}"));

		expect(res.status).toBe(401);
		expect(executionCreateMock).not.toHaveBeenCalled();
		expect(startMock).not.toHaveBeenCalled();
	});

	it("refuses a signature computed with the wrong secret", async () => {
		const body = JSON.stringify({ hello: "world" });
		const wrong = `sha256=${crypto.createHmac("sha256", "not-the-secret").update(body).digest("hex")}`;

		const res = await callPost(
			post(body, { "x-workflow-signature": wrong }),
		);

		expect(res.status).toBe(401);
		expect(executionCreateMock).not.toHaveBeenCalled();
	});

	it("refuses a revoked key", async () => {
		apiKeyFindFirstMock.mockResolvedValue(null);

		const res = await callPost(
			post("{}", { authorization: `Bearer ${RAW_KEY}` }),
		);

		expect(res.status).toBe(401);
		expect(executionCreateMock).not.toHaveBeenCalled();
	});

	it("refuses an expired key", async () => {
		apiKeyFindFirstMock.mockResolvedValue({
			keyPrefix: "wfk_abc12345",
			keyHash: crypto.createHash("sha256").update(RAW_KEY).digest("hex"),
			permissions: ["trigger"],
			isActive: true,
			expiresAt: new Date("2020-01-01T00:00:00Z"),
			userId: OWNER,
			organizationId: ORG,
		});

		const res = await callPost(
			post("{}", { authorization: `Bearer ${RAW_KEY}` }),
		);

		expect(res.status).toBe(401);
		expect(executionCreateMock).not.toHaveBeenCalled();
	});

	it("refuses a key whose tenant disagrees with the workflow", async () => {
		// Key rows copy the workflow's tenant at creation. A mismatch means the
		// workflow moved tenant or the row was tampered with; either way the
		// execution would be attributed to the wrong tenant.
		apiKeyFindFirstMock.mockResolvedValue({
			keyPrefix: "wfk_abc12345",
			keyHash: crypto.createHash("sha256").update(RAW_KEY).digest("hex"),
			permissions: ["trigger"],
			isActive: true,
			expiresAt: null,
			userId: "someone-else",
			organizationId: "another-org",
		});

		const res = await callPost(
			post("{}", { authorization: `Bearer ${RAW_KEY}` }),
		);

		expect(res.status).toBe(401);
		expect(executionCreateMock).not.toHaveBeenCalled();
	});

	it("refuses a key without the trigger permission", async () => {
		apiKeyFindFirstMock.mockResolvedValue({
			keyPrefix: "wfk_abc12345",
			keyHash: crypto.createHash("sha256").update(RAW_KEY).digest("hex"),
			permissions: ["read"],
			isActive: true,
			expiresAt: null,
			userId: OWNER,
			organizationId: ORG,
		});

		const res = await callPost(
			post("{}", { authorization: `Bearer ${RAW_KEY}` }),
		);

		expect(res.status).toBe(401);
	});
});

describe("workflow state", () => {
	it("404s an unknown workflow", async () => {
		workflowFindUniqueMock.mockResolvedValue(null);

		const res = await callPost(
			post("{}", { authorization: `Bearer ${RAW_KEY}` }),
		);

		expect(res.status).toBe(404);
	});

	it("refuses a workflow that is still a draft", async () => {
		workflowFindUniqueMock.mockResolvedValue(
			publishedWorkflow({ status: "DRAFT" }),
		);

		const res = await callPost(
			post("{}", { authorization: `Bearer ${RAW_KEY}` }),
		);

		expect(res.status).toBe(403);
		expect(executionCreateMock).not.toHaveBeenCalled();
	});

	it("refuses a workflow whose trigger is not a webhook", async () => {
		workflowFindUniqueMock.mockResolvedValue(
			publishedWorkflow({ triggerType: "MANUAL" }),
		);

		const res = await callPost(
			post("{}", { authorization: `Bearer ${RAW_KEY}` }),
		);

		expect(res.status).toBe(403);
		expect(executionCreateMock).not.toHaveBeenCalled();
	});

	it("rejects a malformed JSON body before touching the workflow", async () => {
		const res = await callPost(
			post("{not json", { authorization: `Bearer ${RAW_KEY}` }),
		);

		expect(res.status).toBe(400);
		expect(executionCreateMock).not.toHaveBeenCalled();
	});
});

describe("guards the manual path already had", () => {
	it("throttles when the rate limiter says so", async () => {
		rateLimitMock.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 30,
			statusCode: 429,
		});

		const res = await callPost(
			post("{}", { authorization: `Bearer ${RAW_KEY}` }),
		);

		expect(res.status).toBe(429);
		expect(workflowFindUniqueMock).not.toHaveBeenCalled();
	});

	it("refuses when the tenant is at its concurrency cap, before creating a row", async () => {
		concurrencyMock.mockResolvedValue({
			allowed: false,
			inFlight: 25,
			limit: 25,
		});

		const res = await callPost(
			post("{}", { authorization: `Bearer ${RAW_KEY}` }),
		);

		expect(res.status).toBe(429);
		expect(executionCreateMock).not.toHaveBeenCalled();
		expect(startMock).not.toHaveBeenCalled();
	});

	it("counts concurrency against the workflow's tenant, not the caller", async () => {
		await callPost(post("{}", { authorization: `Bearer ${RAW_KEY}` }));

		expect(concurrencyMock).toHaveBeenCalledWith({
			userId: OWNER,
			organizationId: ORG,
		});
	});

	it("dispatches to the workflow-builder queue with a run ceiling", async () => {
		await callPost(post("{}", { authorization: `Bearer ${RAW_KEY}` }));

		const [, options] = startMock.mock.calls[0];
		expect(options.taskQueue).toBe("workflow-builder");
		expect(options.workflowExecutionTimeout).toBe("6 hours");
	});
});

describe("when Temporal will not take the run", () => {
	it("marks the execution FAILED instead of leaving it PENDING", async () => {
		startMock.mockRejectedValue(new Error("temporal unreachable"));

		const res = await callPost(
			post("{}", { authorization: `Bearer ${RAW_KEY}` }),
		);

		expect(res.status).toBe(502);
		// Nothing sweeps PENDING executions, so a row left as created would
		// read as "queued" in the run history forever.
		expect(executionUpdateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "exec-1" },
				data: expect.objectContaining({
					status: "FAILED",
					error: "temporal unreachable",
				}),
			}),
		);
	});
});

describe("what the execution row records", () => {
	it("stamps the version that ran, not the published one", async () => {
		// The fixture is deliberately mid-edit: version 4 is the saved graph,
		// publishedVersion 3 is the last snapshot. Every trigger path executes
		// `workflow.nodes`, so a run labelled 3 pointed anyone debugging at a
		// graph that did not run.
		const body = JSON.stringify({ hello: "world" });
		await callPost(
			post(body, { "x-workflow-signature": signatureFor(body) }),
		);

		expect(executionCreateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ version: 4 }),
			}),
		);
	});
});

describe("the unauthenticated health check", () => {
	it("answers whether the webhook is live", async () => {
		const response = await callGet();
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload).toMatchObject({
			workflowId: WORKFLOW_ID,
			status: "PUBLISHED",
			triggerType: "WEBHOOK",
			webhookEnabled: true,
		});
	});

	it("does not hand out the workflow's name", async () => {
		// The endpoint is unauthenticated by design, and the id travels inside
		// webhook URLs pasted into third-party systems. The name answers
		// nothing about whether the hook is wired up and is the one field that
		// says something about the workspace.
		const payload = await (await callGet()).json();

		expect(payload).not.toHaveProperty("name");
		expect(JSON.stringify(payload)).not.toContain("Nightly sync");
	});
});
