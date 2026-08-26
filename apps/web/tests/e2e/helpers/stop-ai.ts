/**
 * Helpers for the Stop / Cancel AI generation E2E specs.
 *
 * Spec: `specs/2026-05-09-stop-ai-generation/spec.md`
 *
 * The four `stop-ai-*.spec.ts` files share the same broad needs:
 *
 *  1. Establish a streaming AI turn that takes long enough that the user can
 *     reasonably click Stop while the response is still in-flight.
 *  2. Capture the partial assistant message + the visible `Stopped` caption
 *     across all four surfaces (Nexus, Launcher, Loom Direct, Loom
 *     Orchestrator).
 *  3. Mock the cancel endpoint when the test wants to exercise the
 *     `chat.stopFailed.toast` path (Task 6.3 / AC-4 / AC-10).
 *
 * Playwright's `Route.fulfill()` can only deliver a complete body — it does
 * not stream chunks one at a time. Sending a buffered SSE response would
 * hand the client every event in a single tick, which is too fast to ever
 * exercise the freeze gate or to reliably click Stop "mid-stream".
 *
 * We work around that by overriding `window.fetch` inside the page via
 * `page.addInitScript`. The override produces a real `Response` whose body
 * is a `ReadableStream<Uint8Array>` that emits each SSE event with a
 * configurable delay between chunks. That gives the test precise control
 * over when the `started` event lands (so `executionIdRef.current` is
 * populated before Stop is clicked, which is required for the cancel POST
 * to fire and for the AC-10 toast test to mean anything).
 *
 * Selectors prefer roles + accessible names per
 * `fabric/standards/frontend/accessibility.md`.
 */

import { type Locator, type Page, expect } from "@playwright/test";

type StopAiSurface = "fabric-ai-stream" | "orchestrator-temporal-stream";

export interface InstallSlowStreamOptions {
	/**
	 * Which streaming endpoint to mock. The direct-chat path (used by
	 * Launcher + Loom Direct + Nexus per-agent) talks to
	 * `/api/agents/fabric-ai/stream`; the orchestrator + multi-agent path
	 * (Loom Orchestrator + Nexus aggregate) talks to
	 * `/api/agents/fabric-ai/orchestrator-temporal/stream`.
	 */
	endpoint: StopAiSurface;
	/**
	 * Workflow id prefix. Direct-chat workflows use `direct-chat-<uuid>`;
	 * orchestrator workflows use `orch-<uuid>`. The cancel route validates
	 * the prefix, so this MUST match the surface.
	 */
	executionIdPrefix: "direct-chat-" | "orch-";
	/**
	 * Optional: emit an `approval_required` event so the orchestrator
	 * surface enters `pendingApproval`. Used by `stop-ai-loom-orchestrator`
	 * to assert AC-9 (Stop is visible while paused on approval).
	 */
	emitApprovalRequired?: boolean;
	/**
	 * Optional: artificial delay (ms) BEFORE emitting the `started` event.
	 * Defaults to 0 so the client captures `executionIdRef` quickly and the
	 * user has the executionId available when they click Stop.
	 */
	preStartedDelayMs?: number;
	/**
	 * Optional: delay between SSE events. Increase if the test needs more
	 * time before clicking Stop. Defaults to 800ms — long enough that the
	 * user reliably clicks Stop after at least one text delta has rendered.
	 */
	betweenEventsDelayMs?: number;
}

/**
 * Install a deterministic "slow SSE" override on `window.fetch` for the
 * given streaming endpoint. After this is installed, every fetch to the
 * matching endpoint inside the page returns a Response whose body emits a
 * `started` event, a few `text` deltas, and (only if the consumer waits
 * long enough to receive it) a `completed` event.
 *
 * Critically, the helper does NOT emit `completed` for at least 30
 * seconds. The intent is that every Stop test fires the click WAY before
 * the natural completion, so the partial + Stopped label are stable.
 */
export async function installSlowStream(
	page: Page,
	options: InstallSlowStreamOptions,
): Promise<void> {
	const {
		endpoint,
		executionIdPrefix,
		emitApprovalRequired = false,
		preStartedDelayMs = 0,
		betweenEventsDelayMs = 800,
	} = options;

	// Deterministic execution id. Lowercase hex + dashes, total 36 chars
	// after the prefix, matches the regex used by both cancel routes.
	const executionId = `${executionIdPrefix}aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;

	const endpointPath =
		endpoint === "fabric-ai-stream"
			? "/api/agents/fabric-ai/stream"
			: "/api/agents/fabric-ai/orchestrator-temporal/stream";

	// Direct-chat hook handles `type: "text"` only. Orchestrator hook
	// handles `type: "text_delta"` only. Multi-agent (Nexus) handles
	// either (both cases share the same handler). The `textEventType`
	// below is chosen so each consumer sees exactly one append per delta.
	const textEventType =
		endpoint === "fabric-ai-stream" ? "text" : "text_delta";

	await page.addInitScript(
		({
			path,
			executionId: scriptExecutionId,
			emitApproval,
			preStartedDelayMs: scriptPreStartedDelayMs,
			betweenEventsDelayMs: scriptBetweenEventsDelayMs,
			textEventType: scriptTextEventType,
		}: {
			path: string;
			executionId: string;
			emitApproval: boolean;
			preStartedDelayMs: number;
			betweenEventsDelayMs: number;
			textEventType: string;
		}) => {
			const realFetch = window.fetch.bind(window);

			window.fetch = (
				input: RequestInfo | URL,
				init?: RequestInit,
			): Promise<Response> => {
				const requestUrl =
					typeof input === "string"
						? input
						: input instanceof URL
							? input.toString()
							: input.url;

				if (!requestUrl.includes(path)) {
					return realFetch(input, init);
				}

				const sleep = (ms: number) =>
					new Promise<void>((resolve) => {
						setTimeout(resolve, ms);
					});

				const encoder = new TextEncoder();
				const sendEvent = (
					controller: ReadableStreamDefaultController<Uint8Array>,
					event: Record<string, unknown>,
				) => {
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
					);
				};

				const aborted = new Promise<void>((resolve) => {
					if (!init?.signal) {
						return;
					}
					if (init.signal.aborted) {
						resolve();
						return;
					}
					init.signal.addEventListener("abort", () => resolve(), {
						once: true,
					});
				});

				const stream = new ReadableStream<Uint8Array>({
					async start(controller) {
						let cancelled = false;
						const cancelOnAbort = aborted.then(() => {
							cancelled = true;
							try {
								controller.close();
							} catch {
								/* already closed */
							}
						});

						try {
							if (scriptPreStartedDelayMs > 0) {
								await Promise.race([
									sleep(scriptPreStartedDelayMs),
									aborted,
								]);
								if (cancelled) {
									return;
								}
							}

							sendEvent(controller, {
								type: "started",
								executionId: scriptExecutionId,
								workflowId: scriptExecutionId,
							});

							// A few text deltas so the assistant message has
							// visible partial content the test can assert on.
							const deltas = [
								"Working on it. ",
								"This is a deliberately slow ",
								"response so the test ",
								"can click Stop mid-stream. ",
							];
							for (const delta of deltas) {
								await Promise.race([
									sleep(scriptBetweenEventsDelayMs),
									aborted,
								]);
								if (cancelled) {
									return;
								}
								sendEvent(controller, {
									type: scriptTextEventType,
									content: delta,
								});
							}

							if (emitApproval) {
								await Promise.race([
									sleep(scriptBetweenEventsDelayMs),
									aborted,
								]);
								if (cancelled) {
									return;
								}
								sendEvent(controller, {
									type: "approval_required",
									approvalId: "approval-test-1",
									stepId: "step-test-1",
									reason: "Test approval pause for AC-9",
								});
							}

							// Hold the connection open for 30 seconds. By
							// then the test is long over. If the test never
							// clicks Stop (failure case), `done=true` will
							// resolve the message to `completed` and the
							// assertions will fail — that's correct.
							await Promise.race([sleep(30_000), aborted]);
						} finally {
							void cancelOnAbort;
							if (!cancelled) {
								try {
									controller.close();
								} catch {
									/* already closed */
								}
							}
						}
					},
				});

				return Promise.resolve(
					new Response(stream, {
						status: 200,
						headers: {
							"Content-Type": "text/event-stream",
							"Cache-Control": "no-cache",
						},
					}),
				);
			};
		},
		{
			path: endpointPath,
			executionId,
			emitApproval: emitApprovalRequired,
			preStartedDelayMs,
			betweenEventsDelayMs,
			textEventType,
		},
	);
}

/**
 * Wait for the Stop button (the morphed Send -> Stop control) to be visible.
 *
 * All four surfaces label the Stop control with `aria-label="Stop generating"`
 * (spec § 4.3 / Task 4.1 audit). We use the role + accessible name selector
 * so the helper is surface-agnostic.
 */
export function getStopButton(page: Page): Locator {
	return page.getByRole("button", { name: "Stop generating" });
}

/**
 * Wait for the inline `Stopped` caption to appear. Spec § 4.2 / 8.9 — the
 * caption is rendered as a `text-xs uppercase tracking-[0.15em]` span when
 * `streamStatus === "cancelled"` (or when the agent's
 * `AgentResponse.status === "cancelled"`).
 *
 * We assert by visible text rather than testid so the helper covers the
 * Direct chat, Orchestrator chat, and Nexus per-agent renderers without
 * coupling to internal implementation.
 */
export function getStoppedCaption(page: Page): Locator {
	return page.getByText("Stopped", { exact: true }).first();
}

/**
 * Assert that input is unblocked after Stop. Per AC-3, the user must be
 * able to submit a new prompt immediately — the input must be enabled
 * (not disabled) and the Send branch must be back in place (Stop button
 * gone).
 */
export async function expectInputUnblocked(page: Page): Promise<void> {
	// Stop button is gone — Send branch is back.
	await expect(getStopButton(page)).toHaveCount(0, { timeout: 5_000 });
}
