import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Runtime } from "@temporalio/worker";
import { afterEach, expect, it, vi } from "vitest";
import config from "../vitest.config";
import { pinnedTimeSkippingOptions } from "../vitest.setup";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

// Importing ../vitest.setup above installs the patch in this file alone, so
// the boundary test below cannot show that the other suites get it. This does.
it("loads the pin for every suite in this package", () => {
	expect(config.test?.setupFiles).toContain("./vitest.setup.ts");
});

it("replaces an unpinned download while retaining server and client options", () => {
	vi.stubEnv("TEMPORAL_TEST_SERVER_PATH", "");
	expect(pinnedTimeSkippingOptions()?.server?.executable).toEqual({
		type: "cached-download",
		version: "v1.40.0",
	});
	const options = {
		server: {
			port: 12345,
			executable: {
				type: "cached-download" as const,
				version: "default",
				downloadDir: "/tmp/example-temporal-download",
			},
		},
		client: { identity: "example-client" },
	};
	expect(pinnedTimeSkippingOptions(options)).toEqual({
		...options,
		server: {
			...options.server,
			executable: { ...options.server.executable, version: "v1.40.0" },
		},
	});
});

it("uses the environment path ahead of a caller's download options", () => {
	vi.stubEnv("TEMPORAL_TEST_SERVER_PATH", "/tmp/example-test-server");
	expect(pinnedTimeSkippingOptions()?.server?.executable).toEqual({
		type: "existing-path",
		path: "/tmp/example-test-server",
	});
});

it("retains an explicit existing path when no environment override is set", () => {
	vi.stubEnv("TEMPORAL_TEST_SERVER_PATH", "");
	const executable = {
		type: "existing-path" as const,
		path: "/tmp/example-server",
	};
	expect(
		pinnedTimeSkippingOptions({ server: { executable } })?.server
			?.executable,
	).toEqual(executable);
});

it("applies the pin at the SDK boundary before starting a server", async () => {
	vi.stubEnv("TEMPORAL_TEST_SERVER_PATH", "");
	const stopped = new Error("example: stop before launching the test server");
	const createEphemeralServer = vi.fn().mockRejectedValue(stopped);
	vi.spyOn(Runtime, "instance").mockReturnValue({
		createEphemeralServer,
	} as unknown as Runtime);
	await expect(TestWorkflowEnvironment.createTimeSkipping()).rejects.toThrow(
		stopped,
	);
	expect(createEphemeralServer).toHaveBeenCalledWith(
		expect.objectContaining({
			type: "time-skipping",
			exe: expect.objectContaining({
				type: "cached-download",
				version: "v1.40.0",
			}),
		}),
	);
});
