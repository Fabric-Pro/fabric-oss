/**
 * Per-node execution logs.
 *
 * These rows are written by the worker, not by a request, so nothing upstream
 * supplies a tenant for them — the activity has to carry `userId` and
 * `organizationId` down from the run itself. `workflow_execution_log` has a
 * `user_owned` RLS policy keyed on exactly those two columns, so a row created
 * without them is not merely untidy: on a deployment where the app role does
 * not bypass RLS it fails the policy's WITH CHECK outright.
 *
 * The other thing worth pinning is redaction. Node input is whatever the graph
 * passed in, which routinely includes credentials for the integration being
 * called, and these rows are read back into the run-history UI.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirstMock, createLogMock, updateLogMock } = vi.hoisted(() => ({
	findFirstMock: vi.fn(),
	createLogMock: vi.fn(),
	updateLogMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { workflowExecutionLog: { findFirst: findFirstMock } },
	createExecutionLog: createLogMock,
	updateExecutionLog: updateLogMock,
	// Everything else the activity module pulls in at import time.
	getWorkflowById: vi.fn(),
	updateWorkflowExecution: vi.fn(),
	createWorkflowExecution: vi.fn(),
}));

import { createWorkflowExecutionLog } from "../workflow-builder-execution";

const USER = "user-1";
const ORG = "org-1";

beforeEach(() => {
	vi.clearAllMocks();
	findFirstMock.mockResolvedValue(null);
	createLogMock.mockResolvedValue({ id: "log-1" });
	updateLogMock.mockResolvedValue({});
});

describe("tenant inheritance", () => {
	it("stamps the run's tenant onto a new log row", async () => {
		await createWorkflowExecutionLog({
			executionId: "exec-1",
			nodeId: "n1",
			nodeType: "http-request",
			status: "RUNNING",
			userId: USER,
			organizationId: ORG,
		});

		expect(createLogMock).toHaveBeenCalledWith(
			expect.objectContaining({ userId: USER, organizationId: ORG }),
		);
	});

	it("carries a personal run's tenant with no organization", async () => {
		await createWorkflowExecutionLog({
			executionId: "exec-1",
			nodeId: "n1",
			nodeType: "http-request",
			status: "RUNNING",
			userId: USER,
		});

		const [args] = createLogMock.mock.calls[0];
		expect(args.userId).toBe(USER);
		expect(args.organizationId).toBeUndefined();
	});
});

describe("redaction", () => {
	it("never stores a credential handed to the node", async () => {
		await createWorkflowExecutionLog({
			executionId: "exec-1",
			nodeId: "n1",
			nodeType: "http-request",
			status: "RUNNING",
			input: {
				url: "https://api.example.com",
				apiKey: "sk-live-should-not-survive",
				headers: { authorization: "Bearer super-secret-token" },
			},
			userId: USER,
			organizationId: ORG,
		});

		const [args] = createLogMock.mock.calls[0];
		const serialised = JSON.stringify(args.input ?? {});
		expect(serialised).not.toContain("sk-live-should-not-survive");
		expect(serialised).not.toContain("super-secret-token");
		// The non-sensitive part still has to survive, or the log is useless.
		expect(serialised).toContain("api.example.com");
	});
});

describe("idempotency", () => {
	it("updates the existing row for a node rather than writing a second one", async () => {
		// A node reports twice — once starting, once finishing. Two rows for
		// one node would double every entry in the run history.
		findFirstMock.mockResolvedValue({ id: "log-existing" });

		await createWorkflowExecutionLog({
			executionId: "exec-1",
			nodeId: "n1",
			nodeType: "http-request",
			status: "COMPLETED",
			output: { ok: true },
			userId: USER,
			organizationId: ORG,
		});

		expect(createLogMock).not.toHaveBeenCalled();
		expect(updateLogMock).toHaveBeenCalledWith(
			"log-existing",
			expect.objectContaining({ status: "COMPLETED" }),
		);
	});

	it("scopes the existing-row lookup to this execution and node", async () => {
		await createWorkflowExecutionLog({
			executionId: "exec-1",
			nodeId: "n1",
			nodeType: "http-request",
			status: "RUNNING",
			userId: USER,
		});

		expect(findFirstMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { executionId: "exec-1", nodeId: "n1" },
			}),
		);
	});
});
