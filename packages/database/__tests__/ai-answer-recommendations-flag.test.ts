/**
 * `isAiAnswerRecommendationsEnabledForProject` resolves the
 * AI_ANSWER_RECOMMENDATIONS registry flag (Fizzy #2300) for the organization
 * that OWNS the project, and only for a request made in that organization —
 * never from the SQL-only organization column the flag replaced.
 *
 * The column is mocked to say `true` while the flag says `false` in the test
 * that matters, so a reader that still consulted the column fails here rather
 * than passing alongside it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const isFeatureEnabled = vi.fn();
const projectFindUnique = vi.fn();
const organizationFindUnique = vi.fn();
const loggerWarn = vi.fn();

vi.mock("@repo/logs", () => ({
	logger: {
		warn: (...args: unknown[]) => loggerWarn(...args),
		error: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("../prisma/queries/feature-flags", () => ({
	isFeatureEnabled: (...args: unknown[]) => isFeatureEnabled(...args),
}));

vi.mock("../prisma/client", () => ({
	db: {
		project: {
			findUnique: (...args: unknown[]) => projectFindUnique(...args),
		},
		organization: {
			findUnique: (...args: unknown[]) => organizationFindUnique(...args),
		},
	},
	Prisma: {},
}));

import { isAiAnswerRecommendationsEnabledForProject } from "../prisma/queries/feature-maturation";

beforeEach(() => {
	isFeatureEnabled.mockReset();
	projectFindUnique.mockReset();
	organizationFindUnique.mockReset();
	loggerWarn.mockReset();
	projectFindUnique.mockResolvedValue({ organizationId: "org-owner" });
	organizationFindUnique.mockResolvedValue({
		aiAnswerRecommendationsEnabled: true,
	});
});

describe("isAiAnswerRecommendationsEnabledForProject", () => {
	it("resolves the flag for the organization that owns the project", async () => {
		isFeatureEnabled.mockResolvedValue(true);

		await expect(
			isAiAnswerRecommendationsEnabledForProject({
				projectId: "project-1",
				organizationId: "org-owner",
			}),
		).resolves.toBe(true);
		expect(projectFindUnique).toHaveBeenCalledWith({
			where: { id: "project-1" },
			select: { organizationId: true },
		});
		expect(isFeatureEnabled).toHaveBeenCalledWith(
			"AI_ANSWER_RECOMMENDATIONS",
			"org-owner",
		);
	});

	it("follows the flag, not the retired column, when they disagree", async () => {
		isFeatureEnabled.mockResolvedValue(false);

		await expect(
			isAiAnswerRecommendationsEnabledForProject({
				projectId: "project-1",
				organizationId: "org-owner",
			}),
		).resolves.toBe(false);
		expect(organizationFindUnique).not.toHaveBeenCalled();
	});

	// Recommendations are generated with the request organization's model
	// credentials and usage limits, so a request made in an organization other
	// than the project's owner must never pass, whichever organization has the
	// flag on. The refusal is logged: the admin
	// console would still show the organization as Enabled, so without the
	// warning a tenant-resolution fault would look like a flag that "does
	// nothing".
	it("is off, and warns, when the request names an organization that does not own the project", async () => {
		isFeatureEnabled.mockResolvedValue(true);

		await expect(
			isAiAnswerRecommendationsEnabledForProject({
				projectId: "project-1",
				organizationId: "org-named-by-caller",
			}),
		).resolves.toBe(false);
		expect(isFeatureEnabled).not.toHaveBeenCalled();
		expect(loggerWarn).toHaveBeenCalledTimes(1);
		expect(loggerWarn).toHaveBeenCalledWith(
			{
				event: "ai_answer_recommendations.organization_mismatch",
				projectId: "project-1",
				projectOrganizationId: "org-owner",
				requestOrganizationId: "org-named-by-caller",
			},
			expect.any(String),
		);
	});

	// The feature editor sends no organization while its organization context
	// is still loading, then refetches. That transient request must be refused
	// without a warning, or every such page load would log a false mismatch.
	// An empty-string organization must be refused the same quiet way: a guard
	// written as `organizationId == null` would let it fall through to a
	// project read and a false mismatch warning.
	it.each([
		["null", null],
		["undefined", undefined],
		["an empty string", ""],
	])(
		"is off for a request with %s organization, without reading the project or warning",
		async (_label, organizationId) => {
			isFeatureEnabled.mockResolvedValue(true);

			await expect(
				isAiAnswerRecommendationsEnabledForProject({
					projectId: "project-1",
					organizationId,
				}),
			).resolves.toBe(false);
			expect(projectFindUnique).not.toHaveBeenCalled();
			expect(isFeatureEnabled).not.toHaveBeenCalled();
			expect(loggerWarn).not.toHaveBeenCalled();
		},
	);

	it("is off for a project with no organization, without resolving the flag", async () => {
		projectFindUnique.mockResolvedValue({ organizationId: null });

		await expect(
			isAiAnswerRecommendationsEnabledForProject({
				projectId: "project-1",
				organizationId: "org-owner",
			}),
		).resolves.toBe(false);
		expect(isFeatureEnabled).not.toHaveBeenCalled();
	});

	// The column is a nullable String with no non-empty constraint, so a row
	// can hold "" — which must never reach the resolver as an organization id.
	// Not a mismatch either: a project with no owner has nobody to warn about.
	it("is off for a project stored with an empty organization id, without resolving or warning", async () => {
		projectFindUnique.mockResolvedValue({ organizationId: "" });

		await expect(
			isAiAnswerRecommendationsEnabledForProject({
				projectId: "project-1",
				organizationId: "org-owner",
			}),
		).resolves.toBe(false);
		expect(projectFindUnique).toHaveBeenCalledTimes(1);
		expect(isFeatureEnabled).not.toHaveBeenCalled();
		expect(loggerWarn).not.toHaveBeenCalled();
	});

	it("is off for a project that does not exist", async () => {
		projectFindUnique.mockResolvedValue(null);

		await expect(
			isAiAnswerRecommendationsEnabledForProject({
				projectId: "missing",
				organizationId: "org-owner",
			}),
		).resolves.toBe(false);
		expect(isFeatureEnabled).not.toHaveBeenCalled();
	});
});
