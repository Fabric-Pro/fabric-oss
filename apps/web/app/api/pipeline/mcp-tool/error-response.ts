import { MCPClientError, McpClientError } from "@repo/mcp";
import { NextResponse } from "next/server";

export class McpToolResultError extends Error {}

/** Browser callers display error: use fixed text or tool text bounded to 500 characters. Details stay in server logs. */
export function errorResponse(
	error: unknown,
	stage: "connect" | "execute" | "other",
) {
	if (error instanceof McpToolResultError) {
		return NextResponse.json(
			{ error: error.message.slice(0, 500), code: "TOOL_ERROR" },
			{ status: 422 },
		);
	}
	if (
		stage === "execute" &&
		!(error instanceof McpClientError && error.isAuthError) &&
		((MCPClientError.isInstance(error) && typeof error.code === "number") ||
			(error instanceof McpClientError &&
				error.code === "MCP_CALL_FAILED"))
	) {
		return NextResponse.json(
			{
				error: error.message
					.replace(/^MCP call failed: /, "")
					.slice(0, 500),
				code: "TOOL_ERROR",
			},
			{ status: 422 },
		);
	}
	if (error instanceof McpClientError) {
		let status = 502;
		let message = "Unable to connect to the MCP server.";
		if (error.isAuthError) {
			status = 401;
			message = "Please reconnect the server in MCP Settings.";
		} else if (error.isRateLimitError || error.code === "RATE_LIMIT") {
			status = 429;
			message =
				"The MCP server rate limit was reached. Please try again later.";
		} else if (
			[
				"MCP_PERMISSION_DENIED",
				"ORGANIZATION_MEMBERSHIP_REQUIRED",
			].includes(error.code)
		) {
			status = 403;
			message = "You do not have access to this MCP server.";
		} else if (error.code === "CONFIG_NOT_FOUND") {
			status = 404;
			message = "MCP configuration not found.";
		} else if (
			[
				"OAUTH_AUTH_REQUIRED",
				"CONFIG_DISABLED",
				"AUTH_FAILED",
				"API_KEY_MISSING",
				"OAUTH_ERROR",
				"INVALID_TWILIO_CREDENTIALS",
				"OAUTH_REFRESH_FAILED",
			].includes(error.code)
		) {
			status = 409;
			message = "Please reconnect the server in MCP Settings.";
		}
		return NextResponse.json(
			{
				error: message,
				code: error.code,
				serverName: error.serverName,
				retryAfter: error.retryAfter,
			},
			{ status },
		);
	}
	if (MCPClientError.isInstance(error)) {
		return NextResponse.json(
			{
				error: "Unable to connect to the MCP server.",
				code: "CONNECTION_ERROR",
			},
			{ status: 502 },
		);
	}
	return NextResponse.json(
		{
			error: "Something went wrong while using the MCP server.",
			code: "INTERNAL_ERROR",
		},
		{ status: 500 },
	);
}
