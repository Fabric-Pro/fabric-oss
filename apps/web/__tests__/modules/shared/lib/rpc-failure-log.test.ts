/**
 * Fizzy #2249: a transport failure used to log only "TypeError: Failed to
 * fetch", which does not say which request failed. The log line now names the
 * procedure; expected 4xx responses stay silent.
 */

import { ORPCError } from "@orpc/client";
import { logRpcFailure } from "@shared/lib/rpc-failure-log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("logRpcFailure", () => {
	let consoleError: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleError.mockRestore();
	});

	it("names the procedure on a transport failure", () => {
		const error = new TypeError("Failed to fetch");

		logRpcFailure(error, ["prompts", "catalog", "list"]);

		expect(consoleError).toHaveBeenCalledWith(
			"oRPC prompts/catalog/list failed:",
			error,
		);
	});

	it("keeps the server's error, message included, on a server error", () => {
		const error = new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "Failed to fetch prompt",
		});

		logRpcFailure(error, ["prompts", "get", "byId"]);

		expect(consoleError).toHaveBeenCalledWith(
			"oRPC prompts/get/byId failed:",
			error,
		);
	});

	it("stays silent for an expected 4xx the consumer handles", () => {
		logRpcFailure(new ORPCError("NOT_FOUND"), ["prompts", "get", "byId"]);
		logRpcFailure(new ORPCError("FORBIDDEN"), ["billing", "status"]);

		expect(consoleError).not.toHaveBeenCalled();
	});

	it("stays silent for an aborted request", () => {
		const error = new DOMException(
			"The operation was aborted.",
			"AbortError",
		);

		logRpcFailure(error, ["prompts", "list"]);

		expect(consoleError).not.toHaveBeenCalled();
	});

	it("is what the real client logs when a call fails in transport", async () => {
		const { orpcClient } = await import("@shared/lib/orpc-client");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new TypeError("Failed to fetch"));

		await expect(
			orpcClient.prompts.catalog.list({ organizationId: null }),
		).rejects.toThrow("Failed to fetch");

		expect(consoleError).toHaveBeenCalledWith(
			"oRPC prompts/catalog/list failed:",
			expect.any(TypeError),
		);
		fetchSpy.mockRestore();
	});
});
