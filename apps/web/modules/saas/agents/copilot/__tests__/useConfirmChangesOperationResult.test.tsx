// apps/web/modules/saas/agents/copilot/__tests__/useConfirmChangesOperationResult.test.tsx
/**
 * Unit tests for the `useConfirmChangesOperationResult` hook —
 * Fizzy #1412 PR3 §7.4 CopilotKit Option A follow-up.
 *
 * The hook returns a fire-and-forget recorder that posts a
 * `role: "system"` operation-result message via
 * `agents.conversations.recordOperationResult` whenever a CopilotKit
 * `confirm_changes` tool resolves with the user's accept / reject
 * decision. These tests pin the contract that the hook is
 * **best-effort** (never throws, never blocks the consumer flow) and
 * that the orpcClient is called with exactly the args the server
 * handler expects.
 *
 * # Test scope rationale (Codex round-2 Important #3)
 *
 * These tests pin the helper contract directly. The StoryWorkspace
 * integration (a 4153-line component) is not directly mocked — its
 * wire-up is a 2-line addition to `handleAccept`/`handleReject` plus
 * an import, both of which are obvious-to-read in the PR diff and
 * exercised by the existing E2E spec at
 * `apps/web/tests/ai-chat/standalone-fabric-ai-regression.spec.ts`.
 * A full StoryWorkspace integration test that mocks the entire
 * useCopilotAction renderRef + CopilotKit chat tree would require
 * disproportionate setup for a 2-line wire-up; the contract-level
 * coverage here plus the E2E is the right testing layer split.
 *
 * We mock `orpcClient` at the module boundary and observe the calls
 * directly — same pattern as the agent-id-validation tests on the
 * server side. No real network or React-Query plumbing is touched.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	recordOperationResult: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agents: {
			conversations: {
				recordOperationResult: mocks.recordOperationResult,
			},
		},
	},
}));

import { useConfirmChangesOperationResult } from "../useConfirmChangesOperationResult";

const PROJECT_ID = "proj-1";
const ORG_ID = "org-1";
const CONV_ID = "conv-1";

beforeEach(() => {
	mocks.recordOperationResult.mockReset();
	mocks.recordOperationResult.mockResolvedValue({
		messageId: "msg-1",
		deduplicated: false,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("useConfirmChangesOperationResult", () => {
	it("posts outcome='success' to recordOperationResult when accepted=true", async () => {
		const { result } = renderHook(() =>
			useConfirmChangesOperationResult({
				conversationId: CONV_ID,
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
			}),
		);

		await result.current({
			accepted: true,
			summary: "User confirmed the doc edits.",
		});

		expect(mocks.recordOperationResult).toHaveBeenCalledTimes(1);
		const args = mocks.recordOperationResult.mock.calls[0]?.[0];
		expect(args).toMatchObject({
			conversationId: CONV_ID,
			projectId: PROJECT_ID,
			organizationId: ORG_ID,
			outcome: "success",
			operationLabel: "Confirm changes",
			summary: "User confirmed the doc edits.",
		});
		// operationKey is fresh UUID per call — just assert it's a non-empty string.
		expect(args?.operationKey).toBeTruthy();
		expect(typeof args?.operationKey).toBe("string");
	});

	it("posts outcome='cancelled' to recordOperationResult when accepted=false", async () => {
		const { result } = renderHook(() =>
			useConfirmChangesOperationResult({
				conversationId: CONV_ID,
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
			}),
		);

		await result.current({ accepted: false });

		expect(mocks.recordOperationResult).toHaveBeenCalledTimes(1);
		const args = mocks.recordOperationResult.mock.calls[0]?.[0];
		expect(args?.outcome).toBe("cancelled");
		// Default summary on reject — explicit verification.
		expect(args?.summary).toBe("Changes rejected.");
	});

	it("falls back to default summary when caller omits one (accepted=true)", async () => {
		const { result } = renderHook(() =>
			useConfirmChangesOperationResult({
				conversationId: CONV_ID,
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
			}),
		);

		await result.current({ accepted: true });

		const args = mocks.recordOperationResult.mock.calls[0]?.[0];
		expect(args?.summary).toBe("Changes accepted.");
	});

	it("propagates custom operationLabel from the hook args", async () => {
		const { result } = renderHook(() =>
			useConfirmChangesOperationResult({
				conversationId: CONV_ID,
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				operationLabel: "Apply document edits",
			}),
		);

		await result.current({ accepted: true });

		const args = mocks.recordOperationResult.mock.calls[0]?.[0];
		expect(args?.operationLabel).toBe("Apply document edits");
	});

	it("passes artifact through when provided", async () => {
		const { result } = renderHook(() =>
			useConfirmChangesOperationResult({
				conversationId: CONV_ID,
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
			}),
		);

		await result.current({
			accepted: true,
			artifact: {
				label: "View saved version",
				url: "https://example.com/v/42",
			},
		});

		const args = mocks.recordOperationResult.mock.calls[0]?.[0];
		expect(args?.artifact).toEqual({
			label: "View saved version",
			url: "https://example.com/v/42",
		});
	});

	it("NO-OPs when conversationId is null but LOGS via console.info (observable)", async () => {
		// PersistenceHook hasn't lazy-created yet, or feature flag is off.
		// Helper must return without calling the server — otherwise we'd
		// either crash on the `min(1)` Zod check or create an orphan row.
		// Codex round-2 Important #1: the drop is logged via console.info
		// (not a silent return) so a fresh-session race is observable in
		// browser devtools / Sentry breadcrumbs.
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		const { result } = renderHook(() =>
			useConfirmChangesOperationResult({
				conversationId: null,
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
			}),
		);

		await result.current({ accepted: true });

		expect(mocks.recordOperationResult).not.toHaveBeenCalled();
		expect(infoSpy).toHaveBeenCalledTimes(1);
		const [message] = infoSpy.mock.calls[0] ?? [];
		expect(String(message)).toContain("conversationId is null");
	});

	it("DEDUPS rapid double-click via in-flight Promise (Codex round-2 Important #2)", async () => {
		// If the user double-clicks Accept/Reject faster than React can
		// commit `setIsAwaitingConfirmation(false)` in the consumer
		// site, both click handlers can fire `recordConfirmChangesOutcome`
		// in the same render cycle. Without the in-flight guard, they'd
		// use different operationKey UUIDs and the server's per-key
		// dedup would NOT catch the duplicate → two persisted rows.
		// The helper's inFlightPromiseRef should make the second call
		// share the first's Promise → exactly ONE orpcClient invocation.
		let resolveFirst: (() => void) | undefined;
		mocks.recordOperationResult.mockImplementationOnce(
			() =>
				new Promise<{ messageId: string; deduplicated: boolean }>(
					(resolve) => {
						resolveFirst = () =>
							resolve({
								messageId: "msg-1",
								deduplicated: false,
							});
					},
				),
		);

		const { result } = renderHook(() =>
			useConfirmChangesOperationResult({
				conversationId: CONV_ID,
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
			}),
		);

		// Fire two calls in immediate succession — simulates rapid
		// double-click before the first server roundtrip resolves.
		const firstCall = result.current({ accepted: true });
		const secondCall = result.current({ accepted: true });

		// Only ONE orpcClient call should have happened.
		expect(mocks.recordOperationResult).toHaveBeenCalledTimes(1);

		// The second call should be the SAME Promise as the first.
		expect(secondCall).toBe(firstCall);

		// Resolve the first call → both Promises settle.
		resolveFirst?.();
		await firstCall;
		await secondCall;

		// After resolution, a third call should fire fresh (no leaked
		// in-flight state from the prior cycle).
		mocks.recordOperationResult.mockResolvedValueOnce({
			messageId: "msg-2",
			deduplicated: false,
		});
		await result.current({ accepted: false });
		expect(mocks.recordOperationResult).toHaveBeenCalledTimes(2);
	});

	it("generates a UNIQUE operationKey per call (no client-side dedup)", async () => {
		const { result } = renderHook(() =>
			useConfirmChangesOperationResult({
				conversationId: CONV_ID,
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
			}),
		);

		await result.current({ accepted: true });
		await result.current({ accepted: false });

		expect(mocks.recordOperationResult).toHaveBeenCalledTimes(2);
		const firstKey =
			mocks.recordOperationResult.mock.calls[0]?.[0]?.operationKey;
		const secondKey =
			mocks.recordOperationResult.mock.calls[1]?.[0]?.operationKey;
		expect(firstKey).toBeTruthy();
		expect(secondKey).toBeTruthy();
		expect(firstKey).not.toBe(secondKey);
	});

	it("swallows API errors silently (best-effort persistence)", async () => {
		// Helper must NEVER block the user's accept/reject decision.
		// A network 500 or oRPC failure is logged + swallowed.
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.recordOperationResult.mockRejectedValueOnce(
			new Error("Network failure"),
		);

		const { result } = renderHook(() =>
			useConfirmChangesOperationResult({
				conversationId: CONV_ID,
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
			}),
		);

		// Should NOT throw.
		await expect(
			result.current({ accepted: true }),
		).resolves.toBeUndefined();
		// Should warn for observability.
		expect(warnSpy).toHaveBeenCalledTimes(1);
		const [message] = warnSpy.mock.calls[0] ?? [];
		expect(String(message)).toContain("Failed to record operation result");
	});

	it("accepts null organizationId (personal-mode tenant)", async () => {
		const { result } = renderHook(() =>
			useConfirmChangesOperationResult({
				conversationId: CONV_ID,
				projectId: PROJECT_ID,
				organizationId: null,
			}),
		);

		await result.current({ accepted: true });

		const args = mocks.recordOperationResult.mock.calls[0]?.[0];
		expect(args?.organizationId).toBeNull();
	});
});
