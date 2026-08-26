import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();

/**
 * Every callback handed to the breaker, so a test can prove WHERE the failure
 * is raised. `withProviderBreaker` labels whatever its callback resolves as
 * `outcome: "success"`, so an error surfaced after the call would leave the
 * circuit closed and the provider error metric flat through a real outage.
 */
const breakerCallbacks: Array<() => Promise<unknown>> = [];

vi.mock("resend", () => ({
	Resend: class {
		emails = { send: sendMock };
	},
}));
vi.mock("@repo/observability", () => ({
	withProviderBreaker: (
		_provider: string,
		_operation: string,
		fn: () => Promise<unknown>,
	) => {
		breakerCallbacks.push(fn);
		return fn();
	},
}));
vi.mock("@repo/config", () => ({
	config: { mails: { from: "dev@example.com" } },
}));

const params = {
	to: "reviewer@example.com",
	subject: "Release notes are ready for review",
	html: "<p>body</p>",
	text: "body",
} as never;

describe("resend provider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		breakerCallbacks.length = 0;
		process.env.RESEND_API_KEY = "test-key";
	});

	it("rejects when the provider resolves an error instead of throwing", async () => {
		// resend@6 types a send as ({data, error: null} | {error, data: null}).
		// It RESOLVES on an API failure — discarding that value is what made
		// sendEmail report every provider rejection as a delivered email.
		sendMock.mockResolvedValue({
			data: null,
			error: { name: "invalid_from_address", message: "Bad sender" },
			headers: null,
		});
		const { send } = await import("../resend");

		await expect(send(params)).rejects.toThrow(/invalid_from_address/);
	});

	it("carries the provider's message so the logged failure is actionable", async () => {
		sendMock.mockResolvedValue({
			data: null,
			error: {
				name: "rate_limit_exceeded",
				message: "Too many requests",
			},
			headers: null,
		});
		const { send } = await import("../resend");

		await expect(send(params)).rejects.toThrow(/Too many requests/);
	});

	it("resolves when the provider reports success", async () => {
		sendMock.mockResolvedValue({
			data: { id: "abc" },
			error: null,
			headers: null,
		});
		const { send } = await import("../resend");

		await expect(send(params)).resolves.toBeUndefined();
	});

	it("raises the failure inside the breaker callback, not after it", async () => {
		sendMock.mockResolvedValue({
			data: null,
			error: { name: "internal_server_error", message: "Boom" },
			headers: null,
		});
		const { send } = await import("../resend");

		await expect(send(params)).rejects.toThrow();

		// Re-running the callback on its own must also reject. If the check sat
		// after `withProviderBreaker`, this would resolve and the breaker would
		// have counted a provider outage as a success.
		expect(breakerCallbacks).toHaveLength(1);
		await expect(breakerCallbacks[0]()).rejects.toThrow(/Boom/);
	});

	it("forwards the idempotency key as the request-options argument", async () => {
		sendMock.mockResolvedValue({
			data: { id: "abc" },
			error: null,
			headers: null,
		});
		const { send } = await import("../resend");

		await send({ ...(params as object), idempotencyKey: "k-1" } as never);

		expect(sendMock).toHaveBeenCalledWith(expect.any(Object), {
			idempotencyKey: "k-1",
		});
	});
});
