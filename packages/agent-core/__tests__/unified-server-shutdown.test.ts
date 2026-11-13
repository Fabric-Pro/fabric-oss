import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUnifiedServer } from "../src/unified-server";

const { serve, registerHttpServerShutdown, initObservability } = vi.hoisted(
	() => ({
		serve: vi.fn(),
		registerHttpServerShutdown: vi.fn(),
		initObservability: vi.fn(),
	}),
);

vi.mock("@hono/node-server", () => ({ serve }));
vi.mock("@repo/observability", async () => {
	const actual = await vi.importActual<typeof import("@repo/observability")>(
		"@repo/observability",
	);
	return {
		...actual,
		initObservability,
	};
});
vi.mock("@repo/observability/http-server", () => ({
	registerHttpServerShutdown,
}));

beforeEach(() => vi.clearAllMocks());

function startTestServer(name: string) {
	return createUnifiedServer(
		{
			name,
			description: "Test agent",
			baseUrl: "http://localhost:3000",
			port: 3000,
			skills: [],
			supportsStreaming: true,
		},
		async () => ({ response: "ok" }),
		(output) => ({
			response:
				typeof output.response === "string" ? output.response : "",
		}),
	).start();
}

describe("unified-server shutdown wiring", () => {
	it("turns off observability's own hooks and registers shutdown with a 25s deadline", async () => {
		const mockServer = { close: vi.fn() };
		serve.mockReturnValueOnce(mockServer);

		await startTestServer("test-agent");

		expect(initObservability).toHaveBeenCalledWith({
			serviceName: "test-agent",
			serviceVersion: "1.0.0",
			environment: process.env.NODE_ENV,
			registerShutdownHooks: false,
		});
		expect(registerHttpServerShutdown).toHaveBeenCalledWith(
			mockServer,
			undefined,
			{ deadlineMs: 25_000 },
		);
	});

	it("starts the server even if initObservability throws", async () => {
		const mockServer = { close: vi.fn() };
		serve.mockReturnValueOnce(mockServer);
		initObservability.mockImplementationOnce(() => {
			throw new Error("Telemetry init failure");
		});

		await expect(
			startTestServer("test-agent-resilient"),
		).resolves.toBeUndefined();
		expect(serve).toHaveBeenCalledTimes(1);
		expect(registerHttpServerShutdown).toHaveBeenCalledWith(
			mockServer,
			undefined,
			{
				deadlineMs: 25_000,
			},
		);
	});
});
