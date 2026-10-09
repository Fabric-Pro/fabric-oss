/**
 * A workflow activity that cannot resolve a provider must fail ONCE.
 *
 * Since the platform-key fallback closed on the user-facing resolution path
 * (Fizzy #1875), `AIProviderNotConfiguredError` is the single refusal a tenant
 * with no configured provider gets — and it is deterministic. Every attempt
 * asks the same question of the same rows and gets the same answer, so a retry
 * ladder buys nothing and costs everything: on the document workflow alone,
 * five attempts across three model-touching activities, each backing off to a
 * minute, before a scheduled run reports a verdict it had in its first
 * millisecond. Multiply by every affected tenant and every scheduled run.
 *
 * Temporal decides this server-side from `retry.nonRetryableErrorTypes`, which
 * it matches against the activity failure's recorded type
 * (`error.constructor?.name ?? error.name`). So the assertion that matters is
 * structural: the string is present in the retry policy of every proxy whose
 * activities reach a model.
 *
 * The bags are captured by mocking `proxyActivities` and importing each
 * workflow module for its module-level side effects — the same technique
 * `generate-publishing-case-study.test.ts` uses. Only `proxyActivities` is
 * replaced; every other `@temporalio/workflow` export stays real, because these
 * modules also call `defineSignal` / `defineQuery` at module scope.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AI_NON_RETRYABLE_ERROR_TYPES } from "../ai-non-retryable-errors";

const captured = vi.hoisted(() => ({
	bags: [] as Array<Record<string, unknown>>,
}));

vi.mock("@temporalio/workflow", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@temporalio/workflow")>();
	return {
		...actual,
		proxyActivities: vi.fn((options: Record<string, unknown>) => {
			captured.bags.push(options);
			// Destructured at every call site, so any property must resolve.
			return new Proxy({}, { get: () => vi.fn(async () => undefined) });
		}),
	};
});

/**
 * Every workflow with a proxy that reaches a model, and HOW MANY of its proxies
 * do. The count is what makes this a drift guard rather than a smoke test: the
 * multi-proxy workflows deliberately leave their non-AI proxies alone (a GitHub
 * collector or an email send has nothing to do with provider configuration),
 * and a future proxy that quietly adds a model call without adding the policy
 * changes this number.
 */
const AI_WORKFLOWS: Array<{
	name: string;
	load: () => Promise<unknown>;
	aiProxies: number;
}> = [
	{
		name: "auto-analyze-meeting-transcript",
		load: () => import("../auto-analyze-meeting-transcript"),
		aiProxies: 1,
	},
	{
		name: "daily-brief-generation-workflow",
		load: () => import("../daily-brief-generation-workflow"),
		aiProxies: 3,
	},
	{
		name: "direct-chat",
		load: () => import("../direct-chat"),
		aiProxies: 1,
	},
	{
		// Generation and the Proposal visuals (Fizzy #2801). The visuals proxy
		// makes one attempt anyway; it declares the policy like any proxy
		// that reaches a model.
		name: "document-generation-child",
		load: () => import("../document-generation-child"),
		aiProxies: 2,
	},
	{
		name: "extract-meeting-insights-on-demand",
		load: () => import("../extract-meeting-insights-on-demand"),
		aiProxies: 1,
	},
	{
		name: "generate-and-send-newsletter",
		load: () => import("../generate-and-send-newsletter"),
		aiProxies: 2,
	},
	{
		name: "generate-meeting-agenda",
		load: () => import("../generate-meeting-agenda"),
		aiProxies: 1,
	},
	{
		name: "generate-publishing-blog-post",
		load: () => import("../generate-publishing-blog-post"),
		aiProxies: 1,
	},
	{
		name: "generate-publishing-case-study",
		load: () => import("../generate-publishing-case-study"),
		aiProxies: 1,
	},
	{
		name: "generate-publishing-linkedin-post",
		load: () => import("../generate-publishing-linkedin-post"),
		aiProxies: 1,
	},
	{
		name: "generate-publishing-newsletter-blurb",
		load: () => import("../generate-publishing-newsletter-blurb"),
		aiProxies: 1,
	},
	{
		name: "generate-publishing-planning-analysis",
		load: () => import("../generate-publishing-planning-analysis"),
		aiProxies: 1,
	},
	{
		name: "generate-publishing-short-post",
		load: () => import("../generate-publishing-short-post"),
		aiProxies: 1,
	},
	{
		name: "generate-publishing-stakeholder-email",
		load: () => import("../generate-publishing-stakeholder-email"),
		aiProxies: 1,
	},
	{
		name: "generate-publishing-webinar-script",
		load: () => import("../generate-publishing-webinar-script"),
		aiProxies: 1,
	},
	{
		// Prepare resolves the model to fail fast; detect, rewrite, and
		// extract call it. Fail-build's proxy reaches no model.
		name: "glossy-edition-build",
		load: () => import("../glossy-edition-build"),
		aiProxies: 2,
	},
	{
		name: "link-meeting-action-items",
		load: () => import("../link-meeting-action-items"),
		aiProxies: 1,
	},
	{
		// The review reaches a model; the FAILED write's proxy does not.
		name: "proposal-analysis",
		load: () => import("../proposal-analysis"),
		aiProxies: 1,
	},
	{
		name: "publishing-suggestion-generation-workflow",
		load: () => import("../publishing-suggestion-generation-workflow"),
		aiProxies: 1,
	},
	{
		name: "slack-channel-monitor",
		load: () => import("../slack-channel-monitor"),
		aiProxies: 1,
	},
	{
		name: "teams-channel-monitor",
		load: () => import("../teams-channel-monitor"),
		aiProxies: 1,
	},
	{
		name: "teams-chat-monitor",
		load: () => import("../teams-chat-monitor"),
		aiProxies: 1,
	},
];

function retryTypes(bag: Record<string, unknown>): string[] {
	const retry = bag.retry as
		| { nonRetryableErrorTypes?: string[] }
		| undefined;
	return retry?.nonRetryableErrorTypes ?? [];
}

beforeEach(() => {
	captured.bags.length = 0;
});

describe("AI_NON_RETRYABLE_ERROR_TYPES", () => {
	it("names the refusal a tenant with no configured provider gets", () => {
		// The literal is what Temporal matches, and it must equal the class
		// name thrown by `packages/ai/lib/dynamic-model-selector.ts`. Asserted
		// as a literal rather than imported: pulling @repo/ai in drags
		// @repo/database and @repo/payments into a workflow-layer test.
		expect(AI_NON_RETRYABLE_ERROR_TYPES).toContain(
			"AIProviderNotConfiguredError",
		);
	});

	it("keeps the sibling usage-limit refusal it generalises", () => {
		// `direct-chat` named this one alone before the constant existed. A
		// HARD limit's window is measured in hours; a retry ladder in seconds
		// cannot outlast one, so it belongs to the same verdict.
		expect(AI_NON_RETRYABLE_ERROR_TYPES).toContain(
			"AiUsageLimitExceededError",
		);
	});
});

describe("every workflow proxy that reaches a model refuses to retry it", () => {
	for (const workflow of AI_WORKFLOWS) {
		it(`${workflow.name} declares it on ${workflow.aiProxies} prox${
			workflow.aiProxies === 1 ? "y" : "ies"
		}`, async () => {
			await workflow.load();

			expect(captured.bags.length).toBeGreaterThan(0);
			const declaring = captured.bags.filter((bag) =>
				retryTypes(bag).includes("AIProviderNotConfiguredError"),
			);
			expect(declaring).toHaveLength(workflow.aiProxies);

			// Whatever workflow-specific types a proxy already named are kept
			// — the constant is spread alongside them, never in place of them.
			for (const bag of declaring) {
				expect(retryTypes(bag)).toContain("AiUsageLimitExceededError");
			}
		});
	}
});

describe("a spent ChatGPT plan window is non-retryable (Fizzy #2939)", () => {
	// Temporal records the failure type from the thrown error's class, so the
	// name the plan wrapper throws must be the string in the list.
	it("records the plan wrapper's error under a type the list names", async () => {
		const { SubscriptionPlanExhaustedError } = await import(
			"@repo/agent-types/chatgpt-plan-fetch"
		);
		const { ensureApplicationFailure } = await import("@temporalio/common");

		const failure = ensureApplicationFailure(
			new SubscriptionPlanExhaustedError("No usage left", null),
		);

		expect(AI_NON_RETRYABLE_ERROR_TYPES).toContain(failure.type);
	});

	// Fizzy #2770 F10: the plan does not serve the chosen model and no fallback
	// stood in. A literal for the reason above; `chatgpt-plan-provider.test.ts`
	// in @repo/ai pins the class's constructor name to it.
	it("names the not-served model refusal", () => {
		expect(AI_NON_RETRYABLE_ERROR_TYPES).toContain(
			"ChatGptPlanModelNotServedError",
		);
	});

	// Fizzy #2770: a plan that ran out after output started, with another plan
	// left to serve the call. Retried, so the next attempt resolves that plan.
	it("leaves PlanSourceRotatedError retryable", async () => {
		const { PlanSourceRotatedError } = await import(
			"@repo/agent-types/chatgpt-plan-fetch"
		);
		const { ensureApplicationFailure } = await import("@temporalio/common");

		const failure = ensureApplicationFailure(new PlanSourceRotatedError());

		expect(failure.type).toBe("PlanSourceRotatedError");
		expect(AI_NON_RETRYABLE_ERROR_TYPES).not.toContain(failure.type);
	});
});
