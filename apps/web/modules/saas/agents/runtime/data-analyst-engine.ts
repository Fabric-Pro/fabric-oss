import {
	type AGUIEvent,
	type BaseEvent,
	contentToText,
	type Message,
	type RunAgentInput,
} from "@ag-ui/client";
import { LangGraphHttpAgent } from "@ag-ui/langgraph";
import { checkRateLimit, RATE_LIMIT_PRESETS } from "@repo/api/lib/rate-limit";
import { isFeatureEnabled, isOrganizationMember } from "@repo/database";
import type { Subscription } from "rxjs";
import {
	dataAnalystUrl,
	issueCopilotAgentRequest,
	resolveCopilotTenant,
} from "../../../../app/api/copilotkit/agent-request";
import {
	DATA_ANALYST_AGENT_ID,
	type DataAnalystProps,
	dataAnalystPropsSchema,
} from "../lib/data-analyst-runtime-protocol";
import { trimHistoryForRequest } from "../lib/direct-chat-turns";
import { DataAnalystEventTranslator } from "./data-analyst-events";
import {
	type InProcessAdmission,
	InProcessEngine,
	type InProcessRun,
	InProcessTurnError,
} from "./in-process-engine";

const DATA_ANALYST_RUN_LIMIT_MS = 240000;
interface DataAnalystTurn {
	url: string;
	headers: Record<string, string>;
	messages: Message[];
}
export { DATA_ANALYST_AGENT_ID };

export class DataAnalystEngine extends InProcessEngine<
	DataAnalystProps,
	DataAnalystTurn
> {
	readonly agentId = DATA_ANALYST_AGENT_ID;
	protected readonly propsSchema = dataAnalystPropsSchema;

	protected async admit({
		input,
	}: {
		input: RunAgentInput;
	}): Promise<InProcessAdmission<DataAnalystTurn>> {
		if (
			!(await isFeatureEnabled(
				"COPILOTKIT_DATA_ANALYST_CHAT",
				this.caller.organizationId,
			))
		) {
			return {
				ok: false,
				code: "FEATURE_DISABLED",
				message:
					"The data analyst is not enabled on the agent runtime for this organization.",
			};
		}
		if (
			!(await isOrganizationMember(
				this.caller.userId,
				this.caller.organizationId,
			))
		) {
			return {
				ok: false,
				code: "FORBIDDEN",
				message:
					"The data analyst is available to members of this organization only.",
			};
		}
		const limit = await checkRateLimit(
			`data-analyst:${this.caller.userId}`,
			RATE_LIMIT_PRESETS.ai.limit,
			RATE_LIMIT_PRESETS.ai.windowMs,
		);
		if (!limit.allowed) {
			return {
				ok: false,
				code: "RATE_LIMITED",
				message: `Too many requests. Please try again in ${limit.resetInSeconds} seconds.`,
			};
		}
		const messages = trimHistoryForRequest(
			input.messages.flatMap((message) =>
				message.role === "user" || message.role === "assistant"
					? [
							{
								id: message.id,
								role: message.role,
								content: contentToText(message.content),
							},
						]
					: [],
			),
		);
		const last = messages.at(-1);
		if (last?.role !== "user" || !last.content.trim()) {
			return {
				ok: false,
				code: "NO_MESSAGE",
				message: "A run needs a new user message.",
			};
		}
		const tenant = await resolveCopilotTenant({
			userId: this.caller.userId,
			organizationId: this.caller.organizationId,
			isAgentRun: true,
		});
		if (!tenant.ok) {
			return { ok: false, refusal: tenant.response };
		}
		const issued = await issueCopilotAgentRequest({
			userId: this.caller.userId,
			organizationId: this.caller.organizationId,
			tenant: tenant.tenant,
		});
		return issued.ok
			? {
					ok: true,
					turn: {
						url: dataAnalystUrl(),
						headers: issued.request.headers,
						messages,
					},
				}
			: { ok: false, refusal: issued.response };
	}

	protected async *turn(
		turn: DataAnalystTurn,
		run: InProcessRun,
	): AsyncIterable<AGUIEvent> {
		if (run.signal.aborted) {
			return;
		}
		const agent = new LangGraphHttpAgent({
			url: turn.url,
			headers: turn.headers,
		});
		const limit = new AbortController();
		const timer = setTimeout(
			() => limit.abort(),
			DATA_ANALYST_RUN_LIMIT_MS,
		);
		const translator = new DataAnalystEventTranslator();
		const input: RunAgentInput = {
			threadId: run.threadId,
			runId: run.runId,
			messages: turn.messages,
			tools: [],
			context: [],
			state: {},
			forwardedProps: {},
		};
		try {
			for await (const event of agentEvents(
				agent,
				input,
				AbortSignal.any([run.signal, limit.signal]),
			)) {
				yield* translator.translate(event);
				if (translator.finished) {
					break;
				}
			}
			yield* translator.close();
			if (!translator.finished) {
				throw new Error(
					"The data analyst's stream ended without RUN_FINISHED",
				);
			}
		} catch (error) {
			yield* translator.close();
			if (run.signal.aborted) {
				return;
			}
			if (limit.signal.aborted) {
				throw new InProcessTurnError(
					"RUN_TIMED_OUT",
					"The analysis ran past its time limit. Try a narrower question.",
				);
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}
}

async function* agentEvents(
	agent: LangGraphHttpAgent,
	input: RunAgentInput,
	signal: AbortSignal,
): AsyncGenerator<BaseEvent> {
	const pending: BaseEvent[] = [];
	let complete = false;
	const failure: { value: { error: unknown } | null } = { value: null };
	let wake = () => {};
	const onAbort = () => {
		complete = true;
		wake();
	};
	signal.addEventListener("abort", onAbort, { once: true });
	let subscription: Subscription | undefined;
	try {
		subscription = agent.run(input).subscribe({
			next: (event) => {
				pending.push(event);
				wake();
			},
			error: (error: unknown) => {
				failure.value = { error };
				complete = true;
				wake();
			},
			complete: () => {
				complete = true;
				wake();
			},
		});
		while (true) {
			if (signal.aborted) {
				throw new DOMException("Analysis stopped", "AbortError");
			}
			const event = pending.shift();
			if (event) {
				yield event;
			} else if (failure.value) {
				throw failure.value.error;
			} else if (complete) {
				return;
			} else {
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
		subscription?.unsubscribe();
		agent.abortRun();
	}
}
