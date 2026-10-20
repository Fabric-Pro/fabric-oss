/**
 * Only the AI SDK client's own closed-connection refusal is known to come
 * before the request is written; a caller may resend on a fresh connection
 * after it without risking a second run. The same text relayed by a server or
 * by the STDIO wrapper arrives after a send.
 */
import { MCPClientError } from "@ai-sdk/mcp";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({}));

import { isClosedClientRefusedBeforeSend, McpClientError } from "../client";

const REFUSAL = "Attempted to send a request from a closed client";

describe("isClosedClientRefusedBeforeSend", () => {
	it("accepts the SDK client's refusal, which carries no JSON-RPC code", () => {
		expect(
			isClosedClientRefusedBeforeSend(
				new MCPClientError({ message: REFUSAL }),
			),
		).toBe(true);
	});

	it("rejects the same text in a server's JSON-RPC error", () => {
		expect(
			isClosedClientRefusedBeforeSend(
				new MCPClientError({ message: REFUSAL, code: -32603 }),
			),
		).toBe(false);
	});

	it("rejects the same text relayed by the STDIO wrapper", () => {
		expect(
			isClosedClientRefusedBeforeSend(
				new McpClientError({
					message: `MCP call failed: ${REFUSAL}`,
					code: "MCP_CALL_FAILED",
					serverName: "example",
				}),
			),
		).toBe(false);
	});

	it("rejects the SDK retry wrapper quoting the refusal after an earlier attempt", () => {
		expect(
			isClosedClientRefusedBeforeSend(
				new MCPClientError({
					message: `Tool call failed after 2 attempts: ${REFUSAL}`,
				}),
			),
		).toBe(false);
	});

	it("rejects a plain error and an in-flight close", () => {
		expect(isClosedClientRefusedBeforeSend(new Error(REFUSAL))).toBe(false);
		expect(
			isClosedClientRefusedBeforeSend(
				new MCPClientError({ message: "Connection closed" }),
			),
		).toBe(false);
	});
});
