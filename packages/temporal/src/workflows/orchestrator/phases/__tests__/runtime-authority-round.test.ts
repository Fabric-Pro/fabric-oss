/**
 * The iterative loop's inline approval round for runtime authority.
 *
 * Behaviour: a tool the activity refused for lack of authority is put in
 * front of the user as the chat's approval card (explicit decision only),
 * the session is approved or denied by the workflow, and the tool is run
 * again — once. A decline, a failed approval or a still-refused re-run all
 * come back as tool errors the model can relay; none fails the run.
 *
 * Wiring: the round only runs behind `orch-iterative-runtime-authority-v1`,
 * and the unpatched call keeps the exact activity input it always sent. Read
 * as source for that half, as `mcp-tool-ceiling-wiring.test.ts` does.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { resolveRuntimeAuthority, runtimeAuthorityApprovalReason } =
	await import("../runtime-authority-round");

type Output = Parameters<typeof resolveRuntimeAuthority>[0];

const request = {
	pendingSessionId: "sess-1",
	providerKey: "notion",
	providerDisplayName: "Notion",
	accessLevel: "WRITE" as const,
	toolName: "notion-create-pages",
};
const refused: Output = {
	success: false,
	output: { error: "Runtime authority required" },
	durationMs: 5,
	cached: false,
	authorityRequired: request,
};
const ran: Output = {
	success: true,
	output: { id: "page-1" },
	durationMs: 7,
	cached: false,
};

function makeDeps() {
	const state = {
		pendingApproval: null,
		approvalDecision: null,
		status: "running",
	} as Parameters<typeof resolveRuntimeAuthority>[1]["state"];
	let seenPending: unknown = null;
	let seenStatus: unknown = null;
	const deps = {
		state,
		toolCallId: "call-1",
		runTool: vi.fn(async () => ran),
		waitForApproval: vi.fn(async () => {
			seenPending = state.pendingApproval;
			seenStatus = state.status;
			return { approved: true };
		}),
		approveSession: vi.fn(async () => ({ success: true })),
		denySession: vi.fn(async () => ({ success: true })),
		updateProgress: vi.fn(),
	};
	return {
		deps,
		seen: () => ({ pending: seenPending, status: seenStatus }),
	};
}

describe("resolveRuntimeAuthority", () => {
	let t: ReturnType<typeof makeDeps>;
	beforeEach(() => {
		t = makeDeps();
	});

	it("passes a tool that needed no authority straight through (READ, or already granted)", async () => {
		const result = await resolveRuntimeAuthority(ran, t.deps);
		expect(result).toBe(ran);
		expect(t.deps.waitForApproval).not.toHaveBeenCalled();
		expect(t.deps.runTool).not.toHaveBeenCalled();
	});

	it("asks explicitly, approves the session, then runs the tool", async () => {
		const result = await resolveRuntimeAuthority(refused, t.deps);

		expect(t.deps.waitForApproval).toHaveBeenCalledWith({
			requireExplicitDecision: true,
		});
		expect(t.seen().status).toBe("awaiting_approval");
		expect(t.seen().pending).toEqual({
			approvalId: "authority-sess-1-call-1",
			stepId: "authority-call-1",
			reason: runtimeAuthorityApprovalReason(request),
		});
		expect(t.deps.approveSession).toHaveBeenCalledWith({
			authoritySessionId: "sess-1",
			instructions: undefined,
		});
		expect(t.deps.runTool).toHaveBeenCalledTimes(1);
		expect(result).toBe(ran);
		expect(t.deps.state.pendingApproval).toBeNull();
		expect(t.deps.state.status).toBe("running");
	});

	it("renders as a HIGH RISK card naming the provider and access level", () => {
		const reason = runtimeAuthorityApprovalReason(request);
		expect(reason).toMatch(/^HIGH RISK: /);
		expect(reason).toContain("WRITE access to Notion");
		expect(reason).toContain('"notion-create-pages"');
	});

	it("on decline denies the session and returns an error the model can relay", async () => {
		t.deps.waitForApproval.mockResolvedValue({
			approved: false,
			feedback: "not now",
		} as never);
		const result = await resolveRuntimeAuthority(refused, t.deps);

		expect(t.deps.denySession).toHaveBeenCalledWith({
			authoritySessionId: "sess-1",
			reason: "not now",
		});
		expect(t.deps.approveSession).not.toHaveBeenCalled();
		expect(t.deps.runTool).not.toHaveBeenCalled();
		expect(result.success).toBe(false);
		expect(result.authorityRequired).toBeUndefined();
		const error = (result.output as { error: string }).error;
		expect(error).toContain("The user declined WRITE access to Notion");
		expect(error).toContain("not now");
	});

	it("treats a cancelled wait as a decline", async () => {
		t.deps.waitForApproval.mockResolvedValue(null as never);
		const result = await resolveRuntimeAuthority(refused, t.deps);
		expect(t.deps.denySession).toHaveBeenCalled();
		expect(t.deps.runTool).not.toHaveBeenCalled();
		expect(result.success).toBe(false);
	});

	it("still declines cleanly when denying the session fails", async () => {
		t.deps.waitForApproval.mockResolvedValue({ approved: false } as never);
		t.deps.denySession.mockRejectedValue(new Error("conflict"));
		const result = await resolveRuntimeAuthority(refused, t.deps);
		expect(result.success).toBe(false);
	});

	it("returns a tool error, not a failed run, when approval cannot be recorded", async () => {
		t.deps.approveSession.mockRejectedValue(new Error("expired"));
		const result = await resolveRuntimeAuthority(refused, t.deps);
		expect(t.deps.runTool).not.toHaveBeenCalled();
		expect(result.success).toBe(false);
		expect((result.output as { error: string }).error).toContain(
			"could not be recorded",
		);
	});

	it("does exactly one round: a re-run still refused is an error, not a second prompt", async () => {
		t.deps.runTool.mockResolvedValue(refused);
		const result = await resolveRuntimeAuthority(refused, t.deps);
		expect(t.deps.waitForApproval).toHaveBeenCalledTimes(1);
		expect(t.deps.runTool).toHaveBeenCalledTimes(1);
		expect(result.success).toBe(false);
		expect(result.authorityRequired).toBeUndefined();
		expect((result.output as { error: string }).error).toContain(
			"not in force",
		);
	});

	it("does not wait when no session could be raised", async () => {
		const noSession: Output = {
			...refused,
			authorityRequired: {
				...request,
				pendingSessionId: undefined,
			},
		};
		const result = await resolveRuntimeAuthority(noSession, t.deps);
		expect(result).toBe(noSession);
		expect(t.deps.waitForApproval).not.toHaveBeenCalled();
	});
});

describe("iterative loop wiring", () => {
	const source = readFileSync(
		join(
			process.cwd(),
			"src/workflows/orchestrator/phases/iterative-execution.ts",
		),
		"utf-8",
	);

	it("opts into runtime authority only behind its own patch marker", () => {
		expect(source).toMatch(
			/\.\.\.\(patched\("orch-iterative-runtime-authority-v1"\)\s*\?\s*\{\s*conversationId: input\.conversationId,\s*requestRuntimeAuthority: true,\s*\}\s*:\s*\{\}\)/,
		);
	});

	it("runs the approval round only when the input asked for authority", () => {
		expect(source).toMatch(
			/if \(mcpToolInput\.requestRuntimeAuthority\) \{\s*result = await resolveRuntimeAuthority\(result,/,
		);
	});

	it("never sends the new fields unconditionally (pre-patch histories keep the old input)", () => {
		expect(source).not.toMatch(
			/^\s*requestRuntimeAuthority: true,\s*\n\s*timeoutMs/m,
		);
		expect(source.match(/requestRuntimeAuthority: true/g)).toHaveLength(1);
		expect(source).not.toMatch(
			/^\s*conversationId: input\.conversationId,\s*\n\s*mcpConfigId/m,
		);
	});
});
