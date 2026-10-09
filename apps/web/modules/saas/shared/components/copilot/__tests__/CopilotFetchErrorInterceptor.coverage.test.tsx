/**
 * Coverage tests for `CopilotFetchErrorInterceptor` — which failures reach the
 * user at all, as opposed to how long the toast stays up (the sibling
 * `.persist` suite covers that).
 *
 * The defect: the interceptor mapped statuses through an `else if` chain with
 * no final `else`, and only intercepted `/api/copilotkit`. Two consequences,
 * both of which presented to the user as "the assistant just stopped
 * responding":
 *
 *   - **402 produced no toast whatsoever.** That is the status a provider
 *     returns when the account is out of credit, which in production was the
 *     single largest cause of assistant failures.
 *   - **Every other AI transport was unmonitored** — the Nexus/Loom direct
 *     stream, the Temporal orchestrator, the sidekick and `/api/ai/generate`
 *     all failed silently.
 *
 * Mocking mirrors the sibling suite: only the boundaries (`sonner`, the
 * ai-usage-limit hook) are mocked, and interception is exercised end-to-end
 * through a stub original fetch.
 */

import { ActiveOrganizationContext } from "@saas/organizations/lib/active-organization-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STREAM_SILENCE_MS } from "../ag-ui-run-error";
import { CopilotFetchErrorInterceptor } from "../CopilotFetchErrorInterceptor";
import { resetAiErrorToastDedupForTests } from "../copilot-error-toast";

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), dismiss: vi.fn(), success: vi.fn() },
}));

vi.mock("@saas/payments/lib/ai-usage-limit-toast", () => ({
	isAiUsageLimitExceededPayload: () => false,
	useShowAiUsageLimitToast: () => vi.fn(),
}));

const setOrganizationUse = vi.hoisted(() => vi.fn());
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { users: { chatgptPlan: { setOrganizationUse } } },
}));

const originalWindowFetch = window.fetch;

afterEach(() => {
	cleanup();
	window.fetch = originalWindowFetch;
	resetAiErrorToastDedupForTests();
	vi.clearAllMocks();
});

async function fireAt(url: string, makeResponse: () => Response) {
	window.fetch = vi.fn(makeResponse) as unknown as typeof window.fetch;
	render(<CopilotFetchErrorInterceptor />);
	await window.fetch(url, { method: "POST" });
}

describe("no AI failure is silent", () => {
	it("surfaces an out-of-credit 402 that previously produced no toast at all", async () => {
		await fireAt(
			"/api/copilotkit",
			() =>
				new Response(
					JSON.stringify({
						error: "A positive credit balance is required for all requests.",
					}),
					{
						status: 402,
						headers: { "Content-Type": "application/json" },
					},
				),
		);

		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(toast.error).toHaveBeenCalledWith(
			"AI provider out of credit",
			expect.objectContaining({ duration: Number.POSITIVE_INFINITY }),
		);
	});

	it("surfaces a 403, which the old chain also skipped", async () => {
		await fireAt(
			"/api/copilotkit",
			() => new Response(null, { status: 403 }),
		);

		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(toast.error).toHaveBeenCalledWith(
			"Not allowed",
			expect.anything(),
		);
	});
});

describe("coverage extends beyond the CopilotKit transport", () => {
	it.each([
		["Nexus/Loom direct stream", "/api/agents/fabric-ai/stream"],
		[
			"Temporal orchestrator",
			"/api/agents/fabric-ai/orchestrator-temporal/stream",
		],
		["sidekick", "/api/agents/sidekick/stream"],
		["generate", "/api/ai/generate"],
	])("surfaces a failure on the %s endpoint", async (_label, url) => {
		await fireAt(url, () => new Response("kaboom", { status: 500 }));

		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(toast.error).toHaveBeenCalledWith(
			"Server error",
			expect.anything(),
		);
	});
});

describe("deliberate exclusions stay silent", () => {
	// Each case is a regression found by auditing what broad interception
	// newly swept in — not a hypothetical. Widening coverage without these
	// turns "no failure is silent" into "the user is nagged by failures they
	// cannot act on", which is its own bug.
	it.each([
		[
			"fire-and-forget cancel — nothing to act on, the run reports itself",
			"/api/agents/fabric-ai/stream/cancel",
		],
		[
			"ambient tool suggestions — useToolSuggestions fails quietly by design",
			"/api/agents/fabric-ai/suggest-tools",
		],
		[
			"image upload — the calling chat component already toasts its own failure",
			"/api/agents/fabric-ai/upload-image",
		],
	])("says nothing for %s", async (_reason, url) => {
		await fireAt(url, () => new Response(null, { status: 500 }));

		await new Promise((r) => setTimeout(r, 20));
		expect(toast.error).not.toHaveBeenCalled();
	});

	it.each([
		["TURN_IN_PROGRESS", 409],
		["TURN_PENDING", 409],
		["TURN_CANCELLED", 409],
		["TURN_STATE_UNAVAILABLE", 503],
	])(
		"says nothing for an Advisor %s refusal, which the chat handles itself",
		async (code, status) => {
			await fireAt(
				"/api/agents/fabric-ai/orchestrator-temporal/stream",
				() =>
					new Response(JSON.stringify({ error: "refused", code }), {
						status,
						headers: { "Content-Type": "application/json" },
					}),
			);

			await new Promise((r) => setTimeout(r, 20));
			expect(toast.error).not.toHaveBeenCalled();
		},
	);

	it("still surfaces a turn code from any other AI endpoint", async () => {
		await fireAt(
			"/api/agents/fabric-ai/stream",
			() =>
				new Response(
					JSON.stringify({
						error: "refused",
						code: "TURN_IN_PROGRESS",
					}),
					{
						status: 409,
						headers: { "Content-Type": "application/json" },
					},
				),
		);

		await waitFor(() => expect(toast.error).toHaveBeenCalled());
	});

	it("does not touch non-AI requests", async () => {
		await fireAt(
			"/api/rpc/projects/list",
			() => new Response(null, { status: 500 }),
		);

		await new Promise((r) => setTimeout(r, 20));
		expect(toast.error).not.toHaveBeenCalled();
	});
});

/**
 * The failure that survived the status-based sweep above: the run fails *after*
 * the response has already succeeded, so there is no status left to key off.
 *
 * Captured from a real failing run on the AI Feature Assistant — `200` with
 * `content-type: text/event-stream` and a single `RUN_ERROR` frame. Nothing
 * caught it: `<CopilotKit onError>` is wired but v1 only calls it when a
 * `publicApiKey`/`publicLicenseKey` is configured, and this interceptor
 * returned every ok response untouched.
 */
describe("a run that fails after the response already succeeded", () => {
	function runErrorStream(frame: string): Response {
		const encoder = new TextEncoder();
		return new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(frame));
					controller.close();
				},
			}),
			{
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			},
		);
	}

	it("surfaces a RUN_ERROR delivered inside a 200, which produced no toast at all", async () => {
		await fireAt("/api/copilotkit", () =>
			runErrorStream(
				'data: {"type":"RUN_ERROR","message":"fetch failed","code":"INCOMPLETE_STREAM"}\n',
			),
		);

		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(toast.error).toHaveBeenCalledWith(
			"AI request failed",
			expect.objectContaining({ description: "fetch failed" }),
		);
	});

	it("names an out-of-credit provider the same mid-stream as it does on a 402", async () => {
		await fireAt("/api/copilotkit", () =>
			runErrorStream(
				'data: {"type":"RUN_ERROR","message":"Your credit balance is too low to run this request."}\n',
			),
		);

		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(toast.error).toHaveBeenCalledWith(
			"AI provider out of credit",
			expect.anything(),
		);
	});

	it("surfaces a connection that dies part-way through a reply", async () => {
		// The 200 already committed, so the status says nothing. Before this
		// change the half-delivered reply just stopped and the user was told
		// nothing — the same silence, arriving a different way.
		const encoder = new TextEncoder();
		await fireAt(
			"/api/copilotkit",
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(
								encoder.encode(
									'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Here"}\n',
								),
							);
							controller.error(new Error("network died"));
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "text/event-stream" },
					},
				),
		);

		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(toast.error).toHaveBeenCalledWith(
			"Connection failed",
			expect.anything(),
		);
	});

	it("stays silent for a successful run, so a healthy stream never toasts", async () => {
		await fireAt("/api/copilotkit", () =>
			runErrorStream(
				'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"All good"}\ndata: {"type":"RUN_FINISHED"}\n',
			),
		);

		// Give the background watcher the same chance to fire that the
		// assertions above rely on; the point is that it does not.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("leaves the response body intact after the watcher has read and cancelled its clone", async () => {
		window.fetch = vi.fn(() =>
			runErrorStream(
				'data: {"type":"RUN_ERROR","message":"fetch failed"}\n',
			),
		) as unknown as typeof window.fetch;
		render(<CopilotFetchErrorInterceptor />);
		const delivered = await window.fetch("/api/copilotkit", {
			method: "POST",
		});

		// Wait for the toast before reading: it is the observable proof that
		// the watcher has finished with its clone and run `reader.cancel()`.
		// Reading the body first would pass even if cancelling a tee branch
		// truncated the other one, which is the risk this test exists to cover.
		await waitFor(() => expect(toast.error).toHaveBeenCalled());

		await expect(delivered.text()).resolves.toContain("RUN_ERROR");
	});
});

/**
 * Both findings from the UX review of this module, pinned so they cannot
 * silently come back.
 */
describe("the notice does not become its own problem", () => {
	function sseResponse(frame: string): Response {
		const encoder = new TextEncoder();
		return new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(frame));
					controller.close();
				},
			}),
			{ status: 200, headers: { "Content-Type": "text/event-stream" } },
		);
	}

	it("never puts a raw wire code in front of the user", async () => {
		// A frame carrying only `code` used to render "INCOMPLETE_STREAM" as the
		// toast body — a machine token that reads as a broken error message.
		await fireAt("/api/copilotkit", () =>
			sseResponse(
				'data: {"type":"RUN_ERROR","code":"INCOMPLETE_STREAM"}\n',
			),
		);

		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		const [title, opts] = (
			toast.error as unknown as ReturnType<typeof vi.fn>
		).mock.calls[0] as [string, { description?: string }];
		expect(title).toBe("AI request failed");
		expect(opts.description ?? "").not.toContain("INCOMPLETE_STREAM");
		expect(opts.description ?? "").toMatch(/could not complete/i);
	});
});

/**
 * The silence watchdog, exercised through the interceptor at its REAL
 * production threshold.
 *
 * Fake timers are the point: an earlier attempt at this test used a real
 * stalling stream, which could never have waited out `STREAM_SILENCE_MS` and so
 * would have gone green without executing the path at all. Advancing the clock
 * runs the actual constant and the actual wiring.
 */
describe("a run that goes quiet", () => {
	function pendingSseResponse(): {
		response: Response;
		push: (frame: string) => void;
		close: () => void;
	} {
		const encoder = new TextEncoder();
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(c) {
					controller = c;
					c.enqueue(encoder.encode('data: {"type":"RUN_STARTED"}\n'));
				},
			}),
			{ status: 200, headers: { "Content-Type": "text/event-stream" } },
		);
		return {
			response,
			push: (frame) => controller.enqueue(encoder.encode(frame)),
			close: () => controller.close(),
		};
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it("says so at the real threshold, then retracts it when the run speaks again", async () => {
		vi.useFakeTimers();
		const stream = pendingSseResponse();
		window.fetch = vi.fn(
			() => stream.response,
		) as unknown as typeof window.fetch;
		render(<CopilotFetchErrorInterceptor />);
		await window.fetch("/api/copilotkit", { method: "POST" });

		// Still inside the window: nothing said yet.
		await vi.advanceTimersByTimeAsync(STREAM_SILENCE_MS - 1_000);
		expect(toast.error).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(2_000);
		expect(toast.error).toHaveBeenCalledWith(
			"The assistant has gone quiet",
			expect.objectContaining({ duration: Number.POSITIVE_INFINITY }),
		);

		// The run comes back — the notice must not outlive the condition.
		stream.push('data: {"type":"TEXT_MESSAGE_CONTENT","delta":"here"}\n');
		stream.close();
		await vi.advanceTimersByTimeAsync(50);

		expect(toast.success).toHaveBeenCalledWith(
			"The assistant is responding again",
			expect.anything(),
		);
	});

	it("stays quiet for a run that keeps streaming past the threshold", async () => {
		// The failure this guards: a duration cap instead of a silence gap would
		// fire here, on a perfectly healthy long run.
		vi.useFakeTimers();
		const stream = pendingSseResponse();
		window.fetch = vi.fn(
			() => stream.response,
		) as unknown as typeof window.fetch;
		render(<CopilotFetchErrorInterceptor />);
		await window.fetch("/api/copilotkit", { method: "POST" });

		for (let i = 0; i < 4; i++) {
			await vi.advanceTimersByTimeAsync(STREAM_SILENCE_MS - 5_000);
			stream.push(
				`data: {"type":"TEXT_MESSAGE_CONTENT","delta":"chunk ${i}"}\n`,
			);
		}
		await vi.advanceTimersByTimeAsync(1_000);

		expect(toast.error).not.toHaveBeenCalled();
	});
});

/**
 * "An administrator needs to top it up" is an instruction. Without somewhere to
 * go it is only half of one — the gap an independent review called out, and the
 * reason `useLimitToast` has carried a billing CTA for this same condition all
 * along.
 */
describe("the out-of-credit toast offers somewhere to go", () => {
	it("attaches a Billing settings action for an out-of-credit failure", async () => {
		await fireAt(
			"/api/copilotkit",
			() =>
				new Response(
					JSON.stringify({
						error: "Your credit balance is too low to run this request.",
					}),
					{
						status: 402,
						headers: { "Content-Type": "application/json" },
					},
				),
		);

		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(toast.error).toHaveBeenCalledWith(
			"AI provider out of credit",
			expect.objectContaining({
				action: expect.objectContaining({ label: "Billing settings" }),
			}),
		);
	});

	it("attaches no action to a failure that billing cannot fix", async () => {
		// A 500 is not something a top-up resolves; offering the button there
		// would be a wrong turn dressed as help.
		await fireAt(
			"/api/copilotkit",
			() => new Response(null, { status: 500 }),
		);

		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		const [, opts] = (toast.error as unknown as ReturnType<typeof vi.fn>)
			.mock.calls[0] as [string, { action?: unknown }];
		expect(opts.action).toBeUndefined();
	});
});

// Fizzy #2770: every ChatGPT plan serving the member is spent. That is not
// rate limiting — retrying sooner cannot help — so it must never read as
// "AI service is busy" nor arm the client-side backoff.
describe("every ChatGPT plan for the member's work is spent", () => {
	function planSpent(apiBillingOption: boolean): Response {
		return new Response(
			JSON.stringify({
				error: "Every ChatGPT plan this work may use has no usage left in this window.",
				code: "subscription_sharing_usage_limit_exceeded",
				resetAt: "2026-10-08T16:37:00.000Z",
				apiBillingOption,
			}),
			{ status: 429, headers: { "Content-Type": "application/json" } },
		);
	}

	type ToastOptions = {
		description?: string;
		action?: { label: string; onClick: () => void };
	};
	const toastCalls = () =>
		(toast.error as unknown as ReturnType<typeof vi.fn>).mock.calls as [
			string,
			ToastOptions,
		][];

	it("shows the plan state, not the rate-limit toast, and arms no backoff", async () => {
		const stub = vi.fn(() => planSpent(false));
		window.fetch = stub as unknown as typeof window.fetch;
		render(<CopilotFetchErrorInterceptor />);
		await window.fetch("/api/copilotkit", { method: "POST" });
		await window.fetch("/api/copilotkit", { method: "POST" });

		// Both reached the server: a backoff would have answered the second.
		expect(stub).toHaveBeenCalledTimes(2);
		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		const titles = toastCalls().map(([title]) => title);
		expect(titles).not.toContain("AI service is busy");
		expect(titles).not.toContain("Slowing down requests");
		const [title, opts] = toastCalls()[0];
		expect(title).toBe("The ChatGPT plan has no usage left");
		expect(opts.description).toMatch(
			/All ChatGPT plans for your work are spent until /,
		);
		expect(opts.action).toBeUndefined();
	});

	// The switch acts on the session's organization: offered only for a
	// refusal in the organization on screen, and it refreshes the plan status.
	function renderInOrganization(queryClient: QueryClient) {
		render(
			<QueryClientProvider client={queryClient}>
				<ActiveOrganizationContext.Provider
					value={
						{
							activeOrganization: {
								id: "org-1",
								slug: "example-org",
							},
							isOrganizationAdmin: false,
						} as never
					}
				>
					<CopilotFetchErrorInterceptor />
				</ActiveOrganizationContext.Provider>
			</QueryClientProvider>,
		);
	}

	it("offers the organization's API billing when the server says it helps", async () => {
		setOrganizationUse.mockResolvedValue({
			enabled: false,
			includeBackgroundJobs: false,
		});
		const queryClient = new QueryClient();
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		window.fetch = vi.fn(() =>
			planSpent(true),
		) as unknown as typeof window.fetch;
		renderInOrganization(queryClient);
		await window.fetch("/api/copilotkit?organizationId=org-1", {
			method: "POST",
		});

		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		const [, opts] = toastCalls()[0];
		expect(opts.action?.label).toBe("useOrganizationBilling");
		opts.action?.onClick();
		expect(setOrganizationUse).toHaveBeenCalledWith({ enabled: false });
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith(
				"usingOrganizationBilling",
			),
		);
		await waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: ["users", "chatgpt-plan", "status"],
			}),
		);
	});

	it("offers no switch for a refusal in another organization than the one on screen", async () => {
		window.fetch = vi.fn(() =>
			planSpent(true),
		) as unknown as typeof window.fetch;
		renderInOrganization(new QueryClient());
		await window.fetch("/api/copilotkit?organizationId=org-2", {
			method: "POST",
		});
		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(toastCalls()[0][1].action).toBeUndefined();
	});
});
