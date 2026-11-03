/**
 * A server whose `redactErrorLogs` hook names a run logs that run's failures
 * by class, code, HTTP status and ids, keeps the text of its replies out of
 * the reply logs, and logs a streamed state's tool calls by name only: a
 * provider's error text can repeat the request, the request carries the
 * prompt, and a patch call's arguments carry proposed text that can repeat
 * it. A failure thrown while the run is built, before its stream starts,
 * reaches the route's own catch, which logs it the same way and answers
 * with a generic message instead of the error's text. The routes ask the
 * hook about the same keys the run's config is built from. What the browser
 * receives from a stream does not change. Without the hook, or for a run
 * the hook does not name, the logs and answers are as before. For every
 * run, the `/runs/stream` request log keeps the body's keys and flags but
 * not the body.
 */

import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createUnifiedServer,
	type LangGraphStreamEvent,
	type UnifiedServerConfig,
} from "../src/unified-server";

const PROMPT_TEXT = "You revise a client proposal for Example Org.";
const PROVIDER_TEXT = `Provider rejected the request: ${PROMPT_TEXT}`;
// Short enough that a log's 100-character preview carries all of it.
const FAILURE_REPLY = `Failed to generate document: ${PROMPT_TEXT}`;

/** The hook the tests install: it names a run by a marker in its config. */
const redactMarkedRuns: NonNullable<UnifiedServerConfig["redactErrorLogs"]> = (
	configurable,
) => configurable?.example_redacted_run === true;

function providerError(): Error {
	return Object.assign(new Error(PROVIDER_TEXT), {
		status: 400,
		code: "invalid_request_error",
	});
}

// The AG-UI handler mints its reply id with `randomBytes` while it builds the
// run, before its stream starts; a test makes that call throw.
vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

function serverConfig(
	redactErrorLogs?: UnifiedServerConfig["redactErrorLogs"],
): UnifiedServerConfig {
	return {
		name: "test-agent",
		description: "Test agent",
		baseUrl: "http://localhost:3000",
		port: 3000,
		skills: [],
		supportsStreaming: true,
		...(redactErrorLogs ? { redactErrorLogs } : {}),
	};
}

function createApp(
	steps: Array<LangGraphStreamEvent | "throw">,
	redactErrorLogs?: UnifiedServerConfig["redactErrorLogs"],
) {
	return createUnifiedServer(
		serverConfig(redactErrorLogs),
		async () => ({ response: "ok" }),
		(output) => ({
			response:
				typeof output.response === "string" ? output.response : "",
		}),
		undefined,
		async function* () {
			for (const step of steps) {
				if (step === "throw") {
					throw providerError();
				}
				yield step;
			}
		},
	).app;
}

/** A chat node that ended its run on a failure reply carrying the text. */
const FAILED_RUN: LangGraphStreamEvent = {
	nodeName: "chat_node",
	state: {
		error: FAILURE_REPLY,
		messages: [
			{ type: "human", content: "Tighten the scope." },
			{ type: "ai", content: FAILURE_REPLY },
		],
	},
};

/** The same failure as a terminal error only, with no reply message. */
const TERMINAL_ERROR: LangGraphStreamEvent = {
	nodeName: "chat_node",
	state: { error: FAILURE_REPLY },
};

// Short enough that a log's 100-character preview carries all of it.
const REPLY = `Revised as asked: ${PROMPT_TEXT}`;

/**
 * A reply that only the handler's last look at the final state emits. The
 * per-step scan and that last look find the current turn differently: a
 * message with role "user" starts a turn for the first (whatever its type)
 * and only type "human" does for the second. The trailing message below
 * hides the reply from the per-step scan, so the fallback emits it.
 */
const FINAL_STATE_REPLY: LangGraphStreamEvent = {
	nodeName: "chat_node",
	state: {
		messages: [
			{ type: "human", content: "Tighten the scope." },
			{ type: "ai", content: REPLY },
			{ type: "system", role: "user", content: "Keep it short." },
		],
	},
};

// The proposed document text a patch call carries; it can repeat the prompt.
const PATCH_TEXT = `Scope narrowed for the client: ${PROMPT_TEXT}`;
// The text of the turn that made the call.
const PATCH_TURN_TEXT = "Applying the requested scope edits.";

/** A chat node whose reply turn proposes document edits as a patch call. */
const PATCH_CALL: LangGraphStreamEvent = {
	nodeName: "chat_node",
	state: {
		messages: [
			{ type: "human", content: "Tighten the scope." },
			{
				type: "ai",
				content: PATCH_TURN_TEXT,
				tool_calls: [
					{
						name: "apply_document_patches",
						args: {
							patches: [
								{
									op: "append_to_section",
									anchor: "## Scope",
									content: PATCH_TEXT,
								},
							],
						},
						id: "call-1",
					},
				],
			},
		],
	},
};

/** A state-sanitize log line; failing to find it means it did not run. */
function sanitizeLog(
	spy: ReturnType<typeof vi.spyOn>,
	direction: "input" | "output",
): string {
	const calls = spy.mock.calls.filter(([message]) =>
		String(message).includes(`sanitizeStateForCopilotKit ${direction}:`),
	);
	expect(calls).toHaveLength(1);
	return JSON.stringify(calls[0]);
}

/** The fallback's own log line; failing to find it means it did not run. */
function fallbackLog(spy: ReturnType<typeof vi.spyOn>): string {
	const calls = spy.mock.calls.filter(([message]) =>
		String(message).includes(
			"Emitting fallback TEXT_MESSAGE from final state",
		),
	);
	expect(calls).toHaveLength(1);
	return JSON.stringify(calls[0]);
}

// The rate limiter's store is module-wide; a bucket of its own keeps these
// requests from spending another file's.
const headers = {
	"Content-Type": "application/json",
	"X-Real-IP": "198.51.100.23",
};

function logged(spy: ReturnType<typeof vi.spyOn>): string {
	return spy.mock.calls
		.map((args) =>
			args
				.map((arg) =>
					arg instanceof Error
						? `${arg.name}: ${arg.message}`
						: JSON.stringify(arg),
				)
				.join(" "),
		)
		.join("\n");
}

async function sseData(response: Response): Promise<string> {
	expect(response.status).toBe(200);
	return response.text();
}

/** The text the browser's chat shows: every TEXT_MESSAGE_CONTENT delta. */
function chatText(body: string): string {
	return body
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => JSON.parse(line.slice("data: ".length)))
		.filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
		.map((event) => event.delta)
		.join("");
}

describe("error logs a server's hook redacts", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.stubEnv("AGENT_API_KEY", "");
		vi.stubEnv("AGENT_API_KEYS", "");
		vi.stubEnv("AGENT_HMAC_SECRET", "");
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	/** A durable AG-UI request: no in-request reply transport header. */
	async function agUiRequest(
		steps: Array<LangGraphStreamEvent | "throw">,
		options: { hook?: boolean; marked?: boolean } = {},
	): Promise<Response> {
		return createApp(
			steps,
			options.hook ? redactMarkedRuns : undefined,
		).request("/", {
			method: "POST",
			headers,
			body: JSON.stringify({
				threadId: "thread-example",
				runId: "run-example",
				messages: [{ role: "user", content: "Tighten the scope." }],
				forwardedProps: options.marked
					? { example_redacted_run: true }
					: {},
			}),
		});
	}

	function agUiRun(
		steps: Array<LangGraphStreamEvent | "throw">,
		options: { hook?: boolean; marked?: boolean } = {},
	): Promise<string> {
		return agUiRequest(steps, options).then(sseData);
	}

	function platformRun(
		steps: Array<LangGraphStreamEvent | "throw">,
		options: { hook?: boolean; marked?: boolean } = {},
	): Promise<string> {
		return createApp(steps, options.hook ? redactMarkedRuns : undefined)
			.request("/threads/thread-example/runs/stream", {
				method: "POST",
				headers,
				body: JSON.stringify({
					input: {
						messages: [
							{ role: "user", content: "Tighten the scope." },
						],
					},
					config: {
						configurable: options.marked
							? { example_redacted_run: true }
							: {},
					},
				}),
			})
			.then(sseData);
	}

	describe("an AG-UI stream failure", () => {
		it("logs the class, code, status and ids of a named run, and sends the error as before", async () => {
			const body = await agUiRun(["throw"], { hook: true, marked: true });

			const errors = logged(errorSpy);
			expect(errors).not.toContain(PROMPT_TEXT);
			expect(errors).toContain("invalid_request_error");
			expect(errors).toContain("400");
			expect(errors).toContain('"errorType":"Error"');
			expect(errors).toContain("run-example");
			expect(errors).toContain("thread-example");
			// The browser's RUN_ERROR still carries the error's text.
			expect(body).toContain(PROVIDER_TEXT);
		});

		it("logs the error whole for a run the hook does not name", async () => {
			await agUiRun(["throw"], { hook: true });

			expect(logged(errorSpy)).toContain(PROVIDER_TEXT);
		});

		it("logs the error whole without the hook", async () => {
			await agUiRun(["throw"], { marked: true });

			expect(logged(errorSpy)).toContain(PROVIDER_TEXT);
		});
	});

	describe.each([
		["a failure reply", FAILED_RUN],
		["a terminal error", TERMINAL_ERROR],
	])("a durable AG-UI run that ends on %s", (_label, event) => {
		it("logs no text of a named run's reply, and sends the reply as before", async () => {
			const body = await agUiRun([event], { hook: true, marked: true });

			expect(logged(logSpy)).not.toContain(PROMPT_TEXT);
			expect(logged(errorSpy)).not.toContain(PROMPT_TEXT);
			expect(body).toContain(FAILURE_REPLY);
		});

		it("logs a preview of the reply without the hook", async () => {
			await agUiRun([event], { marked: true });

			expect(logged(logSpy)).toContain(PROMPT_TEXT);
		});
	});

	describe("a durable AG-UI run whose reply only the final state carries", () => {
		it("logs no text of a named run's reply, and sends the reply as before", async () => {
			const body = await agUiRun([FINAL_STATE_REPLY], {
				hook: true,
				marked: true,
			});

			expect(fallbackLog(logSpy)).toContain(
				`"contentLength":${REPLY.length}`,
			);
			expect(logged(logSpy)).not.toContain(PROMPT_TEXT);
			expect(logged(errorSpy)).not.toContain(PROMPT_TEXT);
			expect(chatText(body)).toBe(REPLY);
		});

		it("logs a preview of the reply without the hook", async () => {
			const body = await agUiRun([FINAL_STATE_REPLY], { marked: true });

			expect(fallbackLog(logSpy)).toContain(PROMPT_TEXT);
			expect(chatText(body)).toBe(REPLY);
		});
	});

	/**
	 * A threadless platform run whose config carries a classified Proposal's
	 * bound prompt. Whatever the stream does after, only the request log is
	 * under test.
	 */
	async function threadlessPlatformRun(
		options: { hook?: boolean } = {},
	): Promise<void> {
		const response = await createApp(
			[],
			options.hook ? redactMarkedRuns : undefined,
		).request("/runs/stream", {
			method: "POST",
			headers,
			body: JSON.stringify({
				input: {
					messages: [{ role: "user", content: "Tighten the scope." }],
				},
				config: {
					configurable: {
						example_redacted_run: true,
						proposal_mode: "artifact",
						proposal_client_prompt: PROMPT_TEXT,
					},
				},
			}),
		});
		await response.text();
	}

	/** The `/runs/stream` request log; failing to find it means it did not run. */
	function requestLog(spy: ReturnType<typeof vi.spyOn>): string {
		const calls = spy.mock.calls.filter(([message]) =>
			String(message).includes("/runs/stream FULL REQUEST:"),
		);
		expect(calls).toHaveLength(1);
		return JSON.stringify(calls[0]);
	}

	describe("a threadless platform request", () => {
		it("logs the request's keys and flags but none of its text for a named run", async () => {
			await threadlessPlatformRun({ hook: true });

			expect(requestLog(logSpy)).toContain("proposal_client_prompt");
			expect(logged(logSpy)).not.toContain(PROMPT_TEXT);
		});

		it("logs the request's keys and flags but not its body without the hook", async () => {
			await threadlessPlatformRun();

			const log = requestLog(logSpy);
			expect(log).toContain("proposal_client_prompt");
			expect(log).toContain("hasActions");
			expect(log).not.toContain(PROMPT_TEXT);
		});
	});

	describe("a platform stream failure", () => {
		it("logs the class, code, status and ids of a named run, and sends the error as before", async () => {
			const body = await platformRun(["throw"], {
				hook: true,
				marked: true,
			});

			const errors = logged(errorSpy);
			expect(errors).not.toContain(PROMPT_TEXT);
			expect(errors).toContain("invalid_request_error");
			expect(errors).toContain("400");
			expect(errors).toContain("thread-example");
			expect(body).toContain(PROVIDER_TEXT);
		});

		it("logs the error whole without the hook", async () => {
			await platformRun(["throw"], { marked: true });

			expect(logged(errorSpy)).toContain(PROVIDER_TEXT);
		});
	});

	/**
	 * A platform run whose agent fails before the stream starts: a server
	 * with no platform stream executor runs the agent first and streams its
	 * result after, so the agent's error reaches the route. The marker goes
	 * in the request's configurable, context or properties; the run's config
	 * is built from all three.
	 */
	async function failedPlatformRun(
		path: string,
		options: {
			hook?: boolean;
			markedIn?: "configurable" | "context" | "properties";
		} = {},
	): Promise<Response> {
		const app = createUnifiedServer(
			serverConfig(options.hook ? redactMarkedRuns : undefined),
			async () => {
				throw providerError();
			},
			() => ({ response: "" }),
		).app;
		const marker = { example_redacted_run: true };
		const markedIn = options.markedIn ?? "configurable";
		return app.request(path, {
			method: "POST",
			headers,
			body: JSON.stringify({
				input: {
					messages: [{ role: "user", content: "Tighten the scope." }],
				},
				...(markedIn === "configurable"
					? { config: { configurable: marker } }
					: { [markedIn]: marker }),
			}),
		});
	}

	describe.each([
		["/runs/stream", "/runs/stream"],
		[
			"/threads/thread-example/runs/stream",
			"/threads/:threadId/runs/stream",
		],
	])("a %s run that fails before its stream starts", (path, route) => {
		it.each(["configurable", "context", "properties"] as const)(
			"logs the class, code and status of the error of a run named in its %s, and answers without its text",
			async (markedIn) => {
				const response = await failedPlatformRun(path, {
					hook: true,
					markedIn,
				});

				expect(response.status).toBe(500);
				const errors = logged(errorSpy);
				expect(errors).not.toContain(PROMPT_TEXT);
				expect(errors).toContain(`Error in ${route}:`);
				expect(errors).toContain('"errorType":"Error"');
				expect(errors).toContain("invalid_request_error");
				expect(errors).toContain("400");
				expect(await response.json()).toEqual({
					error: "The agent run failed.",
				});
			},
		);

		it("logs the error whole and answers with its text without the hook", async () => {
			const response = await failedPlatformRun(path);

			expect(response.status).toBe(500);
			expect(logged(errorSpy)).toContain(PROVIDER_TEXT);
			expect(await response.json()).toEqual({ error: PROVIDER_TEXT });
		});
	});

	describe("an AG-UI request that fails while its run is built", () => {
		beforeEach(() => {
			vi.mocked(randomBytes).mockImplementationOnce(() => {
				throw providerError();
			});
		});

		it("logs the class, code and status of a named run's error, and answers without its text", async () => {
			const response = await agUiRequest([], {
				hook: true,
				marked: true,
			});

			expect(response.status).toBe(500);
			const errors = logged(errorSpy);
			expect(errors).not.toContain(PROMPT_TEXT);
			expect(errors).toContain("Error in AG-UI / handler:");
			expect(errors).toContain('"errorType":"Error"');
			expect(errors).toContain("invalid_request_error");
			expect(errors).toContain("400");
			expect(await response.json()).toEqual({
				error: "The agent run failed.",
			});
		});

		it("logs the error whole and answers with its text without the hook", async () => {
			const response = await agUiRequest([], { marked: true });

			expect(response.status).toBe(500);
			expect(logged(errorSpy)).toContain(PROVIDER_TEXT);
			expect(await response.json()).toEqual({ error: PROVIDER_TEXT });
		});
	});

	describe.each([
		["a platform stream", platformRun],
		["a durable AG-UI stream", agUiRun],
	])("%s whose state carries a patch call", (_label, run) => {
		it("logs the call's name but not its arguments or the turn's text for a named run", async () => {
			await run([PATCH_CALL], { hook: true, marked: true });

			expect(logged(logSpy)).not.toContain(PATCH_TEXT);
			expect(logged(logSpy)).not.toContain(PROMPT_TEXT);
			for (const direction of ["input", "output"] as const) {
				const log = sanitizeLog(logSpy, direction);
				expect(log).toContain("apply_document_patches");
				expect(log).not.toContain(PATCH_TURN_TEXT);
			}
		});

		it("logs the call's arguments and the turn's text without the hook", async () => {
			await run([PATCH_CALL], { marked: true });

			expect(sanitizeLog(logSpy, "input")).toContain(PATCH_TEXT);
			const output = sanitizeLog(logSpy, "output");
			expect(output).toContain(PATCH_TEXT);
			expect(output).toContain(PATCH_TURN_TEXT);
		});
	});
});
