/**
 * Fizzy #2249: a transport failure used to log only "TypeError: Failed to
 * fetch", which does not say which request failed. The log line now names the
 * procedure. Expected 4xx responses are no longer silent either — they go to
 * `console.warn` instead of the dev-overlay-triggering `console.error` — and
 * the server is told about the two failure shapes it never saw itself
 * (transport failures, rewrapped error pages), never about an ordinary
 * `ORPCError` its own `rpc.error` log line already covers.
 */

import { ORPCError } from "@orpc/client";
import { logRpcFailure } from "@shared/lib/rpc-failure-log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queueRpcFailureReport } = vi.hoisted(() => ({
	queueRpcFailureReport: vi.fn(),
}));

vi.mock("@shared/lib/rpc-failure-report", () => ({
	queueRpcFailureReport,
	maskRoute: (pathname: string) => pathname,
}));

describe("logRpcFailure", () => {
	let consoleError: ReturnType<typeof vi.spyOn>;
	let consoleWarn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		queueRpcFailureReport.mockReset();
	});

	afterEach(() => {
		consoleError.mockRestore();
		consoleWarn.mockRestore();
	});

	it("names the procedure on a transport failure, and reports it — the API never saw it", () => {
		const error = new TypeError("Failed to fetch");

		logRpcFailure(error, ["prompts", "catalog", "list"]);

		expect(consoleError).toHaveBeenCalledWith(
			"oRPC prompts/catalog/list failed:",
			error,
		);
		expect(queueRpcFailureReport).toHaveBeenCalledWith({
			procedure: "prompts/catalog/list",
			kind: "transport",
			route: "/",
		});
	});

	it("keeps the server's error, message included, on a server error — and does not report it (the API's own rpc.error line already covers it)", () => {
		const error = new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "Failed to fetch prompt",
		});

		logRpcFailure(error, ["prompts", "get", "byId"]);

		expect(consoleError).toHaveBeenCalledWith(
			"oRPC prompts/get/byId failed:",
			error,
		);
		expect(queueRpcFailureReport).not.toHaveBeenCalled();
	});

	it("warns (not silently, not console.error) for an expected 4xx the consumer handles, and does not report it", () => {
		logRpcFailure(new ORPCError("NOT_FOUND"), ["prompts", "get", "byId"]);
		logRpcFailure(new ORPCError("FORBIDDEN"), ["billing", "status"]);

		expect(consoleError).not.toHaveBeenCalled();
		expect(consoleWarn).toHaveBeenCalledWith(
			"oRPC prompts/get/byId failed:",
			{ procedure: "prompts/get/byId", code: "NOT_FOUND" },
			expect.any(ORPCError),
		);
		expect(consoleWarn).toHaveBeenCalledWith(
			"oRPC billing/status failed:",
			{ procedure: "billing/status", code: "FORBIDDEN" },
			expect.any(ORPCError),
		);
		expect(queueRpcFailureReport).not.toHaveBeenCalled();
	});

	it("stays silent for an aborted request, and does not report it", () => {
		const error = new DOMException(
			"The operation was aborted.",
			"AbortError",
		);

		logRpcFailure(error, ["prompts", "list"]);

		expect(consoleError).not.toHaveBeenCalled();
		expect(consoleWarn).not.toHaveBeenCalled();
		expect(queueRpcFailureReport).not.toHaveBeenCalled();
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

	it("logs a proxy error page's text, while the error message stays the generic one", async () => {
		const { orpcClient } = await import("@shared/lib/orpc-client");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("<html><body>502 Bad Gateway upstream</body></html>", {
				status: 502,
				headers: { "Content-Type": "text/html" },
			}),
		);

		const call = orpcClient.prompts.list({ organizationId: null });
		await expect(call).rejects.toMatchObject({
			code: "BAD_GATEWAY",
			message: "Bad Gateway",
		});

		expect(consoleError).toHaveBeenCalledWith(
			"oRPC prompts/list failed:",
			expect.objectContaining({ code: "BAD_GATEWAY" }),
			"Server response: <html><body>502 Bad Gateway upstream</body></html>",
		);
		// The API's own handler never ran for this one (it's a rewrapped
		// proxy page) — reported as "error-page" even though BAD_GATEWAY
		// looks 4xx-adjacent in spirit; it is not one of our own codes.
		expect(queueRpcFailureReport).toHaveBeenCalledWith({
			procedure: "prompts/list",
			kind: "error-page",
			status: 502,
			code: "BAD_GATEWAY",
			route: "/",
		});
		fetchSpy.mockRestore();
	});

	it("keeps the API's own error message, with no extra response text", async () => {
		const { orpcClient } = await import("@shared/lib/orpc-client");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					json: {
						defined: false,
						code: "INTERNAL_SERVER_ERROR",
						status: 500,
						message: "Failed to list prompts: db timeout",
					},
					meta: [],
				}),
				{
					status: 500,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		await expect(
			orpcClient.prompts.list({ organizationId: null }),
		).rejects.toMatchObject({
			message: "Failed to list prompts: db timeout",
		});

		expect(consoleError).toHaveBeenCalledWith(
			"oRPC prompts/list failed:",
			expect.objectContaining({
				message: "Failed to list prompts: db timeout",
			}),
		);
		// The API's own rpc.error log line already covers this — an ordinary
		// server error, not a shape the server never saw.
		expect(queueRpcFailureReport).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it("reports a rewrapped page as error-page even when its derived code matches an expected-4xx one", async () => {
		// A proxy 404 page shares NOT_FOUND's code by coincidence of status,
		// but the API's own handler never ran — this must still report,
		// unlike a genuine NOT_FOUND from the API (which the warn-only test
		// above covers).
		const { orpcClient } = await import("@shared/lib/orpc-client");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("<html><body>404 Not Found</body></html>", {
				status: 404,
				headers: { "Content-Type": "text/html" },
			}),
		);

		await expect(
			orpcClient.prompts.list({ organizationId: null }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(consoleError).toHaveBeenCalledWith(
			"oRPC prompts/list failed:",
			expect.objectContaining({ code: "NOT_FOUND" }),
			"Server response: <html><body>404 Not Found</body></html>",
		);
		expect(consoleWarn).not.toHaveBeenCalled();
		expect(queueRpcFailureReport).toHaveBeenCalledWith({
			procedure: "prompts/list",
			kind: "error-page",
			status: 404,
			code: "NOT_FOUND",
			route: "/",
		});
		fetchSpy.mockRestore();
	});

	it("still resolves a successful response untouched", async () => {
		const { orpcClient } = await import("@shared/lib/orpc-client");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ json: { entries: [] }, meta: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(
			orpcClient.prompts.catalog.list({ organizationId: null }),
		).resolves.toEqual({ entries: [] });
		expect(consoleError).not.toHaveBeenCalled();
		expect(queueRpcFailureReport).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});
});
