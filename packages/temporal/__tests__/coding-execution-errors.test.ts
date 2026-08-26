import { describe, expect, it } from "vitest";
import {
	AuthError,
	NetworkError,
	PortUnavailableError,
	ProviderError,
	RateLimitError,
	RuntimeNotFoundError,
	SessionValidationError,
	TimeoutError,
	toProviderError,
	WorkspaceError,
} from "../src/lib/coding-execution/errors";

describe("coding execution errors", () => {
	describe("ProviderError", () => {
		it("creates a base error with all properties", () => {
			const cause = new Error("original error");
			const error = new ProviderError(
				"Something went wrong",
				"BACKGROUND_AGENTS",
				"UNKNOWN",
				cause,
			);

			expect(error.message).toBe("Something went wrong");
			expect(error.provider).toBe("BACKGROUND_AGENTS");
			expect(error.code).toBe("UNKNOWN");
			expect(error.cause).toBe(cause);
			expect(error.name).toBe("ProviderError");
		});

		it("serializes to JSON for logging", () => {
			const error = new ProviderError(
				"Test error",
				"KANBAN_LOCAL",
				"NETWORK_ERROR",
			);

			const json = error.toJSON();
			expect(json).toMatchObject({
				name: "ProviderError",
				message: "Test error",
				provider: "KANBAN_LOCAL",
				code: "NETWORK_ERROR",
			});
			expect(json.stack).toBeDefined();
		});
	});

	describe("AuthError", () => {
		it("creates an authentication error", () => {
			const error = new AuthError("BACKGROUND_AGENTS", "Invalid token");

			expect(error.message).toBe("Invalid token");
			expect(error.provider).toBe("BACKGROUND_AGENTS");
			expect(error.code).toBe("AUTH_FAILED");
			expect(error.name).toBe("AuthError");
		});

		it("uses default message when not provided", () => {
			const error = new AuthError("KANBAN_LOCAL");
			expect(error.message).toBe("Authentication failed");
		});
	});

	describe("NetworkError", () => {
		it("creates a network error with status code", () => {
			const cause = new Error("Connection refused");
			const error = new NetworkError(
				"BACKGROUND_AGENTS",
				"https://api.example.com/sessions",
				503,
				cause,
			);

			expect(error.message).toContain("503");
			expect(error.message).toContain("https://api.example.com/sessions");
			expect(error.url).toBe("https://api.example.com/sessions");
			expect(error.statusCode).toBe(503);
			expect(error.cause).toBe(cause);
		});

		it("creates a network error without status code", () => {
			const error = new NetworkError(
				"KANBAN_LOCAL",
				"http://127.0.0.1:3484/api/trpc",
			);

			expect(error.message).toContain("Network request failed");
			expect(error.message).toContain("http://127.0.0.1:3484/api/trpc");
			expect(error.statusCode).toBeUndefined();
		});
	});

	describe("TimeoutError", () => {
		it("creates a timeout error with operation details", () => {
			const error = new TimeoutError(
				"KANBAN_LOCAL",
				"Runtime startup",
				20000,
			);

			expect(error.message).toBe(
				"Runtime startup timed out after 20000ms",
			);
			expect(error.operation).toBe("Runtime startup");
			expect(error.timeoutMs).toBe(20000);
			expect(error.code).toBe("TIMEOUT");
		});
	});

	describe("PortUnavailableError", () => {
		it("creates a port unavailable error", () => {
			const error = new PortUnavailableError("KANBAN_LOCAL", 3484, 50);

			expect(error.message).toContain("3484");
			expect(error.message).toContain("50");
			expect(error.startPort).toBe(3484);
			expect(error.attempts).toBe(50);
			expect(error.code).toBe("PORT_UNAVAILABLE");
		});
	});

	describe("RuntimeNotFoundError", () => {
		it("creates a runtime not found error", () => {
			const error = new RuntimeNotFoundError(
				"KANBAN_LOCAL",
				"vibe-kanban (run with: npx vibe-kanban)",
			);

			expect(error.message).toContain("vibe-kanban");
			expect(error.message).toContain("install");
			expect(error.command).toBe(
				"vibe-kanban (run with: npx vibe-kanban)",
			);
			expect(error.code).toBe("RUNTIME_NOT_FOUND");
		});
	});

	describe("SessionValidationError", () => {
		it("creates a validation error", () => {
			const cause = new Error("Invalid JSON");
			const error = new SessionValidationError(
				"BACKGROUND_AGENTS",
				"Invalid session ID format",
				cause,
			);

			expect(error.message).toBe("Invalid session ID format");
			expect(error.cause).toBe(cause);
			expect(error.code).toBe("VALIDATION_ERROR");
		});
	});

	describe("WorkspaceError", () => {
		it("creates a workspace error with ID", () => {
			const error = new WorkspaceError(
				"KANBAN_LOCAL",
				"Failed to create workspace",
				"ws-123",
			);

			expect(error.message).toBe("Failed to create workspace");
			expect(error.workspaceId).toBe("ws-123");
			expect(error.code).toBe("WORKSPACE_ERROR");
		});
	});

	describe("RateLimitError", () => {
		it("creates a rate limit error with retry info", () => {
			const error = new RateLimitError(
				"KANBAN_LOCAL",
				"Too many requests",
				60000,
			);

			expect(error.message).toBe("Too many requests");
			expect(error.retryAfterMs).toBe(60000);
			expect(error.code).toBe("RATE_LIMITED");
		});
	});

	describe("toProviderError", () => {
		it("returns existing ProviderError unchanged", () => {
			const original = new AuthError("BACKGROUND_AGENTS");
			const result = toProviderError(original, "KANBAN_LOCAL");

			expect(result).toBe(original);
		});

		it("wraps Error instances", () => {
			const original = new Error("Something broke");
			const result = toProviderError(
				original,
				"KANBAN_LOCAL",
				"NETWORK_ERROR",
			);

			expect(result).toBeInstanceOf(ProviderError);
			expect(result.message).toBe("Something broke");
			expect(result.provider).toBe("KANBAN_LOCAL");
			expect(result.code).toBe("NETWORK_ERROR");
			expect(result.cause).toBe(original);
		});

		it("wraps non-Error values", () => {
			const result = toProviderError("string error", "KANBAN_LOCAL");

			expect(result).toBeInstanceOf(ProviderError);
			expect(result.message).toBe("string error");
			expect(result.provider).toBe("KANBAN_LOCAL");
			expect(result.code).toBe("UNKNOWN");
		});
	});
});
