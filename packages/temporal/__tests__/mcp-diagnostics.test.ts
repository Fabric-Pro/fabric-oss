import { describe, expect, it } from "vitest";
import {
	buildNoToolsErrorMessage,
	classifyConnectionError,
	classifyToolOutcome,
	deriveProviders,
	redactMessage,
} from "../src/activities/template-instance/mcp-diagnostics";

describe("classifyConnectionError", () => {
	it("classifies 401/unauthorized as auth_failed", () => {
		expect(
			classifyConnectionError(
				new Error("Request failed: 401 Unauthorized"),
			),
		).toBe("auth_failed");
		expect(classifyConnectionError(new Error("token expired"))).toBe(
			"auth_failed",
		);
		expect(classifyConnectionError(new Error("403 Forbidden"))).toBe(
			"auth_failed",
		);
	});
	it("classifies network errors as unreachable", () => {
		expect(
			classifyConnectionError(
				new Error("connect ECONNREFUSED 127.0.0.1:8080"),
			),
		).toBe("unreachable");
		expect(classifyConnectionError(new Error("request timed out"))).toBe(
			"unreachable",
		);
		expect(
			classifyConnectionError(new Error("getaddrinfo ENOTFOUND host")),
		).toBe("unreachable");
	});
	it("falls back to error for anything else", () => {
		expect(classifyConnectionError(new Error("boom"))).toBe("error");
		expect(classifyConnectionError("weird string")).toBe("error");
	});
	it("does not false-positive on auth-adjacent words in non-auth errors", () => {
		expect(
			classifyConnectionError(
				new Error("Authorization server returned 500"),
			),
		).toBe("error");
	});
	it("classifies the real OAuth-expiry message as auth_failed", () => {
		expect(
			classifyConnectionError(
				new Error(
					'OAuth authorization required for "GitHub". Please authenticate in MCP Settings.',
				),
			),
		).toBe("auth_failed");
	});
	it("classifies hyphen/underscore token forms as auth_failed", () => {
		expect(classifyConnectionError(new Error("token-expired"))).toBe(
			"auth_failed",
		);
		expect(classifyConnectionError(new Error("token_expired"))).toBe(
			"auth_failed",
		);
	});
	it("prefers typed McpClientError fields over message text", () => {
		// isAuthError wins even when the message looks generic.
		expect(
			classifyConnectionError({ isAuthError: true, message: "boom" }),
		).toBe("auth_failed");
		expect(classifyConnectionError({ code: "CONNECTION_TIMEOUT" })).toBe(
			"unreachable",
		);
		expect(
			classifyConnectionError({ code: "OAUTH_CONNECTION_ERROR" }),
		).toBe("unreachable");
	});
});

describe("redactMessage", () => {
	it("redacts secret-like key=value pairs", () => {
		expect(redactMessage("token=abc123 failed")).toContain("[REDACTED]");
		expect(redactMessage("api_key: sk-xyz")).toContain("[REDACTED]");
	});
	it("does not mangle innocent words ending in a secret keyword", () => {
		expect(redactMessage("monkey=123 not found")).toBe(
			"monkey=123 not found",
		);
	});
	it("redacts separator-prefixed key forms (signing_key, private_key)", () => {
		const out = redactMessage("auth failed: signing_key=SuperSecret123");
		expect(out).toContain("[REDACTED]");
		expect(out).not.toContain("SuperSecret123");
		expect(redactMessage("private-key: abcdef")).toContain("[REDACTED]");
	});
});

describe("deriveProviders", () => {
	it("dedupes and drops unknowns, preferring provider then mcpServerKey", () => {
		expect(
			deriveProviders([
				{ provider: "github" },
				{ config: { mcpServerKey: "slack" } },
				{ provider: "github" },
				{},
			]),
		).toEqual(["github", "slack"]);
	});
});

describe("classifyToolOutcome", () => {
	it("maps counts to outcomes", () => {
		expect(classifyToolOutcome(5, 2)).toBe("connected");
		expect(classifyToolOutcome(0, 0)).toBe("zero_tools");
		expect(classifyToolOutcome(3, 0)).toBe("no_read_only_tools");
	});
});

describe("buildNoToolsErrorMessage", () => {
	it("summarizes per-server failures with reasons", () => {
		const msg = buildNoToolsErrorMessage([
			{
				configId: "a",
				serverName: "GitHub",
				provider: "github",
				outcome: "auth_failed",
				toolCount: 0,
				readOnlyToolCount: 0,
			},
			{
				configId: "b",
				serverName: "Slack",
				provider: "slack",
				outcome: "unreachable",
				toolCount: 0,
				readOnlyToolCount: 0,
			},
		]);
		expect(msg).toContain("GitHub");
		expect(msg).toContain("authentication expired");
		expect(msg).toContain("Slack");
		expect(msg).toContain("unreachable");
		expect(msg).not.toContain("No read-only tools available");
	});
	it("handles the no-configs-bound case distinctly", () => {
		expect(buildNoToolsErrorMessage([])).toMatch(
			/no data sources are connected/i,
		);
	});
	it("does not leak a raw config id when a config is unresolvable (serverName fell back to the id)", () => {
		const configId = "cmnj4fcfm000i04l5s69i0gil";
		const msg = buildNoToolsErrorMessage([
			{
				configId,
				serverName: configId,
				outcome: "error",
				toolCount: 0,
				readOnlyToolCount: 0,
			},
		]);
		expect(msg).not.toContain(configId);
		expect(msg).toContain("a data source");
		expect(msg).toContain("connection error");
	});
});
