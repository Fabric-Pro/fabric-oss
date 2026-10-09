/**
 * The Proposal artifact rollout gate (Fizzy #2801) resolves per organization,
 * from the organization that OWNS the project, and the recipient brand alone
 * widens to "GLOSSY_EDITION or PROPOSAL_ARTIFACT".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIsFeatureEnabled = vi.fn();
const mockResolveProjectTenant = vi.fn();

vi.mock("@repo/database", () => ({
	isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
	resolveProjectTenant: (...args: unknown[]) =>
		mockResolveProjectTenant(...args),
}));

const {
	assertGlossyOrProposalArtifactEnabled,
	assertProposalArtifactEnabled,
	assertProposalArtifactEnabledForOrganization,
	requireGlossyOrProposalArtifactEnabled,
	requireProposalArtifactEnabled,
} = await import("../proposal-artifact-feature");
const {
	assertGlossyEnabled,
	assertGlossyEnabledForOrganization,
	requireGlossyEnabled,
} = await import("../glossy-feature");

const OWNING_ORG = "org_owner";
const SESSION_ORG = "org_session";
const PROJECT = "proj_1";

type Flag = "GLOSSY_EDITION" | "PROPOSAL_ARTIFACT";

/** Which flags are on, per organization. Everything else resolves off. */
let enabled: Record<string, Flag[]> = {};

function enable(organizationId: string, ...flags: Flag[]) {
	enabled[organizationId] = flags;
}

function ownedBy(organizationId: string | null) {
	mockResolveProjectTenant.mockResolvedValue({
		organizationId,
		userId: organizationId ? null : "user_1",
	});
}

type Middleware = (
	options: { next: () => Promise<unknown> },
	input: unknown,
) => Promise<unknown>;

function run(middlewareFactory: () => unknown, input: unknown) {
	const next = vi.fn(async () => ({ output: "handled" }));
	const middleware = middlewareFactory() as Middleware;
	return { result: middleware({ next }, input), next };
}

beforeEach(() => {
	vi.clearAllMocks();
	enabled = {};
	mockIsFeatureEnabled.mockImplementation(
		async (key: Flag, organizationId?: string) =>
			organizationId !== undefined &&
			(enabled[organizationId] ?? []).includes(key),
	);
	ownedBy(OWNING_ORG);
});

describe("assertProposalArtifactEnabled", () => {
	it("passes and returns the owning organization when the gate is on for it", async () => {
		enable(OWNING_ORG, "PROPOSAL_ARTIFACT");

		await expect(assertProposalArtifactEnabled(PROJECT)).resolves.toBe(
			OWNING_ORG,
		);
		expect(mockResolveProjectTenant).toHaveBeenCalledWith(PROJECT);
		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"PROPOSAL_ARTIFACT",
			OWNING_ORG,
		);
	});

	// A guest working from their own organization must see the gate of the
	// organization that owns the project, never their session's.
	it("refuses when the gate is on only for the caller's session organization", async () => {
		enable(SESSION_ORG, "PROPOSAL_ARTIFACT");

		await expect(
			assertProposalArtifactEnabled(PROJECT),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"PROPOSAL_ARTIFACT",
			OWNING_ORG,
		);
		expect(mockIsFeatureEnabled).not.toHaveBeenCalledWith(
			expect.anything(),
			SESSION_ORG,
		);
	});

	it("refuses when only GLOSSY_EDITION is on for the owning organization", async () => {
		enable(OWNING_ORG, "GLOSSY_EDITION");

		await expect(
			assertProposalArtifactEnabled(PROJECT),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	// ADR-018: a project with no organization is refused outright and never
	// reaches the global/env/default chain.
	it("refuses a project with no organization without reading the flag", async () => {
		ownedBy(null);

		await expect(
			assertProposalArtifactEnabled(PROJECT),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
	});

	it("refuses a project that no longer resolves", async () => {
		mockResolveProjectTenant.mockResolvedValue(null);

		await expect(
			assertProposalArtifactEnabled("proj_gone"),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
	});
});

describe("assertProposalArtifactEnabledForOrganization", () => {
	it("checks exactly the organization it is given and returns it", async () => {
		enable(OWNING_ORG, "PROPOSAL_ARTIFACT");

		await expect(
			assertProposalArtifactEnabledForOrganization(OWNING_ORG),
		).resolves.toBe(OWNING_ORG);
		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"PROPOSAL_ARTIFACT",
			OWNING_ORG,
		);
		expect(mockResolveProjectTenant).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND when the organization does not have the gate on", async () => {
		await expect(
			assertProposalArtifactEnabledForOrganization(OWNING_ORG),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it.each([null, undefined, ""])(
		"refuses a missing organization (%s) without reading the flag",
		async (organizationId) => {
			await expect(
				assertProposalArtifactEnabledForOrganization(organizationId),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
		},
	);
});

describe("assertGlossyOrProposalArtifactEnabled", () => {
	it.each<{ name: string; flags: Flag[] }>([
		{ name: "only GLOSSY_EDITION", flags: ["GLOSSY_EDITION"] },
		{ name: "only PROPOSAL_ARTIFACT", flags: ["PROPOSAL_ARTIFACT"] },
		{ name: "both", flags: ["GLOSSY_EDITION", "PROPOSAL_ARTIFACT"] },
	])(
		"passes with $name on for the owning organization",
		async ({ flags }) => {
			enable(OWNING_ORG, ...flags);

			await expect(
				assertGlossyOrProposalArtifactEnabled(PROJECT),
			).resolves.toBe(OWNING_ORG);
		},
	);

	it("refuses with neither gate on", async () => {
		await expect(
			assertGlossyOrProposalArtifactEnabled(PROJECT),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"GLOSSY_EDITION",
			OWNING_ORG,
		);
		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"PROPOSAL_ARTIFACT",
			OWNING_ORG,
		);
	});

	it("refuses when both gates are on only for the caller's session organization", async () => {
		enable(SESSION_ORG, "GLOSSY_EDITION", "PROPOSAL_ARTIFACT");

		await expect(
			assertGlossyOrProposalArtifactEnabled(PROJECT),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mockIsFeatureEnabled).not.toHaveBeenCalledWith(
			expect.anything(),
			SESSION_ORG,
		);
	});

	it("refuses a project with no organization without reading either flag", async () => {
		ownedBy(null);

		await expect(
			assertGlossyOrProposalArtifactEnabled(PROJECT),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
	});
});

// The middleware forms run BEFORE the permission middleware, so a gate that
// is off answers NOT_FOUND to every caller, worded as the permission
// middleware answers a caller with no tie to the project.
describe.each([
	{
		name: "requireProposalArtifactEnabled",
		factory: requireProposalArtifactEnabled,
	},
	{
		name: "requireGlossyOrProposalArtifactEnabled",
		factory: requireGlossyOrProposalArtifactEnabled,
	},
])("$name", ({ factory }) => {
	it("answers NOT_FOUND before the rest of the chain when the gate is off", async () => {
		const { result, next } = run(factory, { projectId: PROJECT });

		await expect(result).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Project not found",
		});
		expect(next).not.toHaveBeenCalled();
	});

	it("continues the chain when the owning organization has the gate on", async () => {
		enable(OWNING_ORG, "PROPOSAL_ARTIFACT");

		const { result, next } = run(factory, { projectId: PROJECT });

		await expect(result).resolves.toEqual({ output: "handled" });
		expect(next).toHaveBeenCalledTimes(1);
	});

	it("answers NOT_FOUND when the gate is on only for the session organization", async () => {
		enable(SESSION_ORG, "PROPOSAL_ARTIFACT");

		const { result, next } = run(factory, { projectId: PROJECT });

		await expect(result).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(next).not.toHaveBeenCalled();
	});

	it("passes any other failure of the gate through unchanged", async () => {
		const outage = new Error("database unavailable");
		mockResolveProjectTenant.mockRejectedValue(outage);

		const { result, next } = run(factory, { projectId: PROJECT });

		await expect(result).rejects.toBe(outage);
		expect(next).not.toHaveBeenCalled();
	});

	it("leaves a missing projectId to the permission middleware that follows", async () => {
		const { result, next } = run(factory, {});

		await expect(result).resolves.toEqual({ output: "handled" });
		expect(mockResolveProjectTenant).not.toHaveBeenCalled();
		expect(next).toHaveBeenCalledTimes(1);
	});
});

describe("requireGlossyOrProposalArtifactEnabled — either gate", () => {
	it.each<{ name: string; flags: Flag[]; passes: boolean }>([
		{
			name: "only GLOSSY_EDITION",
			flags: ["GLOSSY_EDITION"],
			passes: true,
		},
		{
			name: "only PROPOSAL_ARTIFACT",
			flags: ["PROPOSAL_ARTIFACT"],
			passes: true,
		},
		{ name: "neither", flags: [], passes: false },
	])(
		"with $name on for the owning organization, passes: $passes",
		async ({ flags, passes }) => {
			enable(OWNING_ORG, ...flags);

			const { result, next } = run(
				requireGlossyOrProposalArtifactEnabled,
				{ projectId: PROJECT },
			);

			if (passes) {
				await expect(result).resolves.toEqual({ output: "handled" });
				expect(next).toHaveBeenCalledTimes(1);
			} else {
				await expect(result).rejects.toMatchObject({
					code: "NOT_FOUND",
					message: "Project not found",
				});
				expect(next).not.toHaveBeenCalled();
			}
		},
	);

	it("requireProposalArtifactEnabled does not accept GLOSSY_EDITION in its place", async () => {
		enable(OWNING_ORG, "GLOSSY_EDITION");

		const { result, next } = run(requireProposalArtifactEnabled, {
			projectId: PROJECT,
		});

		await expect(result).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(next).not.toHaveBeenCalled();
	});
});

// Only the recipient brand widens. The Glossy procedures, their handlers'
// loader and the Brand kit keep GLOSSY_EDITION alone, so an organization with
// only the Proposal artifact on still cannot reach any of them.
describe("Glossy and Brand kit gates with only PROPOSAL_ARTIFACT on", () => {
	beforeEach(() => {
		enable(OWNING_ORG, "PROPOSAL_ARTIFACT");
	});

	it("requireGlossyEnabled still answers NOT_FOUND", async () => {
		const { result, next } = run(requireGlossyEnabled, {
			projectId: PROJECT,
		});

		await expect(result).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(next).not.toHaveBeenCalled();
		expect(mockIsFeatureEnabled).not.toHaveBeenCalledWith(
			"PROPOSAL_ARTIFACT",
			expect.anything(),
		);
	});

	it("assertGlossyEnabled still answers NOT_FOUND", async () => {
		await expect(assertGlossyEnabled(PROJECT)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	it("the Brand kit gate still answers NOT_FOUND", async () => {
		await expect(
			assertGlossyEnabledForOrganization(OWNING_ORG),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("while the recipient brand gate passes", async () => {
		await expect(
			assertGlossyOrProposalArtifactEnabled(PROJECT),
		).resolves.toBe(OWNING_ORG);
	});
});
