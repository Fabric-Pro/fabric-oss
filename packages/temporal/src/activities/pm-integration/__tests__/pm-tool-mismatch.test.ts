import { describe, expect, it } from "vitest";

import {
	belongsToCurrentKnownTool,
	belongsToDifferentKnownTool,
	detectExternalLinkMismatch,
	hostsShareRegistrableDomain,
	safeHost,
} from "../pm-tool-mismatch";

describe("safeHost", () => {
	it("lowercases the hostname", () => {
		expect(safeHost("https://APP.FIZZY.DO/cards/1")).toBe("app.fizzy.do");
	});

	it("returns null for malformed URLs", () => {
		expect(safeHost("not a url")).toBeNull();
	});
});

describe("belongsToDifferentKnownTool", () => {
	it("detects fizzy host vs azure-devops type", () => {
		expect(
			belongsToDifferentKnownTool("app.fizzy.do", "azure-devops"),
		).toBe(true);
	});

	it("does not flag a host matching the current tool", () => {
		expect(
			belongsToDifferentKnownTool("dev.azure.com", "azure-devops"),
		).toBe(false);
	});

	it("does not flag an unknown host", () => {
		expect(
			belongsToDifferentKnownTool("custom.example.com", "azure-devops"),
		).toBe(false);
	});
});

describe("belongsToCurrentKnownTool", () => {
	it("matches the current tool's primary host pattern", () => {
		expect(belongsToCurrentKnownTool("app.fizzy.do", "fizzy")).toBe(true);
	});

	it("matches subdomains of the current tool's pattern", () => {
		expect(belongsToCurrentKnownTool("dev.azure.com", "azure-devops")).toBe(
			true,
		);
	});

	it("rejects hosts that don't match the current tool", () => {
		expect(belongsToCurrentKnownTool("app.fizzy.do", "azure-devops")).toBe(
			false,
		);
	});

	it("returns false for an unknown current tool type", () => {
		expect(belongsToCurrentKnownTool("app.fizzy.do", "unknown-tool")).toBe(
			false,
		);
	});
});

describe("hostsShareRegistrableDomain", () => {
	it("matches subdomain variants of the same instance", () => {
		expect(
			hostsShareRegistrableDomain("www.github.com", "github.com"),
		).toBe(true);
	});

	it("rejects entirely different domains", () => {
		expect(
			hostsShareRegistrableDomain("dev.azure.com", "app.fizzy.do"),
		).toBe(false);
	});
});

describe("detectExternalLinkMismatch", () => {
	const baseInput = {
		externalId: null,
		externalUrl: null,
		externalMcpServerId: null,
		activeServerId: "mcp-ado",
		currentDetectedType: "azure-devops",
		currentBaseUrl: null,
	};

	it("returns ok when no externalId is set", () => {
		expect(detectExternalLinkMismatch(baseInput).resolution).toBe("ok");
	});

	it("blocks when externalMcpServerId differs from activeServerId", () => {
		const result = detectExternalLinkMismatch({
			...baseInput,
			externalId: "1101",
			externalUrl: "https://app.fizzy.do/cards/1101",
			externalMcpServerId: "mcp-fizzy",
		});
		expect(result.resolution).toBe("block");
	});

	it("clears legacy fizzy.do URL when current tool is azure-devops", () => {
		const result = detectExternalLinkMismatch({
			...baseInput,
			externalId: "03fzkovwwbnhh82sk1hfprp7p",
			externalUrl: "https://app.fizzy.do/000000/cards/1075",
			externalMcpServerId: null,
		});
		expect(result.resolution).toBe("clear");
	});

	it("clears legacy link when baseUrl host doesn't match (custom self-hosted)", () => {
		const result = detectExternalLinkMismatch({
			...baseInput,
			currentDetectedType: undefined,
			currentBaseUrl: "https://my-jira.internal.example.com",
			externalId: "OLD-1",
			externalUrl: "https://old-system.somewhere-else.com/ticket/OLD-1",
			externalMcpServerId: null,
		});
		expect(result.resolution).toBe("clear");
	});

	it("keeps numeric ADO id when URL host matches current tool (no false-positive)", () => {
		const result = detectExternalLinkMismatch({
			...baseInput,
			externalId: "99",
			externalUrl:
				"https://dev.azure.com/example-org/proj/_workitems/edit/99",
			externalMcpServerId: null,
		});
		expect(result.resolution).toBe("ok");
	});

	it("keeps the link when externalMcpServerId matches activeServerId", () => {
		const result = detectExternalLinkMismatch({
			...baseInput,
			externalId: "1234",
			externalUrl:
				"https://dev.azure.com/example-org/proj/_workitems/edit/1234",
			externalMcpServerId: "mcp-ado",
		});
		expect(result.resolution).toBe("ok");
	});

	it("keeps legacy Fizzy link when MCP proxy host differs from card URL host (same-tool short-circuit)", () => {
		// Staging configuration: MCP config baseUrl is the Fizzy proxy
		// (fizzy.fabric.pro) but card URLs returned by Fizzy live under
		// app.fizzy.do. Pre-shortcircuit, the secondary baseUrl check would
		// flip this to `clear`, silently re-creating the card on every push.
		const result = detectExternalLinkMismatch({
			...baseInput,
			activeServerId: "mcp-fizzy",
			currentDetectedType: "fizzy",
			currentBaseUrl: "https://fizzy.fabric.pro/mcp",
			externalId: "03fzkovwwbnhh82sk1hfprp7p",
			externalUrl: "https://app.fizzy.do/000000/cards/1075",
			externalMcpServerId: null,
		});
		expect(result.resolution).toBe("ok");
	});
});
