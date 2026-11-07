import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => vi.fn());
vi.mock("../proposal-artifact-feature", () => ({
	assertProposalArtifactEnabled: gate,
}));

import { InitialProposalBrandError } from "@repo/database/prisma/queries/projects/initial-proposal-brand";
import {
	prepareProposalBrandingInput,
	proposalBrandingAdmissionError,
} from "../proposal-branding-input";

beforeEach(() => {
	gate.mockReset().mockResolvedValue("example-org");
});
const base = { projectId: "example-project", type: "PROPOSAL" };
describe("proposal brand admission", () => {
	it("leaves existing unbranded clients unchanged and does not probe a rollout", async () => {
		expect(
			await prepareProposalBrandingInput({ ...base, type: "PRD" }),
		).toEqual({});
		expect(gate).not.toHaveBeenCalled();
	});
	it("checks the owning project's rollout before accepting a reviewed client palette", async () => {
		expect(
			await prepareProposalBrandingInput({
				...base,
				proposalBranding: "CLIENT",
				recipientBrandVersion: 2,
			}),
		).toEqual({ proposalBranding: "CLIENT", recipientBrandVersion: 2 });
		expect(gate).toHaveBeenCalledWith(base.projectId);
		gate.mockRejectedValue(new Error("Disabled"));
		await expect(
			prepareProposalBrandingInput({
				...base,
				proposalBranding: "COMPANY",
			}),
		).rejects.toThrow("Disabled");
	});
	it.each([
		{ proposalBranding: "CLIENT" },
		{ proposalBranding: "CLIENT", recipientBrandVersion: 0 },
		{ proposalBranding: "CLIENT", recipientBrandVersion: "2" },
		{
			proposalBranding: "CLIENT",
			recipientBrandVersion: 2,
			awaitingSourceFile: true,
		},
		{ proposalBranding: "CLIENT", recipientBrandVersion: 2, type: "PRD" },
		{ proposalBranding: "COMPANY", recipientBrandVersion: 2 },
		{ recipientBrandVersion: 2 },
		{ proposalBranding: "OTHER" },
	])(
		"refuses invalid selection %j before the feature lookup",
		async (selection) => {
			await expect(
				prepareProposalBrandingInput({ ...base, ...selection }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(gate).not.toHaveBeenCalled();
		},
	);
	it("maps atomic stale/missing-brand refusals to actionable safe errors", () => {
		expect(
			proposalBrandingAdmissionError(
				new InitialProposalBrandError("RECIPIENT_BRAND_CHANGED"),
			),
		).toMatchObject({
			code: "CONFLICT",
			data: { code: "RECIPIENT_BRAND_CHANGED" },
		});
		expect(
			proposalBrandingAdmissionError(
				new InitialProposalBrandError("RECIPIENT_BRAND_MISSING"),
			),
		).toMatchObject({ code: "BAD_REQUEST" });
		expect(
			proposalBrandingAdmissionError(
				new Error("private database detail"),
			),
		).toBeNull();
	});
});
