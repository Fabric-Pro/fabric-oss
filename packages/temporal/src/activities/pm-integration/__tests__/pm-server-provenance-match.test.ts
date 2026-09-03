import { describe, expect, it } from "vitest";
import {
	decideCandidate,
	deriveTrustedKey,
	extractConfigOrgKey,
	extractEntityOrgKey,
	mapKeyToPatternType,
} from "../pm-server-provenance-match";

describe("mapKeyToPatternType", () => {
	it("maps atlassian -> jira and gitlab-official -> gitlab", () => {
		expect(mapKeyToPatternType("atlassian")).toBe("jira");
		expect(mapKeyToPatternType("gitlab-official")).toBe("gitlab");
		expect(mapKeyToPatternType("github-remote")).toBe("github");
	});
	it("passes through canonical keys", () => {
		expect(mapKeyToPatternType("azure-devops")).toBe("azure-devops");
		expect(mapKeyToPatternType("fizzy")).toBe("fizzy");
	});
	it("returns null for unknown/empty keys", () => {
		expect(mapKeyToPatternType("slack-remote")).toBeNull();
		expect(mapKeyToPatternType(null)).toBeNull();
	});
});

describe("extractEntityOrgKey", () => {
	it("extracts the ADO org from dev.azure.com and visualstudio.com forms", () => {
		expect(
			extractEntityOrgKey(
				"azure-devops",
				"https://dev.azure.com/Contoso/proj/_workitems/edit/42",
			),
		).toBe("contoso");
		expect(
			extractEntityOrgKey(
				"azure-devops",
				"https://contoso.visualstudio.com/_workitems/edit/42",
			),
		).toBe("contoso");
	});
	it("uses the full host as the Jira tenant key", () => {
		expect(
			extractEntityOrgKey(
				"jira",
				"https://acme.atlassian.net/browse/PROJ-42",
			),
		).toBe("acme.atlassian.net");
	});
	it("uses the first path segment as the Fizzy workspace key", () => {
		expect(
			extractEntityOrgKey(
				"fizzy",
				"https://app.fizzy.do/000000/cards/1075",
			),
		).toBe("000000");
	});
	it("returns null for a null URL or a cross-tool host", () => {
		expect(extractEntityOrgKey("azure-devops", null)).toBeNull();
		expect(
			extractEntityOrgKey(
				"azure-devops",
				"https://acme.atlassian.net/browse/X-1",
			),
		).toBeNull();
	});
	it("returns null for a bare visualstudio.com host with no org subdomain", () => {
		expect(
			extractEntityOrgKey(
				"azure-devops",
				"https://visualstudio.com/_workitems/edit/1",
			),
		).toBeNull();
	});
	it("returns null when the ADO URL has no org segment (reserved _path)", () => {
		expect(
			extractEntityOrgKey(
				"azure-devops",
				"https://dev.azure.com/_workitems/edit/1",
			),
		).toBeNull();
	});
});

describe("extractConfigOrgKey", () => {
	it("reads the ADO org from commandArgs[0], else from baseUrl", () => {
		expect(
			extractConfigOrgKey("azure-devops", {
				commandArgs: ["Contoso"],
				baseUrl: null,
				defaultUrl: null,
				atlassianCloudSiteUrl: null,
			}),
		).toBe("contoso");
		expect(
			extractConfigOrgKey("azure-devops", {
				commandArgs: [],
				baseUrl: "https://dev.azure.com/teamA",
				defaultUrl: null,
				atlassianCloudSiteUrl: null,
			}),
		).toBe("teama");
	});
	it("reads the Jira tenant from atlassianCloudSiteUrl host", () => {
		expect(
			extractConfigOrgKey("jira", {
				commandArgs: null,
				baseUrl: null,
				defaultUrl: null,
				atlassianCloudSiteUrl: "https://acme.atlassian.net",
			}),
		).toBe("acme.atlassian.net");
	});
	it("reads the ADO org from a *.visualstudio.com baseUrl", () => {
		expect(
			extractConfigOrgKey("azure-devops", {
				commandArgs: null,
				baseUrl: "https://contoso.visualstudio.com",
				defaultUrl: null,
				atlassianCloudSiteUrl: null,
			}),
		).toBe("contoso");
	});
	it("rejects a lookalike host that merely ends in visualstudio.com", () => {
		expect(
			extractConfigOrgKey("azure-devops", {
				commandArgs: null,
				baseUrl: "https://evilvisualstudio.com",
				defaultUrl: null,
				atlassianCloudSiteUrl: null,
			}),
		).toBeNull();
	});
	it("returns null for proxied/unknown tools (forces within-project fallback)", () => {
		expect(
			extractConfigOrgKey("fizzy", {
				commandArgs: null,
				baseUrl: "https://fizzy.fabric.pro",
				defaultUrl: null,
				atlassianCloudSiteUrl: null,
			}),
		).toBeNull();
		expect(
			extractConfigOrgKey("github", {
				commandArgs: null,
				baseUrl: null,
				defaultUrl: null,
				atlassianCloudSiteUrl: null,
			}),
		).toBeNull();
	});
});

describe("deriveTrustedKey", () => {
	it("uses the config key when present (config-derivable: ADO/Jira)", () => {
		expect(
			deriveTrustedKey({
				configOrgKey: "contoso",
				baselineKeys: ["other", null],
			}),
		).toEqual({
			kind: "trusted",
			key: "contoso",
		});
	});
	it("fallback: single distinct key is trusted", () => {
		expect(
			deriveTrustedKey({
				configOrgKey: null,
				baselineKeys: ["000000", "000000"],
			}),
		).toEqual({
			kind: "trusted",
			key: "000000",
		});
	});
	it("fallback: >=2 distinct keys are ambiguous (multitenant)", () => {
		expect(
			deriveTrustedKey({
				configOrgKey: null,
				baselineKeys: ["000000", "9999999"],
			}),
		).toEqual({
			kind: "ambiguous",
			reason: "multitenant",
		});
	});
	it("fallback fails closed when any current-tool link is unparseable", () => {
		expect(
			deriveTrustedKey({
				configOrgKey: null,
				baselineKeys: ["000000", null],
			}),
		).toEqual({
			kind: "ambiguous",
			reason: "fallback-unparseable",
		});
	});
	it("fallback with no current-tool links is none", () => {
		expect(
			deriveTrustedKey({ configOrgKey: null, baselineKeys: [] }),
		).toEqual({ kind: "none" });
	});
});

describe("decideCandidate", () => {
	const trusted = { kind: "trusted", key: "contoso" } as const;
	it("stamps an exact org match", () => {
		expect(
			decideCandidate({
				toolType: "azure-devops",
				externalUrl:
					"https://dev.azure.com/Contoso/p/_workitems/edit/1",
				entityOrgKey: "contoso",
				trusted,
			}),
		).toEqual({ action: "stamp" });
	});
	it("skips a different org (the switch case)", () => {
		expect(
			decideCandidate({
				toolType: "azure-devops",
				externalUrl: "https://dev.azure.com/OldOrg/p/_workitems/edit/1",
				entityOrgKey: "oldorg",
				trusted,
			}),
		).toEqual({ action: "skip", reason: "org-mismatch" });
	});
	it("skips a cross-tool link (tool-mismatch)", () => {
		expect(
			decideCandidate({
				toolType: "azure-devops",
				externalUrl: "https://acme.atlassian.net/browse/X-1",
				entityOrgKey: null,
				trusted,
			}),
		).toEqual({ action: "skip", reason: "tool-mismatch" });
	});
	it("skips a null URL (no-url)", () => {
		expect(
			decideCandidate({
				toolType: "azure-devops",
				externalUrl: null,
				entityOrgKey: null,
				trusted,
			}),
		).toEqual({ action: "skip", reason: "no-url" });
	});
	it("propagates ambiguity reasons", () => {
		expect(
			decideCandidate({
				toolType: "fizzy",
				externalUrl: "https://app.fizzy.do/000000/cards/1",
				entityOrgKey: "000000",
				trusted: { kind: "ambiguous", reason: "multitenant" },
			}),
		).toEqual({ action: "skip", reason: "ambiguous-multitenant" });
	});
	it("skips with no-baseline when there is no trusted baseline", () => {
		expect(
			decideCandidate({
				toolType: "fizzy",
				externalUrl: "https://app.fizzy.do/000000/cards/1",
				entityOrgKey: "000000",
				trusted: { kind: "none" },
			}),
		).toEqual({ action: "skip", reason: "no-baseline" });
	});
});
