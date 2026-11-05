import {
	isUnprovenCatalogTemplate,
	reportTemplatePublishTargets,
	reportTemplateScopeOptions,
} from "@saas/reports/lib/report-template-publishing";
import { describe, expect, it } from "vitest";

const MEMBER = { isPlatformAdmin: false, isOrganizationAdmin: false };
const ORG_ADMIN = { isPlatformAdmin: false, isOrganizationAdmin: true };
const PLATFORM_ADMIN = { isPlatformAdmin: true, isOrganizationAdmin: false };

const scopes = (options: { value: string }[]) =>
	options.map((option) => option.value);

describe("reportTemplateScopeOptions", () => {
	it("offers members only their own templates", () => {
		const options = reportTemplateScopeOptions({
			inOrganization: true,
			roles: MEMBER,
			canCreateSystemTemplates: false,
		});

		expect(options).toEqual([{ value: "USER", label: "Only me" }]);
	});

	it("offers the organization to its admins and owners", () => {
		expect(
			scopes(
				reportTemplateScopeOptions({
					inOrganization: true,
					roles: ORG_ADMIN,
					canCreateSystemTemplates: false,
				}),
			),
		).toEqual(["USER", "ORGANIZATION"]);
	});

	it("never offers the organization outside one", () => {
		expect(
			scopes(
				reportTemplateScopeOptions({
					inOrganization: false,
					roles: ORG_ADMIN,
					canCreateSystemTemplates: false,
				}),
			),
		).toEqual(["USER"]);
	});

	it("offers system templates only to platform admins who may edit them", () => {
		expect(
			scopes(
				reportTemplateScopeOptions({
					inOrganization: true,
					roles: PLATFORM_ADMIN,
					canCreateSystemTemplates: true,
				}),
			),
		).toEqual(["USER", "SYSTEM"]);
	});

	it("offers only Only me while the viewer's role is loading", () => {
		expect(
			scopes(
				reportTemplateScopeOptions({
					inOrganization: true,
					roles: undefined,
					canCreateSystemTemplates: false,
				}),
			),
		).toEqual(["USER"]);
	});

	it("keeps an edited template's own scope listed", () => {
		expect(
			scopes(
				reportTemplateScopeOptions({
					inOrganization: true,
					roles: MEMBER,
					canCreateSystemTemplates: false,
					currentScope: "ORGANIZATION",
				}),
			),
		).toEqual(["USER", "ORGANIZATION"]);
	});
});

describe("reportTemplatePublishTargets", () => {
	const ownPersonal = {
		scope: "USER" as const,
		userId: "u-1",
		organizationId: "example-org",
		archivedAt: null,
	};

	it("lets an organization admin publish their own template to the organization", () => {
		expect(
			reportTemplatePublishTargets(ownPersonal, ORG_ADMIN, "u-1"),
		).toEqual(["ORGANIZATION"]);
	});

	it("does not let a member publish to the organization", () => {
		expect(
			reportTemplatePublishTargets(ownPersonal, MEMBER, "u-1"),
		).toEqual([]);
	});

	it("does not let an admin publish someone else's template", () => {
		expect(
			reportTemplatePublishTargets(ownPersonal, ORG_ADMIN, "u-2"),
		).toEqual([]);
	});

	it("does not publish a personal-context template to an organization", () => {
		expect(
			reportTemplatePublishTargets(
				{ ...ownPersonal, organizationId: null },
				ORG_ADMIN,
				"u-1",
			),
		).toEqual([]);
	});

	it("lets platform admins publish any non-system template to all organizations", () => {
		expect(
			reportTemplatePublishTargets(
				{ ...ownPersonal, scope: "ORGANIZATION", userId: "u-2" },
				PLATFORM_ADMIN,
				"u-1",
			),
		).toEqual(["SYSTEM"]);
		expect(
			reportTemplatePublishTargets(
				{ ...ownPersonal, scope: "SYSTEM", userId: null },
				PLATFORM_ADMIN,
				"u-1",
			),
		).toEqual([]);
	});

	it("offers both to a platform admin who is also the author and an organization admin", () => {
		expect(
			reportTemplatePublishTargets(
				ownPersonal,
				{ isPlatformAdmin: true, isOrganizationAdmin: true },
				"u-1",
			),
		).toEqual(["ORGANIZATION", "SYSTEM"]);
	});

	it("offers nothing for an archived template", () => {
		expect(
			reportTemplatePublishTargets(
				{ ...ownPersonal, archivedAt: "2026-01-01T00:00:00.000Z" },
				{ isPlatformAdmin: true, isOrganizationAdmin: true },
				"u-1",
			),
		).toEqual([]);
	});
});

describe("isUnprovenCatalogTemplate", () => {
	const system = {
		scope: "SYSTEM" as const,
		isPublic: false,
		isGeneric: false,
		proven: false,
	};

	it("marks a connector template that has never completed a report", () => {
		expect(isUnprovenCatalogTemplate(system)).toBe(true);
		expect(
			isUnprovenCatalogTemplate({
				...system,
				scope: "ORGANIZATION",
				isPublic: true,
			}),
		).toBe(true);
	});

	it("leaves generic and proven templates unmarked", () => {
		expect(isUnprovenCatalogTemplate({ ...system, isGeneric: true })).toBe(
			false,
		);
		expect(isUnprovenCatalogTemplate({ ...system, proven: true })).toBe(
			false,
		);
	});

	it("leaves organization and personal templates unmarked", () => {
		expect(
			isUnprovenCatalogTemplate({ ...system, scope: "ORGANIZATION" }),
		).toBe(false);
		expect(isUnprovenCatalogTemplate({ ...system, scope: "USER" })).toBe(
			false,
		);
	});
});
