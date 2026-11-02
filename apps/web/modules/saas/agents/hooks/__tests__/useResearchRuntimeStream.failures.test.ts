/**
 * Deep Research over the agent runtime, when a response does not end with
 * the run: a refusal or a failed request shows its error; the usage limit
 * shows its toast; a dropped connection, or an error that could not confirm
 * the run's start or state, connects again (a bounded number of times)
 * while the run goes on, and stays stoppable.
 *
 * The transport is real (`@ag-ui/client`'s HTTP + SSE parsing); only `fetch`
 * is faked (`research-runtime-harness.ts`).
 */

import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastMock = vi.fn();
vi.mock("@saas/payments/lib/ai-usage-limit-toast", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/payments/lib/ai-usage-limit-toast")
	>()),
	useShowAiUsageLimitToast: () => toastMock,
}));

import {
	CONNECT_URL,
	execution,
	finished,
	installRuntimeFetch,
	progress,
	QUESTION,
	RUN_URL,
	reconnect,
	renderResearch,
	requests,
	runError,
	runIds,
	runtime,
	sse,
	started,
} from "./research-runtime-harness";

installRuntimeFetch();

beforeEach(() => {
	toastMock.mockReset();
});

describe("useResearchRuntimeStream — failures", () => {
	it("a 403 run response shows its message and makes no connect", async () => {
		runtime.respond = () =>
			new Response(
				JSON.stringify({
					error: "Forbidden",
					message: "This thread is not accessible.",
				}),
				{
					status: 403,
					headers: { "Content-Type": "application/json" },
				},
			);
		const { result } = renderResearch();

		await act(async () => {
			await result.current.sendQuery(QUESTION);
		});

		expect(result.current.state).toMatchObject({
			status: "failed",
			error: "This thread is not accessible.",
		});
		expect(requests.map((request) => request.url)).toEqual([RUN_URL]);
	});

	it("a run the runtime refuses shows the refusal", async () => {
		runtime.respond = () =>
			sse([
				runError(
					"FEATURE_DISABLED",
					"Deep Research is not enabled on the agent runtime for this organization.",
				),
			]);
		const { result } = renderResearch();

		await act(async () => {
			await result.current.sendQuery(QUESTION);
		});

		expect(result.current.state).toMatchObject({
			status: "failed",
			error: "Deep Research is not enabled on the agent runtime for this organization.",
		});
		expect(requests.map((request) => request.url)).toEqual([RUN_URL]);
	});

	it("a run the AI usage limit refuses shows the limit's toast once and returns to idle with no error and no connect", async () => {
		const limit = {
			limitId: "limit-example",
			dimension: "TOKENS",
			window: "DAILY",
			used: "10",
			max: "5",
			manageLimitsUrl: "",
		};
		runtime.respond = ({ body }) =>
			sse([
				started(body.threadId, body.runId),
				{
					type: "RUN_ERROR",
					code: "AI_USAGE_LIMIT_EXCEEDED",
					message: "AI usage limit exceeded",
					metadata: {
						fabric: {
							code: "AI_USAGE_LIMIT_EXCEEDED",
							data: limit,
						},
					},
				},
			]);
		const { result } = renderResearch();

		await act(async () => {
			await result.current.sendQuery(QUESTION);
		});

		expect(toastMock).toHaveBeenCalledTimes(1);
		expect(toastMock).toHaveBeenCalledWith(limit);
		expect(result.current.state).toMatchObject({
			status: "idle",
			error: null,
		});
		expect(requests.map((request) => request.url)).toEqual([RUN_URL]);
	});

	it("a network drop reconnects", async () => {
		runtime.respond = ({ url, body }) => {
			if (url === RUN_URL) {
				throw new TypeError("Failed to fetch");
			}
			return sse([
				{ type: "MESSAGES_SNAPSHOT", messages: [] },
				started(body.threadId, "run-key"),
				finished(body.threadId, "run-key"),
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
		expect(result.current.state.status).toBe("completed");
	});

	describe("an error that could not confirm the run, which goes on", () => {
		const UNAVAILABLE =
			"Could not confirm the thread's running turn. Please retry.";

		beforeEach(() => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		/** Let the fake clock run, the responses it opens read meanwhile. */
		async function elapse(ms: number) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(ms);
			});
		}

		/** Send the question without waiting for the session to end. */
		async function send(
			result: ReturnType<typeof renderResearch>["result"],
		) {
			await act(async () => {
				void result.current.sendQuery(QUESTION);
			});
			await elapse(0);
		}

		const followedToTheEnd = (threadId: string, key: string) =>
			sse([
				{ type: "MESSAGES_SNAPSHOT", messages: [] },
				started(threadId, key),
				...execution(),
				finished(threadId, key),
			]);

		it("a connect refused TURN_STATE_UNAVAILABLE keeps the run going and stoppable, and connects again after a wait", async () => {
			let connects = 0;
			runtime.respond = ({ url, body }) => {
				if (url === RUN_URL) {
					return sse([
						started(body.threadId, body.runId),
						...execution(),
						progress(),
						reconnect(body.runId),
					]);
				}
				connects += 1;
				return connects === 1
					? sse([runError("TURN_STATE_UNAVAILABLE", UNAVAILABLE)])
					: followedToTheEnd(body.threadId, runIds().key);
			};
			const { result } = renderResearch();

			await send(result);

			expect(requests.map((request) => request.url)).toEqual([
				RUN_URL,
				CONNECT_URL,
			]);
			expect(result.current.state).toMatchObject({
				status: "running",
				error: null,
			});
			expect(result.current.isLoading).toBe(true);

			await elapse(2_000);

			expect(requests.map((request) => request.url)).toEqual([
				RUN_URL,
				CONNECT_URL,
				CONNECT_URL,
			]);
			expect(result.current.state.status).toBe("completed");
		});

		it("a send refused TURN_START_UNCONFIRMED opens its conversation and follows it with a connect", async () => {
			const onConversationStarted = vi.fn();
			runtime.respond = ({ url, body }) =>
				url === RUN_URL
					? sse([
							runError(
								"TURN_START_UNCONFIRMED",
								"The run's start could not be confirmed; reconnect to check it.",
							),
						])
					: followedToTheEnd(body.threadId, runIds().key);
			const { result } = renderResearch({ onConversationStarted });

			await send(result);

			const { threadId } = runIds();
			expect(onConversationStarted).toHaveBeenCalledTimes(1);
			expect(onConversationStarted).toHaveBeenCalledWith(threadId);
			expect(result.current.state).toMatchObject({
				status: "running",
				error: null,
			});

			await elapse(2_000);

			expect(requests.map((request) => request.url)).toEqual([
				RUN_URL,
				CONNECT_URL,
			]);
			expect(requests[1]?.body.threadId).toBe(threadId);
			expect(result.current.state.status).toBe("completed");
			expect(onConversationStarted).toHaveBeenCalledTimes(1);
		});

		it("an error with no code after the run showed live connects again; one before it fails the run", async () => {
			let connects = 0;
			runtime.respond = ({ url, body }) => {
				if (url === RUN_URL) {
					return sse([
						started(body.threadId, body.runId),
						{ type: "RUN_ERROR", message: "Agent run failed" },
					]);
				}
				connects += 1;
				return followedToTheEnd(body.threadId, runIds().key);
			};
			const { result } = renderResearch();

			await send(result);
			expect(result.current.state.status).toBe("running");
			await elapse(2_000);

			expect(connects).toBe(1);
			expect(result.current.state.status).toBe("completed");

			requests.length = 0;
			runtime.respond = () =>
				sse([{ type: "RUN_ERROR", message: "Agent run failed" }]);
			await send(result);

			expect(requests.map((request) => request.url)).toEqual([RUN_URL]);
			expect(result.current.state).toMatchObject({
				status: "failed",
				error: "Agent run failed",
			});
		});

		it("the chat stops looking again after a bounded number of waits and shows the error", async () => {
			runtime.respond = ({ url, body }) =>
				url === RUN_URL
					? sse([
							started(body.threadId, body.runId),
							reconnect(body.runId),
						])
					: sse([runError("TURN_STATE_UNAVAILABLE", UNAVAILABLE)]);
			const { result } = renderResearch();

			await send(result);
			for (let tick = 0; tick < 20; tick++) {
				await elapse(2_000);
			}

			// The first connect, then fifteen more after a wait each.
			expect(
				requests.filter((request) => request.url === CONNECT_URL),
			).toHaveLength(16);
			expect(result.current.state).toMatchObject({
				status: "failed",
				error: UNAVAILABLE,
			});
		});
	});

	it("three silent reconnects give the lost-connection error", async () => {
		runtime.respond = ({ url, body }) =>
			url === RUN_URL
				? sse([
						started(body.threadId, body.runId),
						reconnect(body.runId),
					])
				: sse([{ type: "MESSAGES_SNAPSHOT", messages: [] }]);
		const { result } = renderResearch();

		await act(async () => {
			await result.current.sendQuery(QUESTION);
		});

		expect(requests.map((request) => request.url)).toEqual([
			RUN_URL,
			CONNECT_URL,
			CONNECT_URL,
			CONNECT_URL,
		]);
		expect(result.current.state).toMatchObject({
			status: "failed",
			error: "The connection to this reply was lost. Reopen the conversation to see how it ended.",
		});
	});
});
