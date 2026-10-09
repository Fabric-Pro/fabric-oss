/**
 * `projects.proposalArtifact.getStyle` and `updateStyle` (Fizzy #2801): a
 * Proposal's style direction and colours, read and replaced by members of
 * the owning organization. Validation runs at the input schema (BAD_REQUEST
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
			updatedAt: UPDATED_AT,
		});
		expect(mocks.getDocumentStyle).toHaveBeenCalledWith({
			documentId: DOC_A,
			organizationId: ORG_A,
		});
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
			updatedAt: UPDATED_AT,
		});
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
