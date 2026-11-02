/**
 * Deep Research over the agent runtime: the AG-UI events the runtime's
 * deep-researcher engine sends (`runtime/research-translator.ts`,
 * `research-run-follow.ts`) must land in the same state the stream route's
 * chat keeps, and the runtime-only behaviour (a thread per run, reconnect
 * after the response window, the clarifying question as an interrupt and its
 * answer as a resume, stop, reopening a saved run) must hold.
 *
 * The transport is real (`@ag-ui/client`'s HTTP + SSE parsing); only `fetch`
 * is faked (`research-runtime-harness.ts`), answering each runtime route
 * with a scripted event stream. How a response that does not end with the
 * run is handled is in `useResearchRuntimeStream.failures.test.ts`.
 */

import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toastMock = vi.fn();
vi.mock("@saas/payments/lib/ai-usage-limit-toast", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/payments/lib/ai-usage-limit-toast")
	>()),
	useShowAiUsageLimitToast: () => toastMock,
}));

import {
	CONNECT_URL,
	EXECUTION,
	execution,
	finished,
	installRuntimeFetch,
	interrupt,
	liveSse,
	PROMPT,
	progress,
	QUESTION,
	RESULT,
	RUN_URL,
	reconnect,
	renderResearch,
	requests,
	runError,
	runIds,
	runtime,
	savedRun,
	sse,
	started,
} from "./research-runtime-harness";

installRuntimeFetch();

beforeEach(() => {
	toastMock.mockReset();
});

describe("useResearchRuntimeStream — a run", () => {
	it("sends a fresh thread with the question and the page's options, without organization, template or instance", async () => {
		runtime.respond = ({ body }) =>
			sse([
				started(body.threadId, body.runId),
				...execution(),
				progress(),
				finished(body.threadId, body.runId),
			]);
		const onConversationStarted = vi.fn();
		const { result } = renderResearch({
			reasoningEffort: "high",
			executionMode: "deep",
			maxSubAgents: 4,
			onConversationStarted,
		});

		await act(async () => {
			await result.current.sendQuery(QUESTION);
		});

		expect(requests.map((request) => request.url)).toEqual([RUN_URL]);
		const [run] = requests;
		expect(run?.headers).toMatchObject({
			"content-type": "application/json",
			accept: "text/event-stream",
			"x-fabric-organization-id": "org_example",
		});
		expect(run?.body.threadId).toMatch(/^[0-9a-f-]{36}$/);
		expect(run?.body.messages).toEqual([
			{ id: `${run?.body.runId}:user`, role: "user", content: QUESTION },
		]);
		expect(run?.body.forwardedProps).toEqual({
			reasoningEffort: "high",
			executionMode: "deep",
			maxSubAgents: 4,
		});
		expect(onConversationStarted).toHaveBeenCalledWith(run?.body.threadId);
		expect(result.current.query).toBe(QUESTION);
		expect(result.current.state).toMatchObject({
			executionId: EXECUTION,
			status: "completed",
			result: { text: RESULT.result, summary: RESULT.summary },
		});
		expect(result.current.hasResults).toBe(true);
		expect(result.current.resultRestored).toBe(false);
	});

	it("reconnects on the same thread when the window ends, then follows the run to its end", async () => {
		runtime.respond = ({ url, body }) => {
			if (url === RUN_URL) {
				return sse([
					started(body.threadId, body.runId),
					...execution(),
					progress(),
					reconnect(body.runId),
				]);
			}
			const { key } = runIds();
			return sse([
				{ type: "MESSAGES_SNAPSHOT", messages: [] },
				started(body.threadId, key),
				...execution(),
				finished(body.threadId, key),
			]);
		};
		const { result } = renderResearch();

		await act(async () => {
			await result.current.sendQuery(QUESTION);
		});

		expect(requests.map((request) => request.url)).toEqual([
			RUN_URL,
			CONNECT_URL,
		]);
		expect(requests[1]?.body.threadId).toBe(runIds().threadId);
		expect(result.current.state.status).toBe("completed");
		expect(result.current.isComplete).toBe(true);
	});

	it("a blank question, or a second one while a run goes, sends nothing and leaves the live run alone", async () => {
		const { result } = renderResearch();

		let blankBefore: string | null | undefined;
		await act(async () => {
			blankBefore = await result.current.sendQuery("   ");
		});
		expect(blankBefore).toBeNull();
		expect(requests).toEqual([]);

		const live = liveSse();
		runtime.respond = () => live.response;
		let first: Promise<string | null> | undefined;
		await act(async () => {
			first = result.current.sendQuery(QUESTION);
		});
		const { threadId, key } = runIds();
		await act(async () => {
			live.push(started(threadId, key), ...execution(), progress());
		});
		await waitFor(() =>
			expect(result.current.state.executionId).toBe(EXECUTION),
		);
		expect(result.current.state.status).toBe("running");

		let second: string | null | undefined;
		let blank: string | null | undefined;
		await act(async () => {
			second = await result.current.sendQuery("Another question");
			blank = await result.current.sendQuery("   ");
		});

		expect(second).toBeNull();
		expect(blank).toBeNull();
		expect(requests.map((request) => request.url)).toEqual([RUN_URL]);
		expect(requests[0]?.signal?.aborted).toBe(false);
		expect(result.current.query).toBe(QUESTION);
		expect(result.current.state.status).toBe("running");

		await act(async () => {
			live.push(finished(threadId, key));
			live.close();
			await first;
		});
		expect(result.current.state.status).toBe("completed");
	});
});

describe("useResearchRuntimeStream — the clarifying question", () => {
	const later = () => new Date(Date.now() + 5 * 60_000).toISOString();

	async function askedQuestion(expiresAt = later()) {
		runtime.respond = ({ body }) =>
			sse([
				started(body.threadId, body.runId),
				...execution(),
				progress({
					phase: "awaiting_clarification",
					clarificationPrompt: PROMPT,
				}),
				interrupt(body.threadId, body.runId, body.runId, expiresAt),
			]);
		const rendered = renderResearch();
		await act(async () => {
			await rendered.result.current.sendQuery(QUESTION);
		});
		return rendered;
	}

	it("keeps the run loading while its question waits, and answers it with a resume", async () => {
		const { result } = await askedQuestion();
		const { threadId, key } = runIds();

		expect(result.current.state.phase).toBe("awaiting_clarification");
		expect(result.current.state.progress.clarificationPrompt).toBe(PROMPT);
		expect(result.current.isLoading).toBe(true);

		runtime.respond = ({ body }) =>
			sse([
				started(body.threadId, body.runId),
				...execution(),
				{
					type: "CUSTOM",
					name: "fabric.deep-researcher.clarification-accepted",
					value: { interruptId: `${key}:clarification` },
				},
				finished(body.threadId, body.runId),
			]);
		let accepted: boolean | undefined;
		await act(async () => {
			accepted =
				await result.current.sendClarificationResponse("  Europe  ");
		});

		expect(accepted).toBe(true);
		const resume = requests.at(-1);
		expect(resume?.url).toBe(RUN_URL);
		expect(resume?.body.threadId).toBe(threadId);
		expect(resume?.body.messages).toEqual([]);
		expect(resume?.body.resume).toEqual([
			{
				interruptId: `${key}:clarification`,
				status: "resolved",
				payload: { response: "Europe" },
			},
		]);
		expect(result.current.state.message).toBe(
			"Clarification received. Continuing research...",
		);
		expect(result.current.state.status).toBe("completed");
	});

	it("an answer the runtime refuses as INTERRUPT_NOT_PENDING returns false and connects", async () => {
		const { result } = await askedQuestion();
		const { threadId } = runIds();
		runtime.respond = ({ url, body }) =>
			url === RUN_URL
				? sse([
						runError(
							"INTERRUPT_NOT_PENDING",
							"This question is no longer pending.",
						),
					])
				: sse([
						{ type: "MESSAGES_SNAPSHOT", messages: [] },
						started(body.threadId, "run-key"),
						finished(body.threadId, "run-key"),
					]);

		let accepted: boolean | undefined;
		await act(async () => {
			accepted = await result.current.sendClarificationResponse("Europe");
		});

		expect(accepted).toBe(false);
		await waitFor(() => expect(requests.at(-1)?.url).toBe(CONNECT_URL));
		expect(requests.at(-1)?.body.threadId).toBe(threadId);
		expect(result.current.state.error).toBeNull();
		await waitFor(() =>
			expect(result.current.state.status).toBe("completed"),
		);
	});

	it("looks again once an unanswered question's window has passed", async () => {
		await askedQuestion(new Date(Date.now() - 60_000).toISOString());
		runtime.respond = ({ body }) =>
			sse([
				{ type: "MESSAGES_SNAPSHOT", messages: [] },
				started(body.threadId, "run-key"),
				finished(body.threadId, "run-key"),
			]);

		await waitFor(() => expect(requests.at(-1)?.url).toBe(CONNECT_URL), {
			timeout: 5_000,
		});
	});

	it("a question the run keeps asking past its window is looked at again only a bounded number of times", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const past = new Date(Date.now() - 60_000).toISOString();
			await askedQuestion(past);
			const { key } = runIds();
			runtime.respond = ({ body }) =>
				sse([
					{ type: "MESSAGES_SNAPSHOT", messages: [] },
					started(body.threadId, key),
					interrupt(body.threadId, key, key, past),
				]);
			const connects = () =>
				requests.filter((request) => request.url === CONNECT_URL)
					.length;

			// Each look is due 2 s after the window; run well past the cap.
			for (let tick = 0; tick < 12; tick++) {
				await act(async () => {
					await vi.advanceTimersByTimeAsync(2_000);
				});
			}

			// The first look, then three re-arms.
			expect(connects()).toBe(4);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a stop while the question waits posts the stop, then one stopped connect that changes nothing shown and is let go after 5 s", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const { result } = await askedQuestion();
			const { threadId, key } = runIds();
			const live = liveSse();
			runtime.respond = ({ url }) =>
				url === CONNECT_URL
					? live.response
					: new Response(JSON.stringify({ stopped: true }), {
							status: 200,
						});

			await act(async () => {
				await result.current.cancel();
			});
			await act(async () => {
				live.push(
					started(threadId, key),
					progress({ subAgentsCompleted: 2 }),
				);
			});

			expect(requests).toHaveLength(3);
			const [stop, settle] = requests.slice(1);
			expect(stop?.url).toBe(
				`/api/agents/runtime/agent/deep-researcher/stop/${threadId}`,
			);
			expect(stop?.body).toEqual({ runId: key });
			expect(settle).toMatchObject({
				url: CONNECT_URL,
				body: { threadId },
			});
			expect(result.current.state).toMatchObject({
				status: "cancelled",
				phase: "cancelled",
			});
			expect(result.current.state.progress.subAgentsCompleted).toBe(1);
			expect(settle?.signal?.aborted).toBe(false);

			await act(async () => {
				vi.advanceTimersByTime(5_000);
			});
			expect(settle?.signal?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("useResearchRuntimeStream — stop and reset", () => {
	it("cancel shows the run stopped at once and posts the stop with the run's key", async () => {
		const live = liveSse();
		runtime.respond = ({ url }) =>
			url === RUN_URL
				? live.response
				: new Response(JSON.stringify({ stopped: true }), {
						status: 200,
					});
		const { result } = renderResearch();

		act(() => {
			void result.current.sendQuery(QUESTION);
		});
		await waitFor(() => expect(requests[0]?.url).toBe(RUN_URL));
		const { threadId, key } = runIds();
		await act(async () => {
			live.push(started(threadId, key), ...execution(), progress());
		});
		expect(result.current.isLoading).toBe(true);

		await act(async () => {
			await result.current.cancel();
		});

		expect(result.current.state.status).toBe("cancelled");
		expect(result.current.isLoading).toBe(false);
		const stop = requests.find((request) => request.url.includes("/stop/"));
		expect(stop?.url).toBe(
			`/api/agents/runtime/agent/deep-researcher/stop/${threadId}`,
		);
		expect(stop?.body).toEqual({ runId: key });

		await act(async () => {
			live.push(
				progress({ subAgentsCompleted: 2 }),
				finished(threadId, key, { type: "cancelled" }),
			);
			live.close();
		});
		expect(result.current.state).toMatchObject({
			status: "cancelled",
			error: null,
		});
		expect(result.current.state.progress.subAgentsCompleted).toBe(1);
	});

	it("a stop on a reopened conversation names the run its connect reported", async () => {
		const live = liveSse();
		runtime.respond = ({ url }) =>
			url === CONNECT_URL
				? live.response
				: new Response(JSON.stringify({ stopped: true }), {
						status: 200,
					});
		const { result } = renderResearch({ conversationId: "conversation-c" });
		await waitFor(() => expect(requests[0]?.url).toBe(CONNECT_URL));
		await act(async () => {
			live.push(
				{ type: "MESSAGES_SNAPSHOT", messages: [] },
				started("conversation-c", "run-c", "Live one"),
				...execution(),
				progress(),
			);
		});
		await waitFor(() => expect(result.current.isLoading).toBe(true));

		await act(async () => {
			await result.current.cancel();
		});

		const stop = requests.find((request) => request.url.includes("/stop/"));
		expect(stop?.url).toBe(
			"/api/agents/runtime/agent/deep-researcher/stop/conversation-c",
		);
		expect(stop?.body).toEqual({ runId: "run-c" });
		expect(result.current.state.status).toBe("cancelled");
	});

	it("a stop before any response named the run sends no run id, so the runtime stops the thread's live run", async () => {
		const live = liveSse();
		runtime.respond = ({ url }) =>
			url === CONNECT_URL
				? live.response
				: new Response(JSON.stringify({ stopped: true }), {
						status: 200,
					});
		const { result } = renderResearch({ conversationId: "conversation-c" });
		await waitFor(() => expect(requests[0]?.url).toBe(CONNECT_URL));

		await act(async () => {
			await result.current.cancel();
		});

		const stop = requests.find((request) => request.url.includes("/stop/"));
		expect(stop?.body).toEqual({});
	});

	it.each([
		[
			"answers stopped: false",
			() =>
				new Response(
					JSON.stringify({
						stopped: false,
						message: "No active run",
					}),
					{ status: 200 },
				),
		],
		[
			"refuses",
			() =>
				new Response(
					JSON.stringify({ error: "Invalid stop request" }),
					{
						status: 400,
					},
				),
		],
	])(
		"a stop the runtime %s shows the run again, follows it on a fresh connect, and calls onStopFailed",
		async (_, stopResponse) => {
			const run = liveSse();
			const reattach = liveSse();
			runtime.respond = ({ url }) => {
				if (url === RUN_URL) {
					return run.response;
				}
				return url === CONNECT_URL ? reattach.response : stopResponse();
			};
			const onStopFailed = vi.fn();
			const { result } = renderResearch({ onStopFailed });
			act(() => {
				void result.current.sendQuery(QUESTION);
			});
			await waitFor(() => expect(requests[0]?.url).toBe(RUN_URL));
			const { threadId, key } = runIds();
			await act(async () => {
				run.push(started(threadId, key), ...execution(), progress());
			});

			await act(async () => {
				await result.current.cancel();
			});

			expect(onStopFailed).toHaveBeenCalledTimes(1);
			expect(result.current.state.status).toBe("running");
			expect(result.current.isLoading).toBe(true);
			expect(requests[0]?.signal?.aborted).toBe(true);
			await waitFor(() =>
				expect(requests.at(-1)).toMatchObject({
					url: CONNECT_URL,
					body: { threadId },
				}),
			);
			await act(async () => {
				reattach.push(
					{ type: "MESSAGES_SNAPSHOT", messages: [] },
					started(threadId, key),
					progress({ subAgentsCompleted: 2 }),
					finished(threadId, key),
				);
				reattach.close();
			});
			await waitFor(() =>
				expect(result.current.state.status).toBe("completed"),
			);
			expect(result.current.state.progress.subAgentsCompleted).toBe(2);
		},
	);

	it("reset lets the run go without stopping it", async () => {
		const live = liveSse();
		runtime.respond = () => live.response;
		const { result } = renderResearch();

		act(() => {
			void result.current.sendQuery(QUESTION);
		});
		await waitFor(() => expect(requests[0]?.url).toBe(RUN_URL));
		const { threadId, key } = runIds();
		await act(async () => {
			live.push(started(threadId, key));
		});

		act(() => {
			result.current.reset();
		});

		expect(requests.some((request) => request.url.includes("/stop/"))).toBe(
			false,
		);
		expect(requests[0]?.signal?.aborted).toBe(true);
		expect(result.current.state.status).toBe("idle");
		expect(result.current.query).toBe("");
	});
});

describe("useResearchRuntimeStream — opening a conversation", () => {
	it("a reopened conversation's saved result is shown as restored, with its own question", async () => {
		runtime.respond = ({ url, body }) =>
			url === RUN_URL
				? sse([
						started(body.threadId, body.runId),
						finished(body.threadId, body.runId),
					])
				: sse([savedRun("run-b", "What about pricing?")]);
		const { result, rerender } = renderResearch();

		await act(async () => {
			await result.current.sendQuery(QUESTION);
		});
		expect(result.current.query).toBe(QUESTION);

		rerender({
			templateSlug: "deep-researcher",
			organizationId: "org_example",
			conversationId: "conversation-b",
		});

		await waitFor(() => expect(result.current.resultRestored).toBe(true));
		expect(requests.at(-1)).toMatchObject({
			url: CONNECT_URL,
			body: { threadId: "conversation-b" },
		});
		expect(result.current.query).toBe("What about pricing?");
		expect(result.current.state).toMatchObject({
			status: "completed",
			executionId: "wf-saved",
			result: { text: RESULT.result },
		});
	});

	it("a conversation whose run still goes is followed, and loading", async () => {
		const live = liveSse();
		runtime.respond = () => live.response;
		const { result } = renderResearch({ conversationId: "conversation-c" });

		await waitFor(() => expect(requests[0]?.url).toBe(CONNECT_URL));
		await act(async () => {
			live.push(
				{
					type: "MESSAGES_SNAPSHOT",
					messages: [
						{ id: "run-c:user", role: "user", content: "Live one" },
					],
				},
				started("conversation-c", "run-c", "Live one"),
				...execution(),
				progress(),
			);
		});

		await waitFor(() => expect(result.current.isLoading).toBe(true));
		expect(result.current.query).toBe("Live one");
		expect(result.current.resultRestored).toBe(false);
		await act(async () => {
			live.push(finished("conversation-c", "run-c"));
			live.close();
		});
	});

	it("the hook's own thread passed back as conversationId neither aborts the live response nor connects, and resultRestored stays false", async () => {
		const live = liveSse();
		runtime.respond = () => live.response;
		const { result, rerender } = renderResearch();

		act(() => {
			void result.current.sendQuery(QUESTION);
		});
		await waitFor(() => expect(requests[0]?.url).toBe(RUN_URL));
		const { threadId, key } = runIds();
		await act(async () => {
			live.push(started(threadId, key), ...execution());
		});

		rerender({
			templateSlug: "deep-researcher",
			organizationId: "org_example",
			conversationId: threadId,
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.signal?.aborted).toBe(false);
		await act(async () => {
			live.push(finished(threadId, key));
			live.close();
		});
		await waitFor(() =>
			expect(result.current.state.status).toBe("completed"),
		);
		expect(result.current.resultRestored).toBe(false);
	});
});

describe("useResearchRuntimeStream — stable identity", () => {
	it("reset, sendQuery and cancel keep their identity across rerenders with new options and across a run", async () => {
		runtime.respond = ({ body }) =>
			sse([
				started(body.threadId, body.runId),
				finished(body.threadId, body.runId),
			]);
		const { result, rerender } = renderResearch();
		const first = result.current;

		rerender({
			templateSlug: "deep-researcher",
			organizationId: "org_example",
			reasoningEffort: "light",
			maxSubAgents: 2,
		});
		await act(async () => {
			await result.current.sendQuery(QUESTION);
		});

		expect(result.current.reset).toBe(first.reset);
		expect(result.current.sendQuery).toBe(first.sendQuery);
		expect(result.current.cancel).toBe(first.cancel);
		expect(requests[0]?.body.forwardedProps).toMatchObject({
			reasoningEffort: "light",
			maxSubAgents: 2,
		});
	});

	it("rerendering with new options while a run starts does not abort it", async () => {
		const live = liveSse();
		runtime.respond = () => live.response;
		const { result, rerender } = renderResearch();

		act(() => {
			void result.current.sendQuery(QUESTION);
		});
		await waitFor(() => expect(requests[0]?.url).toBe(RUN_URL));
		rerender({
			templateSlug: "deep-researcher",
			organizationId: "org_example",
			reasoningEffort: "high",
		});

		expect(requests[0]?.signal?.aborted).toBe(false);
		const { threadId, key } = runIds();
		await act(async () => {
			live.push(started(threadId, key), finished(threadId, key));
			live.close();
		});
		await waitFor(() =>
			expect(result.current.state.status).toBe("completed"),
		);
	});
});
