import { logger } from "@repo/logs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGatewayGenerationCostUsd } from "../gateway-generation";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

function mockFetch(impl: (url: string) => Response | Promise<Response>) {
	globalThis.fetch = vi.fn((input: any) =>
		Promise.resolve(impl(String(input))),
	) as any;
}

describe("fetchGatewayGenerationCostUsd", () => {
	it("returns data.total_cost (USD) on a 200", async () => {
		mockFetch((url) => {
			expect(url).toContain("/generation?id=gen_01ABC");
			return new Response(
				JSON.stringify({
					data: {
						id: "gen_01ABC",
						total_cost: 0.0123,
						gateway_cost: 0.0123,
						is_byok: false,
					},
				}),
				{ status: 200 },
			);
		});
		expect(await fetchGatewayGenerationCostUsd("gen_01ABC", "key")).toBe(
			0.0123,
		);
	});

	it("adds the provider's charge to a BYOK generation's gateway cost", async () => {
		mockFetch(
			() =>
				new Response(
					JSON.stringify({
						data: {
							total_cost: 0.001,
							upstream_inference_cost: 0.042,
							is_byok: true,
						},
					}),
					{ status: 200 },
				),
		);
		expect(await fetchGatewayGenerationCostUsd("gen_x", "key")).toBeCloseTo(
			0.043,
		);
	});

	it("keeps the estimate for a BYOK generation with no provider charge reported", async () => {
		mockFetch(
			() =>
				new Response(
					JSON.stringify({
						data: {
							total_cost: 0,
							upstream_inference_cost: 0,
							is_byok: true,
						},
					}),
					{ status: 200 },
				),
		);
		expect(await fetchGatewayGenerationCostUsd("gen_x", "key")).toBeNull();
	});

	it("never reports a zero cost as actual", async () => {
		mockFetch(
			() =>
				new Response(
					JSON.stringify({ data: { total_cost: 0, is_byok: false } }),
					{ status: 200 },
				),
		);
		expect(await fetchGatewayGenerationCostUsd("gen_x", "key")).toBeNull();
	});

	it("does not read a total_cost outside the data envelope", async () => {
		mockFetch(
			() =>
				new Response(JSON.stringify({ total_cost: 0.0123 }), {
					status: 200,
				}),
		);
		expect(await fetchGatewayGenerationCostUsd("gen_x", "key")).toBeNull();
	});

	it("returns null on a 404 (cost not yet available)", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		mockFetch(() => new Response("", { status: 404 }));
		expect(await fetchGatewayGenerationCostUsd("gen_x", "key")).toBeNull();
		expect(warn).not.toHaveBeenCalled();
	});

	it("logs a refused lookup, without the key", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		mockFetch(() => new Response("", { status: 401 }));
		expect(
			await fetchGatewayGenerationCostUsd("gen_x", "sekret"),
		).toBeNull();
		expect(warn).toHaveBeenCalledWith(
			"[gateway-generation] Cost lookup refused",
			{ generationId: "gen_x", status: 401 },
		);
	});

	it("returns null when total_cost is missing/non-numeric", async () => {
		mockFetch(() => new Response(JSON.stringify({}), { status: 200 }));
		expect(await fetchGatewayGenerationCostUsd("gen_x", "key")).toBeNull();
	});

	it("never throws on a network error", async () => {
		globalThis.fetch = vi.fn(() =>
			Promise.reject(new Error("network down")),
		) as any;
		await expect(
			fetchGatewayGenerationCostUsd("gen_x", "key"),
		).resolves.toBeNull();
	});

	it("sends the bearer key", async () => {
		let seenAuth: string | null = null;
		globalThis.fetch = vi.fn((_url: any, init: any) => {
			seenAuth = init?.headers?.Authorization ?? null;
			return Promise.resolve(
				new Response(JSON.stringify({ data: { total_cost: 1 } }), {
					status: 200,
				}),
			);
		}) as any;
		await fetchGatewayGenerationCostUsd("gen_x", "sekret");
		expect(seenAuth).toBe("Bearer sekret");
	});
});
