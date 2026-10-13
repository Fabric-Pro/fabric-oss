/**
 * Startup-wiring tests for `apps/web/instrumentation.ts`: OpenTelemetry,
 * Application Insights log forwarding, storage bootstrap and timing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	validatePartykitConfigMock,
	initObservabilityMock,
	initAppInsightsLogsMock,
	addLogSinkMock,
	ensureBucketsMock,
} = vi.hoisted(() => ({
	validatePartykitConfigMock: vi.fn(),
	initObservabilityMock: vi.fn(),
	initAppInsightsLogsMock: vi.fn(),
	addLogSinkMock: vi.fn(),
	ensureBucketsMock: vi.fn(),
}));

vi.mock("@repo/logs", () => ({ addLogSink: addLogSinkMock }));
vi.mock("@shared/lib/partykit-config", () => ({
	validatePartykitConfig: validatePartykitConfigMock,
}));
vi.mock("@repo/observability/init", () => ({
	initObservability: initObservabilityMock,
}));
vi.mock("@repo/observability/web-startup", () => ({
	initAppInsightsLogs: initAppInsightsLogsMock,
	trackLog: vi.fn(),
	trackLogException: vi.fn(),
}));
vi.mock("@repo/utils", () => ({
	describeEncryptionKeyMisconfiguration: vi.fn(() => null),
}));
vi.mock("@repo/storage", () => ({ ensureBuckets: ensureBucketsMock }));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { documents: "documents" } } },
}));

import { register } from "../instrumentation";

beforeEach(() => {
	validatePartykitConfigMock.mockReset();
	ensureBucketsMock.mockReset();
	vi.stubEnv("NEXT_RUNTIME", "nodejs");
	vi.stubEnv("VERCEL", "1");
	vi.stubEnv("OTEL_ENABLED", "false");
	vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("register — Application Insights log forwarding", () => {
	it("does not build the App Insights client at registration, so the proxy function skips it", async () => {
		initAppInsightsLogsMock.mockClear();

		await register();

		expect(initAppInsightsLogsMock).not.toHaveBeenCalled();
	});

	it("starts forwarding under the web app's own cloud role with the first warning", async () => {
		initAppInsightsLogsMock.mockClear();
		await register();
		const [sink] = addLogSinkMock.mock.calls.at(-1) ?? [];

		sink({ level: "warn", message: "first warning" });

		expect(initAppInsightsLogsMock).toHaveBeenCalledWith({
			cloudRoleName: "fabric.web",
		});
	});

	it("skips Azure VM usage probes on Vercel while forwarding logs", async () => {
		vi.stubEnv("APPLICATION_INSIGHTS_NO_STATSBEAT", "");

		await register();

		expect(process.env.APPLICATION_INSIGHTS_NO_STATSBEAT).toBe("true");
	});
});

describe("register — OpenTelemetry startup", () => {
	it("does not initialize OTel when explicitly disabled", async () => {
		initObservabilityMock.mockClear();
		await register();
		expect(initObservabilityMock).not.toHaveBeenCalled();
	});

	it("initializes OTel when enabled", async () => {
		vi.stubEnv("OTEL_ENABLED", "true");
		initObservabilityMock.mockClear();
		await register();
		expect(initObservabilityMock).toHaveBeenCalledWith(
			expect.objectContaining({ serviceName: "fabric-web" }),
		);
	});

	it("auto-enables OTel when an endpoint is configured", async () => {
		vi.stubEnv("OTEL_ENABLED", "");
		vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317");
		initObservabilityMock.mockClear();
		await register();
		expect(initObservabilityMock).toHaveBeenCalledOnce();
	});

	it("honors an explicit disable even when an endpoint is configured", async () => {
		vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317");
		initObservabilityMock.mockClear();
		await register();
		expect(initObservabilityMock).not.toHaveBeenCalled();
	});
});

describe("register — storage startup", () => {
	it("does not check buckets before serving a Vercel request", async () => {
		await register();
		expect(ensureBucketsMock).not.toHaveBeenCalled();
	});

	it("creates missing buckets for local MinIO", async () => {
		vi.stubEnv("VERCEL", "");
		await register();
		expect(ensureBucketsMock).toHaveBeenCalledWith(["documents"]);
	});
});

describe("register — startup timing", () => {
	it("reports successful Node registration timing without request identifiers", async () => {
		// Arrange
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(process, "uptime").mockReturnValue(12.345);
		vi.spyOn(performance, "now")
			.mockReturnValueOnce(100)
			.mockReturnValueOnce(145);

		// Act
		await register();

		// Assert
		expect(infoSpy).toHaveBeenCalledWith("Web instrumentation timing", {
			event: "web.instrumentation_timing",
			processUptimeMs: 12345,
			registerMs: 45,
		});
	});
});
