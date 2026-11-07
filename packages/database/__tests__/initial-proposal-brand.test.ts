import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	transaction: vi.fn(),
	queryRaw: vi.fn(),
	projectFind: vi.fn(),
	documentCreate: vi.fn(),
	versionCreate: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: { $transaction: mocks.transaction },
	Prisma: { DbNull: Symbol("DbNull") },
}));

import { createDocument } from "../prisma/queries/projects/documents";
import {
	InitialProposalBrandError,
	resolveInitialProposalStyle,
} from "../prisma/queries/projects/initial-proposal-brand";

const tx = {
	$queryRaw: mocks.queryRaw,
	project: { findUnique: mocks.projectFind },
	projectDocument: { create: mocks.documentCreate },
	documentVersion: { create: mocks.versionCreate },
};
const selection = {
	projectId: "example-project",
	organizationId: "example-org",
	type: "PROPOSAL",
	proposalBranding: "CLIENT" as const,
	recipientBrandVersion: 3,
};
const createInput = {
	projectId: selection.projectId,
	type: "PROPOSAL" as const,
	title: "Example client proposal",
	content: "Delivery plan",
	userId: "example-user",
	proposalBranding: "CLIENT" as const,
	recipientBrandVersion: 3,
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.transaction.mockImplementation(async (work) => work(tx));
	mocks.projectFind.mockResolvedValue({ organizationId: "example-org" });
	mocks.queryRaw.mockResolvedValue([
		{ organizationId: "example-org", version: 3, colors: ["#0f766e"] },
	]);
	mocks.documentCreate.mockResolvedValue({ id: "example-document" });
	mocks.versionCreate.mockResolvedValue({ id: "example-version" });
});

describe("initial proposal brand admission", () => {
	it("locks the reviewed brand using a parameterized project id", async () => {
		expect(await resolveInitialProposalStyle(tx, selection)).toEqual({
			primaryColor: "#0f766e",
			brandSource: "CLIENT",
			accentColors: ["#0f766e"],
		});
		const [strings, projectId] = mocks.queryRaw.mock.calls[0] ?? [];
		expect(strings.join("?")).toContain('WHERE "projectId" = ?');
		expect(strings.join("?")).toContain("FOR SHARE");
		expect(projectId).toBe("example-project");
	});

	it("preserves company inheritance and old callers without an additional read", async () => {
		expect(
			await resolveInitialProposalStyle(tx, {
				...selection,
				proposalBranding: "COMPANY",
			}),
		).toBeNull();
		expect(
			await resolveInitialProposalStyle(tx, {
				projectId: selection.projectId,
				organizationId: selection.organizationId,
				type: "PRD",
			}),
		).toBeNull();
		expect(mocks.queryRaw).not.toHaveBeenCalled();
	});

	it("requires a client choice on a proposal in an organization with a reviewed version", async () => {
		for (const change of [
			{ type: "PRD" },
			{ organizationId: null },
			{ recipientBrandVersion: undefined },
			{ recipientBrandVersion: 0 },
			{ recipientBrandVersion: 1.5 },
		]) {
			await expect(
				resolveInitialProposalStyle(tx, { ...selection, ...change }),
			).rejects.toMatchObject({ code: "INVALID_PROPOSAL_BRANDING" });
		}
		expect(mocks.queryRaw).not.toHaveBeenCalled();
	});

	it("does not expose or use another organization's brand", async () => {
		mocks.queryRaw.mockResolvedValue([
			{
				organizationId: "other-example-org",
				version: 3,
				colors: ["#ff0000"],
			},
		]);
		await expect(
			resolveInitialProposalStyle(tx, selection),
		).rejects.toMatchObject({ code: "RECIPIENT_BRAND_MISSING" });
	});

	it("refuses stale review and absent or unusable colors", async () => {
		mocks.queryRaw.mockResolvedValueOnce([
			{ organizationId: "example-org", version: 4, colors: ["#0f766e"] },
		]);
		await expect(
			resolveInitialProposalStyle(tx, selection),
		).rejects.toMatchObject({ code: "RECIPIENT_BRAND_CHANGED" });
		for (const rows of [
			[],
			[{ organizationId: "example-org", version: 3, colors: [] }],
			[{ organizationId: "example-org", version: 3, colors: ["red"] }],
		]) {
			mocks.queryRaw.mockResolvedValueOnce(rows);
			await expect(
				resolveInitialProposalStyle(tx, selection),
			).rejects.toMatchObject({ code: "RECIPIENT_BRAND_MISSING" });
		}
	});

	it("creates the document, reviewed palette and initial version in one transaction", async () => {
		await createDocument(createInput);
		expect(mocks.transaction).toHaveBeenCalledTimes(1);
		expect(mocks.documentCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				organizationId: "example-org",
				style: {
					create: {
						primaryColor: "#0f766e",
						brandSource: "CLIENT",
						accentColors: ["#0f766e"],
						projectId: "example-project",
						organizationId: "example-org",
						updatedById: "example-user",
					},
				},
			}),
		});
		expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.documentCreate.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mocks.versionCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				documentId: "example-document",
				organizationId: "example-org",
			}),
		});
	});

	it("rejects changed client branding before any document or version is written", async () => {
		mocks.queryRaw.mockResolvedValueOnce([
			{ organizationId: "example-org", version: 4, colors: ["#0f766e"] },
		]);
		await expect(createDocument(createInput)).rejects.toBeInstanceOf(
			InitialProposalBrandError,
		);
		expect(mocks.documentCreate).not.toHaveBeenCalled();
		expect(mocks.versionCreate).not.toHaveBeenCalled();
	});

	it("propagates nested style/write failures to roll back the creation transaction", async () => {
		mocks.documentCreate.mockRejectedValueOnce(
			new Error("Style insert failed"),
		);
		await expect(createDocument(createInput)).rejects.toThrow(
			"Style insert failed",
		);
		expect(mocks.versionCreate).not.toHaveBeenCalled();
	});
});
