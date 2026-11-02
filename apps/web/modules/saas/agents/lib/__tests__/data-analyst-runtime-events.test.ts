import { type AGUIEvent, EventType } from "@ag-ui/client";
import { DataAnalystEventTranslator } from "@saas/agents/runtime/data-analyst-events";
import { describe, expect, it } from "vitest";
import { DATA_ANALYST_WIRE } from "@/__tests__/agents/runtime/_helpers/data-analyst-wire";
import {
	applyDataAnalystEvent,
	EMPTY_DATA_ANALYST_TURN,
} from "../data-analyst-runtime-events";

describe("Data Analyst client event reduction", () => {
	it("shows a returned tool failure as an error rather than a successful completion", () => {
		const running = applyDataAnalystEvent(EMPTY_DATA_ANALYST_TURN, {
			type: EventType.TOOL_CALL_START,
			toolCallId: "example-call",
			toolCallName: "create_chart",
		});
		const turn = applyDataAnalystEvent(running, {
			type: EventType.TOOL_CALL_RESULT,
			toolCallId: "example-call",
			messageId: "example-result",
			role: "tool",
			content: '{"success":false,"error":"Example tool failure"}',
		});
		expect(turn.toolCalls[0]).toMatchObject({
			status: "error",
			result: '{"success":false,"error":"Example tool failure"}',
		});
		expect(turn.charts).toEqual({});
	});
	it("uses the current run's chart as the tool result regardless of event order", () => {
		const translator = new DataAnalystEventTranslator();
		const events = DATA_ANALYST_WIRE.flatMap((event) =>
			translator.translate(event),
		);
		const result = events.find(
			(event) => event.type === EventType.TOOL_CALL_RESULT,
		);
		const chart = events.find((event) => event.type === EventType.CUSTOM);
		expect(result).toBeDefined();
		expect(chart).toBeDefined();
		if (!result || !chart) {
			throw new Error("Chart fixture incomplete");
		}
		const prefix = events.filter(
			(event) => event !== result && event !== chart,
		);
		for (const tail of [
			[result, chart],
			[chart, result],
		]) {
			const turn = [...prefix, ...tail].reduce(
				applyDataAnalystEvent,
				EMPTY_DATA_ANALYST_TURN,
			);
			expect(turn.text).toBe("Here is the chart. Done.");
			expect(turn.toolCalls[0]).toMatchObject({
				id: "chart-call",
				status: "complete",
				result: { type: "chart", config: { title: "Example chart" } },
			});
		}
	});
	it("fails a refused run before it started and settles unfinished tools", () => {
		const running = applyDataAnalystEvent(EMPTY_DATA_ANALYST_TURN, {
			type: EventType.TOOL_CALL_START,
			toolCallId: "call",
			toolCallName: "search",
		});
		const turn = applyDataAnalystEvent(running, {
			type: EventType.RUN_ERROR,
			code: "FEATURE_DISABLED",
			message: "Not enabled",
		});
		expect(turn).toMatchObject({
			status: "failed",
			error: "Not enabled",
			toolCalls: [{ status: "error" }],
		});
	});
	it("keeps a spent plan's action flags and usage-limit payload", () => {
		const plan = applyDataAnalystEvent(EMPTY_DATA_ANALYST_TURN, {
			type: EventType.RUN_ERROR,
			message: "spent",
			code: "subscription_sharing_usage_limit_exceeded",
			metadata: {
				fabric: {
					status: 429,
					resetAt: "2026-11-01T00:00:00Z",
					apiBillingOption: true,
					personalKeyOption: true,
				},
			},
		});
		expect(plan.planSpent).toMatchObject({
			planApiBillingActionable: true,
			planPersonalKeyActionable: true,
		});
		expect(plan.error).toBe(plan.planSpent?.description);
		const data = {
			limitId: "limit-example",
			dimension: "TOKENS",
			window: "DAILY",
			used: "11",
			max: "10",
			manageLimitsUrl: "/limits",
		};
		const limited = applyDataAnalystEvent(EMPTY_DATA_ANALYST_TURN, {
			type: EventType.RUN_ERROR,
			message: "Limit reached",
			code: "AI_USAGE_LIMIT_EXCEEDED",
			metadata: { fabric: { data } },
		});
		expect(limited.usageLimit).toEqual(data);
	});
	it("ignores malformed chart payloads", () => {
		const event: AGUIEvent = {
			type: EventType.CUSTOM,
			name: "fabric.data-analyst.chart",
			value: { toolCallId: "call", chart: { type: "chart" } },
		};
		expect(applyDataAnalystEvent(EMPTY_DATA_ANALYST_TURN, event)).toBe(
			EMPTY_DATA_ANALYST_TURN,
		);
	});
});
