import { generateText } from "ai";
import { afterEach, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("undici", async () => ({
	...(await vi.importActual<typeof import("undici")>("undici")),
	fetch: fetchMock,
}));

afterEach(() => {
	fetchMock.mockReset();
	vi.unstubAllEnvs();
});

const prompt = [
	{
		role: "user" as const,
		content: [{ type: "text" as const, text: "hello" }],
	},
];
const result = {
	content: [{ type: "text", text: "standard result" }],
	finishReason: { unified: "stop", raw: "stop" },
	usage: { inputTokens: { total: 1 }, outputTokens: { total: 2 } },
	warnings: [],
};
function capture(statuses = [200], stream = false) {
	const bodies: { providerOptions: { gateway: Record<string, unknown> } }[] =
		[];
	fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)));
		const status =
			statuses[Math.min(bodies.length - 1, statuses.length - 1)];
		if (status === 200 && stream) {
			return new Response(
				'data: {"type":"text-delta","id":"example","delta":"standard result"}\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			);
		}
		return new Response(
			JSON.stringify(
				status === 200
					? result
					: {
							error: {
								message: "Resource Unavailable",
								type: "api_error",
							},
						},
			),
			{ status, headers: { "content-type": "application/json" } },
		);
	});
	return bodies;
}
async function model(
	provider = "VERCEL_GATEWAY",
	apiKey = "example-gateway-key",
	serviceTier: "flex" | undefined = "flex",
) {
	const { getModel } = await import("../model-factory");
	return getModel("openai/gpt-4o-mini", { provider, apiKey, serviceTier });
}
it.each(["VERCEL_GATEWAY", "OPENAI_DIRECT"])(
	"requests flex on %s Vercel route and preserves options",
	async (provider) => {
		const bodies = capture();
		await generateText({
			model: await model(
				provider,
				provider === "OPENAI_DIRECT"
					? "vck_example_key"
					: "example-key",
			),
			prompt: "hello",
			maxRetries: 0,
			providerOptions: {
				openai: { reasoningEffort: "low" },
				gateway: { order: ["openai"] },
			},
		});
		expect(bodies[0].providerOptions).toEqual({
			openai: { reasoningEffort: "low" },
			gateway: { order: ["openai"], serviceTier: "flex" },
		});
	},
);
it("keeps a plain gateway call unchanged", async () => {
	const bodies = capture();
	const { getModel } = await import("../model-factory");
	await generateText({
		model: getModel("openai/gpt-4o-mini", {
			provider: "VERCEL_GATEWAY",
			apiKey: "example-key",
		}),
		prompt: "hello",
		maxRetries: 0,
	});
	expect(bodies[0]).not.toHaveProperty("providerOptions");
});
it.each([429, 503])(
	"retries HTTP %s once without the tier and returns the result",
	async (status) => {
		const bodies = capture([status, 200]);
		const response = await generateText({
			model: await model(),
			prompt: "hello",
			maxRetries: 0,
			providerOptions: { gateway: { order: ["openai"] } },
		});
		expect(response.text).toBe("standard result");
		expect(bodies).toHaveLength(2);
		expect(bodies[0].providerOptions.gateway.serviceTier).toBe("flex");
		expect(bodies[1].providerOptions.gateway).toEqual({
			order: ["openai"],
		});
	},
);
it.each([400, 429])("bounds retry attempts for HTTP %s", async (status) => {
	const bodies = capture([status]);
	await expect(
		generateText({
			model: await model(),
			prompt: "hello",
			maxRetries: 0,
		}),
	).rejects.toThrow();
	expect(bodies[0].providerOptions.gateway.serviceTier).toBe("flex");
	expect(bodies).toHaveLength(status === 400 ? 1 : 2);
});
it.each([429, 503])(
	"retries a stream-open HTTP %s once without the tier",
	async (status) => {
		const bodies = capture([status, 200], true);
		const raw = (await model()) as Exclude<
			import("ai").LanguageModel,
			string
		>;
		const response = await raw.doStream({ prompt });
		const chunks = [];
		for await (const chunk of response.stream) {
			chunks.push(chunk);
		}
		expect(chunks).toContainEqual({
			type: "text-delta",
			id: "example",
			delta: "standard result",
		});
		expect(bodies).toHaveLength(2);
		expect(bodies[0].providerOptions.gateway.serviceTier).toBe("flex");
		expect(bodies[1].providerOptions.gateway).not.toHaveProperty(
			"serviceTier",
		);
	},
);
it("requests flex through the global gateway fallback", async () => {
	vi.resetModules();
	vi.stubEnv("AI_GATEWAY_API_KEY", "example-global-key");
	const bodies = capture();
	try {
		const { getModel } = await import("../model-factory");
		await generateText({
			model: getModel("openai/gpt-4o-mini", { serviceTier: "flex" }),
			prompt: "hello",
			maxRetries: 0,
		});
		expect(bodies[0].providerOptions.gateway.serviceTier).toBe("flex");
	} finally {
		vi.resetModules();
	}
});
it("does not retry a stream after text is delivered", async () => {
	const bodies: { providerOptions: { gateway: Record<string, unknown> } }[] =
		[];
	fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)));
		const chunks = [
			{ type: "text-delta", id: "example", delta: "partial" },
			{ type: "error", error: "Resource Unavailable" },
		];
		return new Response(
			chunks
				.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
				.join(""),
			{ headers: { "content-type": "text/event-stream" } },
		);
	});
	const raw = (await model()) as Exclude<import("ai").LanguageModel, string>;
	const response = await raw.doStream({ prompt });
	const chunks = [];
	for await (const chunk of response.stream) {
		chunks.push(chunk);
	}
	expect(chunks).toContainEqual({
		type: "text-delta",
		id: "example",
		delta: "partial",
	});
	expect(bodies).toHaveLength(1);
	expect(bodies[0].providerOptions.gateway.serviceTier).toBe("flex");
});

it("does not retry HTTP 400 before a stream opens", async () => {
	const bodies = capture([400]);
	const raw = (await model()) as Exclude<import("ai").LanguageModel, string>;
	await expect(raw.doStream({ prompt })).rejects.toThrow();
	expect(bodies).toHaveLength(1);
	expect(bodies[0].providerOptions.gateway.serviceTier).toBe("flex");
});
