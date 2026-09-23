/**
 * The gating flag is resolved for the PROJECT's organization (Fizzy #1930).
 *
 * `CAPABILITY_GATING` is organization-scopable, but an organization override is
 * only consulted when the organization is passed — and no gating call site
 * passed one, so enabling it for one organization did nothing and opting one
 * out of a global rollout did nothing either.
 *
 * The flag's precedence is resolved by the REAL `resolveFlag` from the
 * registry, fed the override rows each scenario describes; only the two reads
 * behind it (the project row and the override tables) are stood in for.
 */

import { resolveFlag } from "@repo/utils/feature-flag-registry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
	state: {
		projectOrganizationId: "organization_example" as string | null,
		global: undefined as boolean | undefined,
		org: {} as Record<string, boolean>,
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: async () => ({
				organizationId: state.projectOrganizationId,
			}),
		},
	},
	isFeatureEnabled: async (
		key: "CAPABILITY_GATING",
		organizationId?: string,
	) =>
		resolveFlag(
			key,
			{
				org: organizationId ? state.org[organizationId] : undefined,
				global: state.global,
			},
			{},
		).enabled,
}));

import { isCapabilityGatingEnabled } from "../flag";

beforeEach(() => {
	state.projectOrganizationId = "organization_example";
	state.global = undefined;
	state.org = {};
});

describe("isCapabilityGatingEnabled", () => {
	it("gates a project whose organization is opted in while the global flag is off", async () => {
		state.global = false;
		state.org = { organization_example: true };

		expect(await isCapabilityGatingEnabled("project_example")).toBe(true);
	});

	it("does not gate a project whose organization is opted out of a global rollout", async () => {
		state.global = true;
		state.org = { organization_example: false };

		expect(await isCapabilityGatingEnabled("project_example")).toBe(false);
	});

	it("uses the project's organization, not whichever one opted in", async () => {
		state.global = false;
		state.org = { organization_other: true };

		expect(await isCapabilityGatingEnabled("project_example")).toBe(false);
	});

	it("falls back to the global answer for a project with no organization", async () => {
		state.projectOrganizationId = null;
		state.global = true;

		expect(await isCapabilityGatingEnabled("project_example")).toBe(true);
	});
});
