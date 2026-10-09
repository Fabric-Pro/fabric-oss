/**
 * Every AI failure must reach the user as copy they can act on.
 *
 * The defect this guards: the fetch interceptor mapped statuses through an
 * `else if` chain with no final `else`, so any status it did not name produced
 * **no toast at all**. The one that mattered was 402 — what a provider returns
 * when the account is out of credit, which in production was the single largest
 * cause of "the AI Assistant stopped responding". The user saw the assistant go
 * quiet, with nothing on screen to distinguish it from a broken product.
 *
 * The exhaustiveness sweep at the bottom is the real regression guard: it
 * asserts a property over the whole status space rather than the handful of
 * codes someone remembered to enumerate.
 */
import { describe, expect, it } from "vitest";
import {
	describeAiError,
	extractProviderMessage,
} from "../../../../modules/saas/shared/lib/ai-error-message";

const GATEWAY_CREDIT =
	"A positive credit balance is required for all requests, including BYOK, so fallback providers remain available.";
const UPSTREAM_CREDIT =
	"Your credit balance is too low to access the API. Please go to Plans & Billing to upgrade or purchase credits.";

describe("describeAiError — provider limit conditions", () => {
	it("names an out-of-credit 402 instead of staying silent", () => {
		const copy = describeAiError(402, { error: GATEWAY_CREDIT });
		expect(copy.title).toBe("AI provider out of credit");
		expect(copy.description).toMatch(/top it up/i);
	});

	it("names out-of-credit even when the provider reports it as HTTP 400", () => {
		// Status alone never catches this one — only the wording does.
		const copy = describeAiError(400, {
			error: { message: UPSTREAM_CREDIT },
		});
		expect(copy.title).toBe("AI provider out of credit");
	});

	it("tells the user retrying will not help, since it will not", () => {
		const copy = describeAiError(402, { error: GATEWAY_CREDIT });
		expect(copy.description).toMatch(/retrying will not help/i);
	});

	it("keeps rate limiting distinct from quota", () => {
		const copy = describeAiError(429, { error: "rate limit exceeded" });
		expect(copy.title).toBe("AI service is busy");
	});

	it("maps a context-window overflow to actionable copy", () => {
		const copy = describeAiError(400, {
			error: { message: "maximum context length exceeded" },
		});
		expect(copy.title).toBe("Conversation too long");
	});
});

describe("describeAiError — the provider's own words win", () => {
	it("prefers the provider explanation over generic copy", () => {
		const copy = describeAiError(400, {
			error: { message: "tools.0.custom.input_schema: extra fields" },
		});
		// Exactly the reason that used to arrive as "400 status code (no body)".
		expect(copy.description).toBe(
			"tools.0.custom.input_schema: extra fields",
		);
	});

	it("falls back to generic copy when the body carries nothing usable", () => {
		const copy = describeAiError(400, {});
		expect(copy.title).toBe("AI request rejected");
		expect(copy.description.length).toBeGreaterThan(0);
	});
});

describe("describeAiError — an oversized request body (Fizzy #2167)", () => {
	// What the platform actually returned in the staging repro, verbatim.
	const PLATFORM_413 =
		"Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE\n\narn1::xrdqf-1786971714873-a1369bb06b08";

	it("does not parrot the platform's own words back at the user", () => {
		const copy = describeAiError(413, PLATFORM_413);
		expect(copy.description).not.toContain("FUNCTION_PAYLOAD_TOO_LARGE");
		expect(copy.description).not.toContain("arn1::");
	});

	it("names the attachment as the likely cause", () => {
		const copy = describeAiError(413, PLATFORM_413);
		expect(copy.description.toLowerCase()).toContain("attach");
	});

	it("tells the user the thread will keep failing, since it will", () => {
		// The half that matters most: a refused turn poisons every later turn,
		// so copy that only says "too large" leaves the user retrying forever.
		const copy = describeAiError(413, PLATFORM_413);
		expect(copy.description.toLowerCase()).toContain("new chat");
	});

	it("does not fall through to the generic client-error copy", () => {
		expect(describeAiError(413, PLATFORM_413).title).not.toBe(
			"AI request rejected",
		);
	});
});

describe("describeAiError — a model the ChatGPT plan does not serve (Fizzy #2770)", () => {
	it("names the model in Fabric's own words and points at AI Models", () => {
		const message =
			"The ChatGPT plan does not serve gpt-5.6-luna. Choose another model in Organization settings → AI Models.";
		const copy = describeAiError(409, {
			error: message,
			code: "CHATGPT_PLAN_MODEL_NOT_SERVED",
		});
		expect(copy.title).toBe("Model not available on the ChatGPT plan");
		expect(copy.description).toBe(message);
	});

	it("reads the code from an oRPC error's data too", () => {
		const copy = describeAiError(412, {
			data: { code: "CHATGPT_PLAN_MODEL_NOT_SERVED" },
		});
		expect(copy.title).toBe("Model not available on the ChatGPT plan");
		expect(copy.description).toMatch(/AI Models/);
	});
});

describe("extractProviderMessage", () => {
	it.each([
		["plain string", "boom", "boom"],
		["our envelope", { error: "boom" }, "boom"],
		["OpenAI-compatible", { error: { message: "boom" } }, "boom"],
		["gateway envelope", { error_code: "X", message: "boom" }, "boom"],
		["bare detail", { detail: "boom" }, "boom"],
	])("reads the %s shape", (_label, body, expected) => {
		expect(extractProviderMessage(body)).toBe(expected);
	});

	it.each([[null], [undefined], [{}], [{ error: {} }], [42]])(
		"returns undefined rather than [object Object] for %s",
		(body) => {
			expect(extractProviderMessage(body)).toBeUndefined();
		},
	);
});

describe("no AI failure is ever silent", () => {
	// The property that the old else-if chain violated. 402 is the one that
	// actually bit, but enumerating codes is exactly how it was missed, so
	// assert across the range instead.
	const statuses = [
		400, 401, 402, 403, 404, 405, 408, 409, 410, 413, 418, 422, 425, 429,
		431, 451, 500, 501, 502, 503, 504, 507, 599,
	];

	it.each(statuses)("status %i produces non-empty toast copy", (status) => {
		const copy = describeAiError(status, undefined);
		expect(copy.title.trim().length).toBeGreaterThan(0);
		expect(copy.description.trim().length).toBeGreaterThan(0);
	});

	it("still produces copy for an unexpected non-4xx/5xx status", () => {
		const copy = describeAiError(0, undefined);
		expect(copy.title.trim().length).toBeGreaterThan(0);
		expect(copy.description.trim().length).toBeGreaterThan(0);
	});
});

/**
 * The out-of-credit message asks for an action — "an administrator needs to top
 * it up" — which is only actionable if the reader knows *which* account. The
 * classifier already detects the provider; not saying it left an admin guessing
 * between every provider configured on the org.
 */
describe("describeAiError — the out-of-credit message names the account", () => {
	it.each([
		["anthropic", "Anthropic"],
		["openai", "OpenAI"],
		["azure", "Azure"],
	])(
		"names %s so an administrator knows which billing page to open",
		(slug, label) => {
			const copy = describeAiError(402, {
				error: `${slug}: Your credit balance is too low.`,
			});

			expect(copy.title).toBe("AI provider out of credit");
			expect(copy.description).toContain(`The ${label} account`);
			expect(copy.description).toMatch(/top it up/i);
		},
	);

	it("falls back to generic wording rather than guessing a provider", () => {
		// Sending someone to the wrong billing page is worse than sending them
		// to look for the right one.
		const copy = describeAiError(402, {
			error: "Your credit balance is too low.",
		});

		expect(copy.description).toContain("The AI provider account");
	});
});

// Fizzy #2770: a chat route answers 429 with the plan's exhaustion code when
// every plan serving the member is spent — possibly a shared one, so the
// copy never claims it was their own plan.
describe("describeAiError — spent ChatGPT plan", () => {
	it("names the plan serving the work, not the member's own plan", () => {
		const copy = describeAiError(429, {
			error: "Every ChatGPT plan this work may use has no usage left in this window.",
			code: "subscription_sharing_usage_limit_exceeded",
			resetAt: null,
		});
		expect(copy.title).toBe("The ChatGPT plan has no usage left");
		expect(`${copy.title} ${copy.description}`).not.toMatch(
			/your own ChatGPT plan reached/i,
		);
	});

	const RESET_AT = new Date(Date.now() + 60 * 60_000).toISOString();
	const localUntil = new Intl.DateTimeFormat(undefined, {
		...(new Date(RESET_AT).toDateString() !== new Date().toDateString() && {
			weekday: "short",
		}),
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(RESET_AT));

	it.each([
		"subscription_sharing_usage_limit_exceeded",
		"CHATGPT_PLAN_EXHAUSTED",
	])(
		"%s with a reset says the plans are spent until the local time",
		(code) => {
			const copy = describeAiError(429, {
				error: "Every ChatGPT plan this work may use has no usage left in this window. The first resets at 2026-10-08 16:37 UTC.",
				code,
				resetAt: RESET_AT,
			});
			expect(copy.title).toBe("The ChatGPT plan has no usage left");
			expect(copy.description).toContain(
				`All ChatGPT plans for your work are spent until ${localUntil}.`,
			);
			expect(copy.description).not.toMatch(/UTC/);
			expect(copy.planApiBillingActionable).toBeUndefined();
			expect(copy.billingActionable).toBeUndefined();
		},
	);

	it("offers the organization's API billing only when the server says it helps", () => {
		const copy = describeAiError(429, {
			code: "subscription_sharing_usage_limit_exceeded",
			resetAt: RESET_AT,
			apiBillingOption: true,
		});
		expect(copy.planApiBillingActionable).toBe(true);
		expect(copy.description).toMatch(/organization's API billing/);

		const without = describeAiError(429, {
			code: "subscription_sharing_usage_limit_exceeded",
			resetAt: RESET_AT,
			apiBillingOption: false,
		});
		expect(without.planApiBillingActionable).toBeUndefined();
		expect(without.description).not.toMatch(/API billing/);
	});

	it("names the weekday when the reset is not today", () => {
		const reset = new Date(Date.now() + 3 * 24 * 60 * 60_000);
		const expected = new Intl.DateTimeFormat(undefined, {
			weekday: "short",
			hour: "2-digit",
			minute: "2-digit",
		}).format(reset);
		const copy = describeAiError(429, {
			code: "subscription_sharing_usage_limit_exceeded",
			resetAt: reset.toISOString(),
		});
		expect(copy.description).toContain(
			`All ChatGPT plans for your work are spent until ${expected}.`,
		);
	});

	it("keeps the server's sentence when the reset is unknown", () => {
		const message =
			"Every ChatGPT plan this work may use has no usage left in this window. Wait for one to reset, then try again.";
		const copy = describeAiError(429, {
			error: message,
			code: "subscription_sharing_usage_limit_exceeded",
			resetAt: null,
		});
		expect(copy.description).toBe(message);
	});
});
