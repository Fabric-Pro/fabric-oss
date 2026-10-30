import { describe, expect, it } from "vitest";
import * as targets from "../lib/pm-target";
import {
	fixtureTarget,
	mutablePmSettings,
	pmTargetFixtures,
} from "../test-fixtures/pm-target";

const base = { mcpServerId: "example-server", containerId: "example-project" };
const key = (
	instance = "",
	container = "example-project",
	server = "example-server",
) => `pmt1:${JSON.stringify([server, instance, container])}`;

describe("PM target identity", () => {
	it("ignores settings and listing filters", () => {
		const input = {
			...base,
			pmTool: "azure-devops",
			containerId: "11111111-1111-4111-8111-111111111111",
			config: { commandArgs: ["example-org"] },
		};
		expect(
			targets.buildExternalPmTarget({
				...input,
				additionalContext: {
					fieldMapping: { title: "name" },
					iterationPath: "example-iteration",
					workItemType: "Bug",
					team: "example-team",
					areaPath: "example-area",
					projectName: "Example",
					containerName: "Example",
				},
			}),
		).toBe(targets.buildExternalPmTarget(input));
	});
	it("uses Jira cloud identity independently of its attachment connection", () => {
		const jira = (
			additionalContext: unknown,
			atlassianCloudSiteUrl?: string,
		) =>
			targets.buildExternalPmTarget({
				...base,
				pmTool: "jira",
				additionalContext,
				config: { atlassianCloudSiteUrl },
			});
		expect(jira({ cloudId: "example-cloud" })).toBe(key("example-cloud"));
		expect(
			jira({ cloudId: "example-cloud" }, "https://example.atlassian.net"),
		).toBe(jira({ cloudId: "example-cloud" }));
		expect(jira({}, "https://example.atlassian.net")).toBe(key());
	});
	it("normalizes ADO orgs without changing the legacy provenance extractor", () => {
		expect(
			targets.extractConfigOrgKey("azure-devops", {
				commandArgs: [" EXAMPLE-ORG/ "],
			}),
		).toBe("example-org/");
		const ado = (org: string) =>
			targets.buildExternalPmTarget({
				...base,
				pmTool: "azure-devops",
				containerId: "11111111-1111-4111-8111-111111111111",
				config: { commandArgs: [org] },
			});
		expect(ado("EXAMPLE-ORG/")).toBe(ado("example-org"));
	});
	it.each([
		"example-org",
		" EXAMPLE-ORG/ ",
		"%65XAMPLE-org",
		"https://dev.azure.com/example-org/",
		"http://DEV.AZURE.COM/EXAMPLE-ORG/project/_workitems?view=all#item",
		"dev.azure.com/%65xample-org/project?view=all",
		"dev.azure.com/example-org/project?redirect=https://example.com",
		"https://dev.azure.com/example-org/project%?query=%ZZ",
		"https://example-org.visualstudio.com/",
		"example-org.visualstudio.com/project?view=all",
		"https://%65xample-org.visualstudio.com/project",
	])("canonicalizes ADO organisation %s at every config input", (org) => {
		const expected = key(
			"example-org",
			"11111111-1111-4111-8111-111111111111",
		);
		for (const config of [
			{ commandArgs: [org] },
			{ baseUrl: org },
			{ defaultUrl: org },
			{ mcpServer: { defaultUrl: org } },
		]) {
			const actual = targets.buildExternalPmTarget({
				...base,
				pmTool: "azure-devops",
				containerId: "11111111-1111-4111-8111-111111111111",
				config,
			});
			expect(actual).toBe(expected);
			expect(targets.pmTargetsConflict(actual, expected)).toBe(false);
			expect(targets.pmTargetsConflict(expected, actual)).toBe(false);
		}
	});
	it("keeps different ADO organisations distinct", () => {
		const ado = (org: string) =>
			targets.buildExternalPmTarget({
				...base,
				pmTool: "azure-devops",
				containerId: "11111111-1111-4111-8111-111111111111",
				config: { commandArgs: [org] },
			});
		expect(
			targets.pmTargetsConflict(
				ado("example-org"),
				ado("https://dev.azure.com/other-org/"),
			),
		).toBe(true);
	});
	it.each([
		"not an organisation",
		"https://dev.azure.com/",
		"https://example.com/example-org",
		"dev.azure.com/",
		"https://visualstudio.com/",
		"https://example-org.evilvisualstudio.com/",
		"https://dev.azure.com/%ZZ",
		"https://dev.azure.com/example%2Forg",
		"ftp://dev.azure.com/example-org",
		"--authentication",
		"example-org-",
	])("returns unknown for unparseable ADO organisation %s", (org) => {
		for (const config of [
			{
				commandArgs: [org],
				baseUrl: "https://dev.azure.com/example-org",
			},
			{ baseUrl: org },
			{ defaultUrl: org },
		]) {
			expect(
				targets.buildExternalPmTarget({
					...base,
					pmTool: "azure-devops",
					containerId: "11111111-1111-4111-8111-111111111111",
					config,
				}),
			).toBeNull();
		}
	});
	it("normalizes recorded GitLab origins and Fizzy accounts", () => {
		const gitlab = (gitlabOrigin: string) =>
			targets.buildExternalPmTarget({
				...base,
				pmTool: "gitlab",
				additionalContext: { gitlabOrigin },
			});
		expect(gitlab("https://GITLAB.example.com/")).toBe(
			key("https://gitlab.example.com"),
		);
		expect(gitlab("https://gitlab.example.com")).toBe(
			gitlab("https://GITLAB.example.com/"),
		);
		expect(
			targets.buildExternalPmTarget({
				...base,
				pmTool: "fizzy",
				additionalContext: { account_slug: "/EXAMPLE-ACCOUNT/" },
			}),
		).toBe(key("/example-account"));
	});
	it("returns unknown for missing required identities", () => {
		for (const input of [
			{ ...base, pmTool: "azure-devops" },
			{ ...base, pmTool: "fizzy" },
			{ ...base, pmTool: "gitlab" },
			{
				...base,
				pmTool: "gitlab",
				additionalContext: { gitlabOrigin: "invalid" },
			},
			{ ...base, pmTool: "linear", mcpServerId: null },
		]) {
			expect(targets.buildExternalPmTarget(input)).toBeNull();
		}
	});
	it("compares server, instance and container, with unknown instances as wildcards", () => {
		const conflict = (targets as Record<string, unknown>)
			.pmTargetsConflict as (
			a: string | null,
			b: string | null,
		) => boolean;
		expect(conflict).toBeTypeOf("function");
		expect(conflict(key("example-org"), key("other-org"))).toBe(true);
		expect(conflict(key(), key("example-org"))).toBe(false);
		expect(conflict(key("example-org"), key())).toBe(false);
		expect(conflict(key(), key("", "other-project"))).toBe(true);
		expect(
			conflict(key(), key("", "example-project", "other-server")),
		).toBe(true);
		for (const invalid of [
			null,
			"",
			"unparseable",
			'pmt1:["s"]',
			'pmt1:["s",null,"p"]',
			'pmt1:["s","","p",[]]',
		]) {
			expect(conflict(invalid, key())).toBe(false);
			expect(conflict(key(), invalid)).toBe(false);
		}
	});
});

it.each(pmTargetFixtures)(
	"$name: settings stay compatible and real target changes conflict",
	(fixture) => {
		const target = (overrides: Record<string, unknown> = {}) =>
			targets.buildExternalPmTarget({
				...fixture,
				mcpServerId: "example-server",
				...overrides,
			});
		const active = target();
		expect(active).toBe(fixtureTarget(fixture, "example-server"));
		expect(
			targets.pmTargetsConflict(
				active,
				target({
					additionalContext: {
						...fixture.additionalContext,
						...mutablePmSettings,
					},
				}),
			),
		).toBe(false);
		expect(
			targets.pmTargetsConflict(
				active,
				target({
					containerId:
						fixture.pmTool === "azure-devops"
							? "22222222-2222-4222-8222-222222222222"
							: "other-container",
				}),
			),
		).toBe(true);
		const instanceChanges: Record<string, unknown> =
			fixture.pmTool === "azure-devops"
				? { config: { ...fixture.config, commandArgs: ["other-org"] } }
				: {
						additionalContext: {
							...fixture.additionalContext,
							...(fixture.pmTool === "gitlab"
								? {
										gitlabOrigin:
											"https://other-gitlab.example.com",
									}
								: fixture.pmTool === "fizzy"
									? { account_slug: "/other-account" }
									: { cloudId: "other-cloud" }),
						},
					};
		expect(targets.pmTargetsConflict(active, target(instanceChanges))).toBe(
			!!fixture.instance,
		);
	},
);

it.each([
	"example",
	"example/",
	"example///",
	`example${"/".repeat(200_000)}`,
	`example${"/".repeat(200_000)}x`,
])("normalizes account slashes", (account_slug) => {
	const expected = account_slug.endsWith("x") ? account_slug : "example";
	expect(
		targets.buildExternalPmTarget({
			...base,
			pmTool: "fizzy",
			additionalContext: { account_slug },
		}),
	).toBe(key(expected));
});

it("handles long ADO organization slash runs", () => {
	const input = {
		...base,
		pmTool: "azure-devops",
		containerId: "11111111-1111-4111-8111-111111111111",
	};
	expect(
		targets.buildExternalPmTarget({
			...input,
			config: { commandArgs: [`example${"/".repeat(200_000)}`] },
		}),
	).toContain('"example"');
	expect(
		targets.buildExternalPmTarget({
			...input,
			config: { commandArgs: [`example${"/".repeat(200_000)}x`] },
		}),
	).toBeNull();
});
