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

	it("blocks a different target on the same server, preserving null compatibility", () => {
		const input = {
			...baseInput,
			externalId: "123",
			externalMcpServerId: "mcp-ado",
		};
		expect(
			detectExternalLinkMismatch({
				...input,
				externalPmTarget: 'pmt1:["srv-1","a","example-container"]',
				activePmTarget: 'pmt1:["srv-1","b","example-container"]',
			}).resolution,
		).toBe("block");
		for (const [externalPmTarget, activePmTarget] of [
			[null, 'pmt1:["srv-1","b","example-container"]'],
			['pmt1:["srv-1","a","example-container"]', null],
			[
				'pmt1:["srv-1","a","example-container"]',
				'pmt1:["srv-1","a","example-container"]',
			],
		]) {
			expect(
				detectExternalLinkMismatch({
					...input,
					externalPmTarget,
					activePmTarget,
				}).resolution,
			).toBe("ok");
		}
	});

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

	it("flags a legacy fizzy.do URL when current tool is azure-devops", () => {
		const result = detectExternalLinkMismatch({
			...baseInput,
			externalId: "03fzkovwwbnhh82sk1hfprp7p",
			externalUrl: "https://app.fizzy.do/000000/cards/1075",
			externalMcpServerId: null,
		});
		expect(result.resolution).toBe("legacy-other-tool");
	});

	it("flags a legacy link when baseUrl host doesn't match (custom self-hosted)", () => {
		const result = detectExternalLinkMismatch({
			...baseInput,
			currentDetectedType: undefined,
			currentBaseUrl: "https://my-jira.internal.example.com",
			externalId: "OLD-1",
			externalUrl: "https://old-system.somewhere-else.com/ticket/OLD-1",
			externalMcpServerId: null,
		});
		expect(result.resolution).toBe("legacy-other-tool");
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

describe("detectExternalLinkMismatch with a known instance (currentInstanceOrigin)", () => {
	const selfHosted = {
		externalMcpServerId: null,
		activeServerId: "srv-gitlab",
		currentDetectedType: "gitlab",
		currentBaseUrl: "https://gitlab.example.com/api/v4",
		currentInstanceOrigin: "https://gitlab.example.com",
	};

	it("a gitlab.com link is not this self-hosted instance's issue", () => {
		const result = detectExternalLinkMismatch({
			...selfHosted,
			externalId: "77",
			externalUrl: "https://gitlab.com/example/project/-/issues/77",
		});
		expect(result.resolution).toBe("legacy-other-tool");
	});

	it("a self-hosted link is not gitlab.com's issue", () => {
		const result = detectExternalLinkMismatch({
			...selfHosted,
			currentBaseUrl: "https://gitlab.com/api/v4",
			currentInstanceOrigin: "https://gitlab.com",
			externalId: "77",
			externalUrl:
				"https://gitlab.example.com/example/project/-/issues/77",
		});
		expect(result.resolution).toBe("legacy-other-tool");
	});

	it("a link on the instance is used (origin compared case-insensitively)", () => {
		const result = detectExternalLinkMismatch({
			...selfHosted,
			externalId: "42",
			externalUrl:
				"https://GitLab.Example.com/example/project/-/issues/42",
		});
		expect(result.resolution).toBe("ok");
	});

	it("a subdomain or another port of the instance is another instance", () => {
		for (const externalUrl of [
			"https://www.gitlab.example.com/example/project/-/issues/42",
			"https://gitlab.example.com:8443/example/project/-/issues/42",
		]) {
			expect(
				detectExternalLinkMismatch({
					...selfHosted,
					externalId: "42",
					externalUrl,
				}).resolution,
			).toBe("legacy-other-tool");
		}
	});

	it("a link with no URL, or an unreadable one, cannot be placed on the instance", () => {
		for (const externalUrl of [null, undefined, "", "not a url"]) {
			expect(
				detectExternalLinkMismatch({
					...selfHosted,
					externalId: "42",
					externalUrl,
				}).resolution,
			).toBe("legacy-other-tool");
		}
	});

	it("an unresolved instance (null) refuses every unstamped link", () => {
		const result = detectExternalLinkMismatch({
			...selfHosted,
			currentInstanceOrigin: null,
			externalId: "42",
			externalUrl:
				"https://gitlab.example.com/example/project/-/issues/42",
		});
		expect(result.resolution).toBe("legacy-other-tool");
	});

	it("a stamped link and a row with no link are not judged by instance", () => {
		expect(
			detectExternalLinkMismatch({
				...selfHosted,
				externalMcpServerId: "srv-gitlab",
				externalId: "42",
				externalUrl: null,
			}).resolution,
		).toBe("ok");
		expect(
			detectExternalLinkMismatch({
				...selfHosted,
				externalId: null,
				externalUrl: null,
			}).resolution,
		).toBe("ok");
	});
});
