import { describe, expect, it, vi } from "vitest";

// The S3, Stripe and Resend providers import only the
// `@repo/observability/breakers` subpath. A server bundle that never loads
// the package root must still find their registrations, or every call through
// the breaker throws "No breaker configured for provider".
describe("@repo/observability/breakers without the package root", () => {
	it.each(["aws_s3", "stripe", "resend", "openai", "anthropic"])(
		"resolves a breaker for %s",
		async (providerKey) => {
			vi.resetModules();
			const { getBreaker } = await import("@repo/observability/breakers");
			expect(() => getBreaker(providerKey)).not.toThrow();
		},
	);

	it("still rejects a provider that has no breaker", async () => {
		vi.resetModules();
		const { getBreaker } = await import("@repo/observability/breakers");
		expect(() => getBreaker("not_a_provider")).toThrow(
			/No breaker configured for provider "not_a_provider"/,
		);
	});
});
