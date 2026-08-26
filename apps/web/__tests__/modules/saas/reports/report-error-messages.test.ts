import { humanizeReportError } from "@saas/reports/lib/report-error-messages";
import { describe, expect, it } from "vitest";

describe("humanizeReportError", () => {
	it("returns a context-specific generic message for empty/missing input", () => {
		expect(humanizeReportError("", "generate")).toMatch(
			/generating this report/i,
		);
		expect(humanizeReportError(null, "save")).toMatch(/save your changes/i);
		expect(humanizeReportError(undefined, "delete")).toMatch(
			/delete this report/i,
		);
		expect(humanizeReportError("   ", "test")).toMatch(
			/test the connection/i,
		);
	});

	it("maps auth/expired-token errors to the two-step reconnect guidance", () => {
		for (const raw of [
			"401 Unauthorized",
			"invalid_token",
			"The access token has expired",
			"Authentication failed for MCP server",
		]) {
			const msg = humanizeReportError(raw, "generate");
			expect(msg).toMatch(/reconnect/i);
			expect(msg).toMatch(/step 2/i);
			expect(msg).toMatch(/re-select your project/i);
		}
	});

	it("maps network/timeout errors to an 'unreachable, try again' message", () => {
		for (const raw of [
			"ETIMEDOUT",
			"connection timed out",
			"503 Service Unavailable",
			"fetch failed",
		]) {
			expect(humanizeReportError(raw, "generate")).toMatch(
				/couldn’t reach|try again shortly/i,
			);
		}
	});

	it("maps rate-limit / out-of-credits errors", () => {
		expect(
			humanizeReportError("429 Too Many Requests", "generate"),
		).toMatch(/rate-limited|out of credits/i);
		expect(humanizeReportError("insufficient credits", "generate")).toMatch(
			/rate-limited|out of credits/i,
		);
	});

	it("never leaks raw technical strings — falls back to the safe generic message", () => {
		for (const raw of [
			"TypeError: Cannot read properties of undefined (reading 'foo')",
			"Error: ECONNRESET at TLSSocket.onConnectEnd (node:_tls_wrap:1234:5)",
			"Temporal workflow execution failed: activity ReportAgentLoop timed out",
			"at Object.<anonymous> (/app/packages/temporal/src/x.ts:10:5)",
		]) {
			const msg = humanizeReportError(raw, "generate");
			expect(msg).not.toContain(raw);
			// no obvious technical tokens leak through
			expect(msg).not.toMatch(
				/TypeError|node:|\.ts:|TLSSocket|<anonymous>/,
			);
		}
	});

	it("lets a short, clean validation message through unchanged", () => {
		expect(
			humanizeReportError("Project Name is required", "generate"),
		).toBe("Project Name is required");
	});

	it("falls back to generic for an over-long message even if it looks clean", () => {
		const long = `${"please try again ".repeat(20)}`.trim();
		expect(humanizeReportError(long, "generate")).toMatch(
			/generating this report/i,
		);
	});

	it("maps the save-time 'No access to MCP config' error to re-select guidance, without leaking the config id", () => {
		const raw =
			'Invalid connections: No access to MCP config "cmnj4fcfm000i04l5s69i0gil" for binding "task-board"';
		const msg = humanizeReportError(raw, "save");
		expect(msg).toMatch(/no longer available/i);
		expect(msg).toMatch(/re-select/i);
		expect(msg).not.toContain("cmnj4fcfm000i04l5s69i0gil");
	});

	it("maps the run-time 'MCP configuration not found' error to re-select guidance", () => {
		const msg = humanizeReportError(
			"MCP configuration not found. Please configure your MCP server in Settings.",
			"generate",
		);
		expect(msg).toMatch(/no longer available|re-select/i);
	});

	it("maps the 'no usable read-only tools' run failure to actionable copy (not raw)", () => {
		const raw =
			"Report generation found no usable read-only tools across 2 data sources: a data source — connection error; a data source — connection error.";
		const msg = humanizeReportError(raw, "generate");
		expect(msg).not.toBe(raw);
		expect(msg).toMatch(/reconnect|re-select|data source/i);
	});

	it("never leaks an opaque cuid config/instance id, even when no known pattern matches", () => {
		const raw = "Unexpected state for cmnj4fcfm000i04l5s69i0gil at step 3";
		const msg = humanizeReportError(raw, "generate");
		expect(msg).not.toContain("cmnj4fcfm000i04l5s69i0gil");
		expect(msg).toMatch(/generating this report/i);
	});
});
