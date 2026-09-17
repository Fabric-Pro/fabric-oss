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
	reserveMock,
	workflowFindUniqueMock,
	executionUpdateMock,
	markRunningMock,
	apiKeyFindFirstMock,
	apiKeyUpdateMock,
	startMock,
	describeMock,
} = vi.hoisted(() => ({
	rateLimitMock: vi.fn(),
	reserveMock: vi.fn(),
	workflowFindUniqueMock: vi.fn(),
	executionUpdateMock: vi.fn(),
	markRunningMock: vi.fn(),
	apiKeyFindFirstMock: vi.fn(),
	apiKeyUpdateMock: vi.fn(),
	startMock: vi.fn(),
	describeMock: vi.fn(),
}));

vi.mock("@repo/api/lib/rate-limit", () => ({ checkRateLimit: rateLimitMock }));

// The row is created inside the capacity reservation; the mock returns the
// row the way the real helper does.
vi.mock("@repo/api/modules/workflows/lib/execution-concurrency", () => ({
	createExecutionWithinConcurrencyCap: reserveMock,
	concurrencyRefusalMessage: (r: { inFlight: number; limit: number }) =>
		`This workspace already has ${r.inFlight} workflow executions running (limit ${r.limit}).`,
}));

vi.mock("@repo/database", () => ({
	db: {
		workflow: { findUnique: workflowFindUniqueMock },
		workflowExecution: {
			update: executionUpdateMock,
		},
		workflowApiKey: {
			findFirst: apiKeyFindFirstMock,
			update: apiKeyUpdateMock,
		},
	},
	markExecutionRunningIfPending: markRunningMock,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: {
			start: startMock,
			getHandle: () => ({ describe: describeMock }),
		},
	}),
}));

/** Temporal's typed errors are matched by name, so a named Error stands in. */
function temporalError(name: string): Error {
	const error = new Error(name);
	error.name = name;
	return error;
}

function failedWrites() {
	return executionUpdateMock.mock.calls.filter(
		([args]) =>
			(args as { data?: { status?: string } }).data?.status === "FAILED",
	);
}

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
	reserveMock.mockResolvedValue({
		allowed: true,
		execution: {
			id: "exec-1",
			startedAt: new Date("2026-08-08T00:00:00Z"),
		},
		inFlight: 1,
		limit: 25,
	});
	workflowFindUniqueMock.mockResolvedValue(publishedWorkflow());
	executionUpdateMock.mockResolvedValue({});
	markRunningMock.mockResolvedValue(true);
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
	// Default: a start that threw really did not happen.
	describeMock.mockRejectedValue(temporalError("WorkflowNotFoundError"));
});

describe("authentication", () => {
	it("starts a run for a valid API key", async () => {
		const res = await callPost(
			post("{}", { authorization: `Bearer ${RAW_KEY}` }),
		);

		expect(res.status).toBe(200);
		expect(startMock).toHaveBeenCalledTimes(1);
	});

	it("still reports a started run when marking the row RUNNING fails, and never marks it FAILED", async () => {
		markRunningMock.mockRejectedValueOnce(new Error("connection reset"));

		const res = await callPost(
			post("{}", { authorization: `Bearer ${RAW_KEY}` }),
		);

		expect(res.status).toBe(200);
		expect(startMock).toHaveBeenCalledTimes(1);
		expect(failedWrites()).toHaveLength(0);
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
		expect(reserveMock).not.toHaveBeenCalled();
		expect(startMock).not.toHaveBeenCalled();
	});

	it("refuses a signature computed with the wrong secret", async () => {
		const body = JSON.stringify({ hello: "world" });
		const wrong = `sha256=${crypto.createHmac("sha256", "not-the-secret").update(body).digest("hex")}`;

		const res = await callPost(
			post(body, { "x-workflow-signature": wrong }),
		);

		expect(res.status).toBe(401);
		expect(reserveMock).not.toHaveBeenCalled();
	});

	it("refuses a revoked key", async () => {
		apiKeyFindFirstMock.mockResolvedValue(null);

		const res = await callPost(
			post("{}", { authorization: `Bearer ${RAW_KEY}` }),
		);

		expect(res.status).toBe(401);
		expect(reserveMock).not.toHaveBeenCalled();
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
		expect(reserveMock).not.toHaveBeenCalled();
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
		expect(reserveMock).not.toHaveBeenCalled();
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
		expect(reserveMock).not.toHaveBeenCalled();
	});

	it("refuses a workflow whose trigger is not a webhook", async () => {
		workflowFindUniqueMock.mockResolvedValue(
			publishedWorkflow({ triggerType: "MANUAL" }),
		);

		const res = await callPost(
			post("{}", { authorization: `Bearer ${RAW_KEY}` }),
		);

		expect(res.status).toBe(403);
		expect(reserveMock).not.toHaveBeenCalled();
	});

	it("rejects a malformed JSON body before touching the workflow", async () => {
		const res = await callPost(
			post("{not json", { authorization: `Bearer ${RAW_KEY}` }),
		);

		expect(res.status).toBe(400);
		expect(reserveMock).not.toHaveBeenCalled();
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

	it("refuses when the tenant is at its concurrency cap, starting nothing", async () => {
		reserveMock.mockResolvedValue({
			allowed: false,
			inFlight: 25,
			limit: 25,
		});

		const res = await callPost(
			post("{}", { authorization: `Bearer ${RAW_KEY}` }),
		);

		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("60");
		expect(startMock).not.toHaveBeenCalled();
		expect(executionUpdateMock).not.toHaveBeenCalled();
	});

	it("reserves capacity against the workflow's tenant, not the caller, with the row it will create", async () => {
		// A webhook is the path most able to flood, so the cap and the insert
		// have to be one decision here, not a count followed by a create.
		const body = JSON.stringify({ hello: "world" });
		await callPost(post(body, { authorization: `Bearer ${RAW_KEY}` }));

		expect(reserveMock).toHaveBeenCalledWith({
			userId: OWNER,
			organizationId: ORG,
			data: expect.objectContaining({
				workflowId: WORKFLOW_ID,
				triggerType: "WEBHOOK",
				triggerInput: { hello: "world" },
			}),
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
	it("marks the execution FAILED instead of leaving it PENDING once Temporal confirms no run exists", async () => {
		startMock.mockRejectedValue(new Error("temporal unreachable"));
		describeMock.mockRejectedValue(temporalError("WorkflowNotFoundError"));

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

	it("reports an accepted-but-lost start as started — the sender's retry would run it twice", async () => {
		startMock.mockRejectedValue(new Error("DEADLINE_EXCEEDED"));
		describeMock.mockResolvedValue({ runId: "run-accepted" });

		const res = await callPost(
			post("{}", { authorization: `Bearer ${RAW_KEY}` }),
		);

		expect(res.status).toBe(200);
		expect(failedWrites()).toHaveLength(0);
		// Conditional on PENDING: a run that already finished stays finished.
		expect(markRunningMock).toHaveBeenCalledWith({
			executionId: "exec-1",
			temporalRunId: "workflow-execution-exec-1",
		});
	});

	it("answers 202 unconfirmed with the execution id, not a 5xx the sender would retry, when the start cannot be settled", async () => {
		startMock.mockRejectedValue(new Error("DEADLINE_EXCEEDED"));
		describeMock.mockRejectedValue(new Error("UNAVAILABLE"));

		const res = await callPost(
			post("{}", { authorization: `Bearer ${RAW_KEY}` }),
		);

		// Webhook senders retry server errors; a retry is a second row and run.
		expect(res.status).toBe(202);
		// Neither FAILED (invites a duplicate retry) nor RUNNING (claims a
		// confirmation nobody has): the row is left exactly as created, and
		// no second row was reserved.
		expect(executionUpdateMock).not.toHaveBeenCalled();
		expect(markRunningMock).not.toHaveBeenCalled();
		expect(reserveMock).toHaveBeenCalledTimes(1);
		const body = (await res.json()) as {
			executionId: string;
			status: string;
		};
		expect(body.status).toBe("unconfirmed");
		expect(body.executionId).toBe("exec-1");
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

		expect(reserveMock).toHaveBeenCalledWith(
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
