/**
 * Recovering a thread that a 413 would otherwise have killed (Fizzy #2167).
 *
 * The budget check makes an over-large request unlikely, not impossible — the
 * client measures an attachment's encoded size, while the body also carries
 * message history and agent state that it does not control. So the failure path
 * still has to leave the conversation usable.
 *
 * That is the half of the bug users actually reported. A refused request never
 * reaches the model, but its attachment stays in the conversation's context, so
 * every later turn ships it again and is refused again — plain text with no
 * attachment included. The thread cannot be recovered by any action inside it.
 *
 * The detection lives in a module-level `window.fetch` patch with no React
 * context, and the attachments live in a component far below it, so the two are
 * joined by an event. This pins both ends: that the patch announces a 413, and
 * that the owner listens and drops what it holds.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	AI_REQUEST_TOO_LARGE_EVENT,
	CopilotFetchErrorInterceptor,
} from "@saas/shared/components/copilot/CopilotFetchErrorInterceptor";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@saas/shared/components/copilot/copilot-error-toast", () => ({
	showPersistentAiErrorToast: vi.fn(),
	showTransientAiErrorToast: vi.fn(),
	dismissAiErrorToast: vi.fn(),
	resolveAiErrorToast: vi.fn(),
}));

vi.mock("@saas/payments/lib/ai-usage-limit-toast", () => ({
	useShowAiUsageLimitToast: () => vi.fn(),
	isAiUsageLimitExceededPayload: () => false,
}));

function jsonResponse(status: number): Response {
	return new Response(JSON.stringify({ error: "nope" }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function copilotPost(): [string, RequestInit] {
	return [
		"/api/copilotkit",
		{
			method: "POST",
			body: JSON.stringify({
				method: "agent/run",
				params: { agentId: "a", threadId: "t" },
			}),
		},
	];
}

describe("the interceptor announces a refused body", () => {
	let originalFetchMock: ReturnType<typeof vi.fn>;
	let listener: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		originalFetchMock = vi.fn();
		window.fetch = originalFetchMock as unknown as typeof window.fetch;
		listener = vi.fn();
		window.addEventListener(AI_REQUEST_TOO_LARGE_EVENT, listener);
	});

	afterEach(() => {
		window.removeEventListener(AI_REQUEST_TOO_LARGE_EVENT, listener);
	});

	it("dispatches the event on a 413", async () => {
		render(<CopilotFetchErrorInterceptor />);
		originalFetchMock.mockResolvedValueOnce(jsonResponse(413));

		await window.fetch(...copilotPost());

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("stays quiet on failures an attachment cannot explain", async () => {
		// Dropping a user's attachments is destructive, so it must be tied to
		// the one status that says the body itself was refused — not to any
		// error that happens to arrive while an attachment is present.
		render(<CopilotFetchErrorInterceptor />);

		for (const status of [400, 401, 403, 500, 503]) {
			originalFetchMock.mockResolvedValueOnce(jsonResponse(status));
			await window.fetch(...copilotPost());
		}

		expect(listener).not.toHaveBeenCalled();
	});

	it("stays quiet on success", async () => {
		render(<CopilotFetchErrorInterceptor />);
		originalFetchMock.mockResolvedValueOnce(
			new Response("{}", { status: 200 }),
		);

		await window.fetch(...copilotPost());

		expect(listener).not.toHaveBeenCalled();
	});
});

/**
 * The listening half is in `StoryWorkspace`, a component whose render pulls in
 * CopilotKit, TipTap and the whole project shell. Mounting it to assert one
 * state reset is not a proportionate test, so its wiring is read from source —
 * mirroring `rag-context-single-delivery.test.ts`, the repo's existing pattern
 * for pinning a property of that component that only manifests at runtime.
 */
describe("the feature assistant drops its uploads when told", () => {
	const source = readFileSync(
		join(
			process.cwd(),
			"modules/saas/projects/components/stories/StoryWorkspace.tsx",
		),
		"utf8",
	);

	it("listens for the event", () => {
		expect(source).toContain(
			"window.addEventListener(AI_REQUEST_TOO_LARGE_EVENT",
		);
	});

	it("removes the listener when it unmounts", () => {
		// The component survives a story switch and outlives many
		// conversations; a listener leaked per mount would clear the contexts
		// of every workspace ever opened in this session.
		expect(source).toContain(
			"window.removeEventListener(AI_REQUEST_TOO_LARGE_EVENT",
		);
	});

	it("clears the uploads on story switch", () => {
		// The component is mounted without a `key`, so it is reused across
		// stories. Without this the previous feature's images follow the user
		// into an unrelated one, spending its budget and entering its prompt.
		expect(source).toMatch(
			/clearUploadedRagContexts\(\);\s*\n\s*\}, \[story\.id, clearUploadedRagContexts\]\)/,
		);
	});

	it("clears the uploads when a new conversation starts", () => {
		// Both branches of `handleNewConversation` reset the conversation — the
		// archive call is allowed to fail and the reset happens anyway — so both
		// have to drop the uploads, or "new chat" starts already carrying the
		// images that broke the last one.
		const resets = source.match(/setCopilotMessages\(\[\]\);/g) ?? [];
		const clears = source.match(/clearUploadedRagContexts\(\);/g) ?? [];
		expect(resets.length).toBeGreaterThanOrEqual(2);
		// One clear per conversation reset, plus story switch and the 413 path.
		expect(clears.length).toBeGreaterThanOrEqual(resets.length);
	});

	it("reports resident bytes and image count to the upload hook", () => {
		// Without this the hook judges an attachment on its own and re-admits
		// the case that caused the bug.
		expect(source).toContain("getResidentContext");
		expect(source).toMatch(/imageCount:\s*uploadedRagContexts\.filter/);
	});
});
