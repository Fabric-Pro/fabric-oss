/**
 * What a Proposal export reads, and the access check that comes first
 * (Fizzy #2946). The worker re-checks everything the procedure checked,
 * because only ids travel to it and access may have changed since: the
 * project's organization and trash state, the document's project, the
 * starter's project access and the client-document gate. Any failure is the
 * same non-retryable `EXPORT_ACCESS_DENIED`, and the brand is never read for
 * a refused export. The brand is read through the guest-safe resolver for
 * everyone, so the organization's style direction and Brand kit guidance
 * never reach the worker.
 *
 * Mocked: `@repo/database` (the two row reads, the access and gate
 * predicates, the guest-safe resolver, and the member resolver as a spy that
 * must never be called).
 */

import { buildProposalThemeTokens } from "@repo/utils/proposal-artifact/theme-tokens";
import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	findProject: vi.fn(),
	findDocument: vi.fn(),
	hasProjectAccess: vi.fn(),
	isProposalClientDocument: vi.fn(),
	resolveGuestSafeProposalThemeTokens: vi.fn(),
	resolveProposalThemeTokens: vi.fn(),
	isOrganizationMember: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: db.findProject },
		projectDocument: { findFirst: db.findDocument },
	},
	hasProjectAccess: db.hasProjectAccess,
	isProposalClientDocument: db.isProposalClientDocument,
	resolveGuestSafeProposalThemeTokens: db.resolveGuestSafeProposalThemeTokens,
	resolveProposalThemeTokens: db.resolveProposalThemeTokens,
	isOrganizationMember: db.isOrganizationMember,
}));

import type { ProposalExportWorkflowInput } from "../../../lib/proposal-export/types";
import { exportDateLabel, loadExportInput } from "../load-export-input";

const INPUT: ProposalExportWorkflowInput = {
	exportId: "proposal-export-0123456789abcdef0123456789abcdef",
	userId: "user-guest-1",
	organizationId: "org-example-1",
	projectId: "project-example-1",
	documentId: "document-example-1",
	format: "pdf",
};

const GUEST_SAFE_TOKENS = buildProposalThemeTokens({
	organization: { name: "Example Org", logoKey: "org-example-1.png" },
	style: { primaryColor: "#1f3a6b", accentColors: ["#8a5a00"] },
	brandKit: { accentColors: ["#225588"] },
	recipient: {
		name: "Example Client",
		logoKey:
			"project-brand/project-example-1/recipient-brand/current/abc123.png",
		colors: ["#aa3300"],
	},
});

/** What the member resolver would add, if anything ever called it. */
const MEMBER_TOKENS = {
	...GUEST_SAFE_TOKENS,
	styleDirection: "Example internal style direction",
	brandGuidance: "Example internal Brand kit guidance",
	guidance: "Example internal guidance",
};

const FORBIDDEN_KEYS = ["styleDirection", "brandGuidance", "guidance"];

/** Every key at any depth of `value`. */
function deepKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) {
			deepKeys(item, into);
		}
	} else if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) {
			into.add(key);
			deepKeys(child, into);
		}
	}
	return into;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject");
}

beforeEach(() => {
	for (const mock of Object.values(db)) {
		mock.mockReset();
	}
	db.findProject.mockResolvedValue({
		organizationId: INPUT.organizationId,
		deletedAt: null,
	});
	db.findDocument.mockResolvedValue({
		id: INPUT.documentId,
		type: "PROPOSAL",
		title: "Example Proposal",
		content: "# Example Proposal\n\n## Overview\n\nExample body.",
	});
	// A project guest: project access, no organization membership.
	db.hasProjectAccess.mockResolvedValue(true);
	db.isOrganizationMember.mockResolvedValue(false);
	db.isProposalClientDocument.mockResolvedValue(true);
	db.resolveGuestSafeProposalThemeTokens.mockResolvedValue(GUEST_SAFE_TOKENS);
	db.resolveProposalThemeTokens.mockResolvedValue(MEMBER_TOKENS);
});

describe("loadExportInput: an allowed export", () => {
	it("gives a project guest the document and the guest-safe brand", async () => {
		const loaded = await loadExportInput(INPUT);

		expect(loaded).toEqual({
			title: "Example Proposal",
			content: "# Example Proposal\n\n## Overview\n\nExample body.",
			tokens: GUEST_SAFE_TOKENS,
		});
		expect(db.resolveGuestSafeProposalThemeTokens).toHaveBeenCalledWith({
			organizationId: INPUT.organizationId,
			projectId: INPUT.projectId,
			documentId: INPUT.documentId,
		});
		expect(db.resolveProposalThemeTokens).not.toHaveBeenCalled();
	});

	it("drops storage references from the title and the parties' names", async () => {
		const signed =
			"https://storage.example.com/document-media/project-example-1/document-example-1/x.png?X-Amz-Signature=abc";
		db.findDocument.mockResolvedValue({
			id: INPUT.documentId,
			type: "PROPOSAL",
			title: `Example Proposal ${signed}`,
			content: "Example body.",
		});
		db.resolveGuestSafeProposalThemeTokens.mockResolvedValue({
			...GUEST_SAFE_TOKENS,
			proposer: {
				...GUEST_SAFE_TOKENS.proposer,
				name: { value: `Example Org ${signed}`, source: "BRAND_KIT" },
			},
			recipient: {
				...GUEST_SAFE_TOKENS.recipient,
				name: { value: signed, source: "BRAND_KIT" },
			},
		});

		const loaded = await loadExportInput(INPUT);

		expect(loaded.title).toBe("Example Proposal");
		expect(loaded.tokens.proposer.name.value).toBe("Example Org");
		expect(loaded.tokens.recipient.name.value).toBeNull();
		expect(JSON.stringify(loaded)).not.toMatch(
			/X-Amz|document-media\/project/,
		);
	});

	it("carries no style direction or Brand kit guidance anywhere in what it returns", async () => {
		const loaded = await loadExportInput(INPUT);

		const keys = deepKeys(loaded);
		for (const key of FORBIDDEN_KEYS) {
			expect(keys.has(key)).toBe(false);
		}
	});

	it("reads the project and the document scoped by their ids", async () => {
		await loadExportInput(INPUT);

		expect(db.findProject).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: INPUT.projectId } }),
		);
		expect(db.findDocument).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: INPUT.documentId, projectId: INPUT.projectId },
			}),
		);
	});

	it("checks project access as (projectId, userId)", async () => {
		await loadExportInput(INPUT);

		expect(db.hasProjectAccess).toHaveBeenCalledTimes(1);
		expect(db.hasProjectAccess).toHaveBeenCalledWith(
			INPUT.projectId,
			INPUT.userId,
		);
	});

	it("asks the client-document gate of the owning organization about the document's type", async () => {
		await loadExportInput(INPUT);

		expect(db.isProposalClientDocument).toHaveBeenCalledWith({
			organizationId: INPUT.organizationId,
			documentType: "PROPOSAL",
		});
	});

	it("falls back to 'Proposal' for a blank title and to empty content", async () => {
		db.findDocument.mockResolvedValue({
			id: INPUT.documentId,
			type: "PROPOSAL",
			title: "   ",
			content: null,
		});

		const loaded = await loadExportInput(INPUT);

		expect(loaded.title).toBe("Proposal");
		expect(loaded.content).toBe("");
	});
});

describe("loadExportInput: a refused export", () => {
	const refusals: [string, () => void][] = [
		[
			"the project no longer exists",
			() => db.findProject.mockResolvedValue(null),
		],
		[
			"the project is in the trash",
			() =>
				db.findProject.mockResolvedValue({
					organizationId: INPUT.organizationId,
					deletedAt: new Date("2026-10-01T00:00:00Z"),
				}),
		],
		[
			"the project now belongs to another organization",
			() =>
				db.findProject.mockResolvedValue({
					organizationId: "org-example-2",
					deletedAt: null,
				}),
		],
		[
			"the document is not in the project",
			() => db.findDocument.mockResolvedValue(null),
		],
		[
			"the starter lost project access",
			() => db.hasProjectAccess.mockResolvedValue(false),
		],
		[
			"the document is a Business Case",
			() => {
				db.findDocument.mockResolvedValue({
					id: INPUT.documentId,
					type: "BUSINESS_CASE",
					title: "Example Business Case",
					content: "# Example",
				});
				db.isProposalClientDocument.mockResolvedValue(false);
			},
		],
		[
			"the client-document gate is off",
			() => db.isProposalClientDocument.mockResolvedValue(false),
		],
	];

	it.each(refusals)(
		"refuses with a non-retryable EXPORT_ACCESS_DENIED when %s, without reading the brand",
		async (_case, arrange) => {
			arrange();

			const error = await rejection(loadExportInput(INPUT));

			expect(error).toBeInstanceOf(ApplicationFailure);
			expect(error).toMatchObject({
				type: "EXPORT_ACCESS_DENIED",
				nonRetryable: true,
			});
			expect(
				db.resolveGuestSafeProposalThemeTokens,
			).not.toHaveBeenCalled();
			expect(db.resolveProposalThemeTokens).not.toHaveBeenCalled();
		},
	);

	it("names nothing about the document in the failure", async () => {
		db.hasProjectAccess.mockResolvedValue(false);

		const error = (await rejection(loadExportInput(INPUT))) as Error;

		expect(error.message).not.toContain(INPUT.documentId);
		expect(error.message).not.toContain(INPUT.projectId);
		expect(error.message).not.toContain("Example Proposal");
	});
});

describe("exportDateLabel", () => {
	it("prints the long US date of the UTC day", () => {
		expect(exportDateLabel(new Date("2026-10-15T23:30:00Z"))).toBe(
			"October 15, 2026",
		);
	});

	it("prints the same day at both ends of a UTC day, whatever the worker's time zone", () => {
		// In any zone but UTC one of these instants falls on another local day.
		expect(exportDateLabel(new Date("2026-10-15T00:30:00Z"))).toBe(
			"October 15, 2026",
		);
		expect(exportDateLabel(new Date("2026-10-15T23:59:59Z"))).toBe(
			"October 15, 2026",
		);
	});
});
