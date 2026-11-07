/**
 * `projects.proposalArtifact.getStyle` and `updateStyle` (Fizzy #2801): a
 * Proposal's style direction, colours and automatic-diagrams switch, read and
 * replaced by members of the owning organization. Validation runs at the input schema (BAD_REQUEST
 * before anything is read) and again in the query, whose refusal is mapped
 * to BAD_REQUEST too.
 *
 * Access is covered in `access.test.ts`; this file is about the values.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () =>
	(await import("./proposal-artifact-harness")).databaseModule(),
);
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./proposal-artifact-harness")).proceduresModule(),
);

import {
	DocumentStyleConflictError,
	DocumentStyleValidationError,
	ProposalArtifactTenantError,
} from "@repo/database";
import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import { getProposalStyleProcedure } from "../get-style";
import {
	updateProposalStyleInputSchema,
	updateProposalStyleProcedure,
} from "../update-style";
import {
	call,
	DOC_A,
	inputSchema,
	mocks,
	ORG_A,
	PROJECT_A,
	refusal,
	resetMocks,
	resetWorld,
	USERS,
	usePermissionCheck,
} from "./proposal-artifact-harness";

usePermissionCheck(assertProjectPermission);

const UPDATED_AT = new Date("2026-10-07T10:00:00.000Z");

function storedStyle(overrides: Record<string, unknown> = {}) {
	return {
		documentId: DOC_A,
		projectId: PROJECT_A,
		organizationId: ORG_A,
		styleDirection: "Calm and precise.",
		primaryColor: "#123456",
		accentColors: ["#abcdef", "#fedcba"],
		autoVisuals: true,
		updatedById: USERS.editor,
		updatedAt: UPDATED_AT,
		...overrides,
	};
}

const VALID = {
	projectId: PROJECT_A,
	documentId: DOC_A,
	styleDirection: "Calm and precise.",
	primaryColor: "#123456",
	accentColors: ["#abcdef", "#fedcba"],
};

function updateStyle(input: Record<string, unknown> = VALID) {
	return call(updateProposalStyleProcedure, input, USERS.editor);
}

beforeEach(() => {
	resetWorld();
	resetMocks();
	mocks.upsertDocumentStyle.mockImplementation(
		async (args: Record<string, unknown>) =>
			storedStyle({
				styleDirection: args.styleDirection,
				primaryColor: args.primaryColor,
				accentColors: args.accentColors,
				// The query keeps the stored switch when none is given.
				autoVisuals: args.autoVisuals ?? true,
				updatedById: args.updatedById,
			}),
	);
});

describe("getStyle", () => {
	it("is null until a style is saved", async () => {
		expect(
			await call(
				getProposalStyleProcedure,
				{ projectId: PROJECT_A, documentId: DOC_A },
				USERS.editor,
			),
		).toBeNull();
	});

	it("returns the saved fields and nothing about the tenant", async () => {
		mocks.getDocumentStyle.mockResolvedValue(storedStyle());

		const style = await call(
			getProposalStyleProcedure,
			{ projectId: PROJECT_A, documentId: DOC_A },
			USERS.editor,
		);

		expect(style).toEqual({
			styleDirection: "Calm and precise.",
			primaryColor: "#123456",
			accentColors: ["#abcdef", "#fedcba"],
			autoVisuals: true,
			updatedAt: UPDATED_AT,
			brandSource: "COMPANY",
			coverStyle: null,
		});
		expect(mocks.getDocumentStyle).toHaveBeenCalledWith({
			documentId: DOC_A,
			organizationId: ORG_A,
		});
	});

	it("returns a stored automatic-diagrams switch that is off", async () => {
		mocks.getDocumentStyle.mockResolvedValue(
			storedStyle({ autoVisuals: false }),
		);

		const style = await call(
			getProposalStyleProcedure,
			{ projectId: PROJECT_A, documentId: DOC_A },
			USERS.editor,
		);

		expect(style?.autoVisuals).toBe(false);
	});
});

describe("updateStyle", () => {
	it("saves every field for the owning organization, as the caller", async () => {
		const style = await updateStyle();

		expect(mocks.upsertDocumentStyle).toHaveBeenCalledWith({
			documentId: DOC_A,
			projectId: PROJECT_A,
			organizationId: ORG_A,
			styleDirection: "Calm and precise.",
			primaryColor: "#123456",
			accentColors: ["#abcdef", "#fedcba"],
			updatedById: USERS.editor,
		});
		expect(style).toEqual({
			styleDirection: "Calm and precise.",
			primaryColor: "#123456",
			accentColors: ["#abcdef", "#fedcba"],
			autoVisuals: true,
			updatedAt: UPDATED_AT,
			brandSource: "COMPANY",
			coverStyle: null,
		});
	});

	it("turns automatic diagrams off and answers with the stored switch", async () => {
		const style = await updateStyle({ ...VALID, autoVisuals: false });

		expect(mocks.upsertDocumentStyle).toHaveBeenCalledWith(
			expect.objectContaining({ autoVisuals: false }),
		);
		expect(style.autoVisuals).toBe(false);
	});

	it("passes no switch when the save leaves it out, so the stored one is kept", async () => {
		await updateStyle();

		const [args] = mocks.upsertDocumentStyle.mock.calls[0] ?? [];
		expect(args?.autoVisuals).toBeUndefined();
	});

	it("clears the direction and primary colour with null, and the accents with an empty list", async () => {
		await updateStyle({
			...VALID,
			styleDirection: null,
			primaryColor: null,
			accentColors: [],
		});

		expect(mocks.upsertDocumentStyle).toHaveBeenCalledWith(
			expect.objectContaining({
				styleDirection: null,
				primaryColor: null,
				accentColors: [],
			}),
		);
	});

	it("accepts upper-case hex and trims surrounding whitespace", async () => {
		await updateStyle({
			...VALID,
			styleDirection: "  Bold.  ",
			primaryColor: " #ABCDEF ",
			accentColors: ["#A1B2C3"],
		});

		expect(mocks.upsertDocumentStyle).toHaveBeenCalledWith(
			expect.objectContaining({
				styleDirection: "Bold.",
				primaryColor: "#ABCDEF",
				accentColors: ["#A1B2C3"],
			}),
		);
	});

	it("accepts three accents and a 500-character direction", async () => {
		await expect(
			updateStyle({
				...VALID,
				styleDirection: "x".repeat(500),
				accentColors: ["#111111", "#222222", "#333333"],
			}),
		).resolves.toBeTruthy();
	});

	describe("input validation (BAD_REQUEST at the schema, before anything is read)", () => {
		it.each([
			["an invalid primary colour", { primaryColor: "red" }],
			["a short-form primary colour", { primaryColor: "#abc" }],
			["an invalid accent colour", { accentColors: ["#12345g"] }],
			[
				"four accent colours",
				{
					accentColors: ["#111111", "#222222", "#333333", "#444444"],
				},
			],
			["a 501-character direction", { styleDirection: "x".repeat(501) }],
			["a missing accent list", { accentColors: undefined }],
			["a non-boolean diagrams switch", { autoVisuals: "false" }],
		])("refuses %s", (_label, override) => {
			const schema = inputSchema(updateProposalStyleProcedure);
			expect(schema).toBe(updateProposalStyleInputSchema);
			expect(schema.safeParse({ ...VALID, ...override }).success).toBe(
				false,
			);
		});
	});

	it("maps the query's own validation refusal to BAD_REQUEST", async () => {
		mocks.upsertDocumentStyle.mockRejectedValue(
			new DocumentStyleValidationError("tooManyAccentColors"),
		);

		const result = await refusal(updateStyle());

		expect(result.code).toBe("BAD_REQUEST");
		expect(result.data).toEqual({ code: "tooManyAccentColors" });
	});

	it("answers NOT_FOUND when the document left the organization after the access check", async () => {
		mocks.upsertDocumentStyle.mockRejectedValue(
			new ProposalArtifactTenantError(
				"The document belongs to another organization",
			),
		);

		const result = await refusal(updateStyle());

		expect(result).toMatchObject({
			code: "NOT_FOUND",
			message: "Document not found",
		});
	});

	it("lets any other failure through unchanged", async () => {
		mocks.upsertDocumentStyle.mockRejectedValue(new Error("database down"));

		await expect(updateStyle()).rejects.toThrow("database down");
	});
});

describe("reviewed proposal style transport command", () => {
	it("preserves omitted presentation fields and passes the reviewed timestamp to the shared writer", async () => {
		const { saveProposalStyleCommand } = await import(
			"../../../../branding/lib/proposal-style-commands"
		);
		mocks.getDocumentStyle.mockResolvedValue(
			storedStyle({ autoVisuals: false }),
		);
		const audit = vi.fn();
		await saveProposalStyleCommand(
			{ userId: USERS.editor, organizationId: ORG_A },
			{
				projectId: PROJECT_A,
				documentId: DOC_A,
				expectedUpdatedAt: UPDATED_AT.toISOString(),
				brandSource: "CLIENT",
				coverStyle: "MINIMAL",
			},
			audit,
		);
		expect(mocks.upsertDocumentStyle).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedUpdatedAt: UPDATED_AT,
				brandSource: "CLIENT",
				coverStyle: "MINIMAL",
				styleDirection: "Calm and precise.",
				primaryColor: "#123456",
				accentColors: ["#abcdef", "#fedcba"],
			}),
		);
		expect(
			mocks.upsertDocumentStyle.mock.calls[0][0].autoVisuals,
		).toBeUndefined();
		expect(audit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "project.updated",
				metadata: expect.objectContaining({
					operation: "proposal_style.updated",
				}),
			}),
		);
		expect(JSON.stringify(audit.mock.calls)).not.toContain(
			"Calm and precise.",
		);
	});
	it("fails closed for cross-tenant actors and invited guests", async () => {
		const { getProposalStyleCommand } = await import(
			"../../../../branding/lib/proposal-style-commands"
		);
		for (const actor of [
			{ userId: USERS.editor, organizationId: "example-other-org" },
			{ userId: USERS.guestEditor, organizationId: ORG_A },
		]) {
			await expect(
				getProposalStyleCommand(actor, {
					projectId: PROJECT_A,
					documentId: DOC_A,
				}),
			).rejects.toBeTruthy();
		}
		expect(mocks.getDocumentStyle).not.toHaveBeenCalled();
	});
	it("maps reviewed timestamp conflicts without recording a success audit", async () => {
		mocks.upsertDocumentStyle.mockRejectedValue(
			new DocumentStyleConflictError(),
		);
		const outcome = await refusal(
			updateStyle({
				...VALID,
				expectedUpdatedAt: UPDATED_AT,
				brandSource: "CLIENT",
			}),
		);
		expect(outcome.code).toBe("CONFLICT");
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});
});
