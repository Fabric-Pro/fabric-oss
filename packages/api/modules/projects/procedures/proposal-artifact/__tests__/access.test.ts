/**
 * Who reaches a Proposal's Internal Analysis and Style (Fizzy #2801): members
 * of the project's owning organization, with the rollout gate on for that
 * organization, and nobody else — a project guest least of all, whatever
 * their project role.
 *
 * The gate middleware, the permission decision and the access loader are the
 * real ones, run in each procedure's declared order over the world in
 * `proposal-artifact-harness.ts`; the analysis and style queries are mocks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () =>
	(await import("./proposal-artifact-harness")).databaseModule(),
);
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./proposal-artifact-harness")).proceduresModule(),
);

import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import { ORGANIZATION_MEMBERSHIP_REQUIRED_CODE } from "../../../lib/proposal-artifact-access";
import { getProposalAnalysisProcedure } from "../get-analysis";
import { getProposalStyleProcedure } from "../get-style";
import { updateProposalStyleProcedure } from "../update-style";
import {
	call,
	DOC_A,
	DOC_A2,
	DOC_B,
	DOC_PRD,
	declaredPermission,
	mocks,
	ORG_A,
	ORG_B,
	ORG_GUEST,
	PROJECT_A,
	PROJECT_B,
	refusal,
	resetMocks,
	resetWorld,
	USERS,
	usePermissionCheck,
	world,
} from "./proposal-artifact-harness";

usePermissionCheck(assertProjectPermission);

const STYLE_INPUT = {
	styleDirection: "Calm and precise.",
	primaryColor: "#123456",
	accentColors: ["#abcdef"],
};

const PROCEDURES = [
	{ name: "getAnalysis", procedure: getProposalAnalysisProcedure, extra: {} },
	{ name: "getStyle", procedure: getProposalStyleProcedure, extra: {} },
	{
		name: "updateStyle",
		procedure: updateProposalStyleProcedure,
		extra: STYLE_INPUT,
	},
] as const;

function callAs(
	entry: (typeof PROCEDURES)[number],
	userId: string,
	ids: { projectId: string; documentId: string } = {
		projectId: PROJECT_A,
		documentId: DOC_A,
	},
) {
	return call(entry.procedure, { ...ids, ...entry.extra }, userId);
}

function nothingRead() {
	expect(mocks.getLatestAnalysisForDocument).not.toHaveBeenCalled();
	expect(mocks.getDocumentStyle).not.toHaveBeenCalled();
	expect(mocks.upsertDocumentStyle).not.toHaveBeenCalled();
}

beforeEach(() => {
	resetWorld();
	resetMocks();
	mocks.upsertDocumentStyle.mockResolvedValue({
		documentId: DOC_A,
		projectId: PROJECT_A,
		organizationId: ORG_A,
		styleDirection: "Calm and precise.",
		primaryColor: "#123456",
		accentColors: ["#abcdef"],
		updatedById: USERS.editor,
		updatedAt: new Date("2026-10-07T10:00:00.000Z"),
	});
});

describe("declared permissions", () => {
	it("reads need DOCUMENT_READ and the style write needs DOCUMENT_UPDATE", () => {
		expect(declaredPermission(getProposalAnalysisProcedure)).toBe(
			"document:read",
		);
		expect(declaredPermission(getProposalStyleProcedure)).toBe(
			"document:read",
		);
		expect(declaredPermission(updateProposalStyleProcedure)).toBe(
			"document:update",
		);
	});
});

describe.each(PROCEDURES)("$name", (entry) => {
	it("refuses a project guest with an EDITOR role, naming the membership it lacks", async () => {
		const result = await refusal(callAs(entry, USERS.guestEditor));

		expect(result.code).toBe("FORBIDDEN");
		expect(result.data).toEqual({
			code: ORGANIZATION_MEMBERSHIP_REQUIRED_CODE,
		});
		expect(mocks.isOrganizationMember).toHaveBeenCalledWith(
			USERS.guestEditor,
			ORG_A,
		);
		nothingRead();
	});

	it("refuses a project guest with a VIEWER role", async () => {
		expect((await refusal(callAs(entry, USERS.guestViewer))).code).toBe(
			"FORBIDDEN",
		);
		nothingRead();
	});

	it("scopes every read to the owning organization, never the guest's session organization, even with the membership check stubbed to pass", async () => {
		// The guest's session names their own workspace (ORG_GUEST). With the
		// membership check forced open, the only thing left deciding which
		// rows are read is the organization this procedure resolved — and it
		// must be the project's, so a guest's own workspace never selects
		// anything and the membership asked about is the owning one.
		mocks.isOrganizationMember.mockResolvedValue(true);

		await callAs(entry, USERS.guestEditor).catch(() => undefined);

		expect(mocks.isOrganizationMember).toHaveBeenCalledWith(
			USERS.guestEditor,
			ORG_A,
		);
		expect(mocks.isOrganizationMember).not.toHaveBeenCalledWith(
			USERS.guestEditor,
			ORG_GUEST,
		);
		const reads = [
			mocks.getLatestAnalysisForDocument,
			mocks.getDocumentStyle,
			mocks.upsertDocumentStyle,
		].flatMap((query) => query.mock.calls.map(([args]) => args));
		expect(reads.length).toBeGreaterThan(0);
		for (const args of reads) {
			expect(args).toMatchObject({ organizationId: ORG_A });
		}
	});

	it("refuses a member of another organization naming this project's document", async () => {
		const result = await refusal(callAs(entry, USERS.outsider));

		expect(result).toMatchObject({
			code: "NOT_FOUND",
			message: "Project not found",
		});
		nothingRead();
	});

	it("refuses another organization's document named under this project", async () => {
		const result = await refusal(
			callAs(entry, USERS.editor, {
				projectId: PROJECT_A,
				documentId: DOC_B,
			}),
		);

		expect(result).toMatchObject({
			code: "NOT_FOUND",
			message: "Document not found",
		});
		nothingRead();
	});

	it("refuses a document of another project in the same organization", async () => {
		const result = await refusal(
			callAs(entry, USERS.owner, {
				projectId: PROJECT_A,
				documentId: DOC_A2,
			}),
		);

		expect(result).toMatchObject({
			code: "NOT_FOUND",
			message: "Document not found",
		});
		nothingRead();
	});

	it("refuses an outsider pairing their own project with this document", async () => {
		const result = await refusal(
			callAs(entry, USERS.outsider, {
				projectId: PROJECT_B,
				documentId: DOC_A,
			}),
		);

		expect(result.code).toBe("NOT_FOUND");
		nothingRead();
	});

	it("answers NOT_FOUND to every caller with the gate off, before the permission check", async () => {
		world.flags.set(ORG_A, false);

		for (const userId of [
			USERS.owner,
			USERS.editor,
			USERS.memberViewer,
			USERS.guestEditor,
			USERS.outsider,
		]) {
			expect(await refusal(callAs(entry, userId))).toEqual({
				code: "NOT_FOUND",
				message: "Project not found",
				data: undefined,
			});
		}
		expect(mocks.isOrganizationMember).not.toHaveBeenCalled();
		nothingRead();
	});

	it("resolves the gate for the owning organization, not another one", async () => {
		// Org B's gate off changes nothing for org A's project.
		world.flags.set(ORG_B, false);
		await expect(callAs(entry, USERS.editor)).resolves.not.toThrow();

		// And org B's gate on does not open org A's project.
		world.flags.set(ORG_A, false);
		world.flags.set(ORG_B, true);
		expect((await refusal(callAs(entry, USERS.editor))).code).toBe(
			"NOT_FOUND",
		);
	});

	it("treats a trashed project as missing", async () => {
		const project = world.projects.get(PROJECT_A);
		world.projects.set(PROJECT_A, {
			...(project as NonNullable<typeof project>),
			deletedAt: new Date("2026-10-01T00:00:00.000Z"),
		});

		expect((await refusal(callAs(entry, USERS.editor))).code).toBe(
			"NOT_FOUND",
		);
		nothingRead();
	});

	it("refuses a document that is not a Proposal", async () => {
		const result = await refusal(
			callAs(entry, USERS.editor, {
				projectId: PROJECT_A,
				documentId: DOC_PRD,
			}),
		);

		expect(result.code).toBe("BAD_REQUEST");
		nothingRead();
	});

	it("serves the project owner and an org member who edits the project", async () => {
		await expect(callAs(entry, USERS.owner)).resolves.not.toThrow();
		await expect(callAs(entry, USERS.editor)).resolves.not.toThrow();
	});
});

describe("an organization member with a VIEWER project role", () => {
	it("reads the Internal Analysis and the Style", async () => {
		await expect(
			call(
				getProposalAnalysisProcedure,
				{ projectId: PROJECT_A, documentId: DOC_A },
				USERS.memberViewer,
			),
		).resolves.toBeNull();
		await expect(
			call(
				getProposalStyleProcedure,
				{ projectId: PROJECT_A, documentId: DOC_A },
				USERS.memberViewer,
			),
		).resolves.toBeNull();

		expect(mocks.getLatestAnalysisForDocument).toHaveBeenCalledWith({
			documentId: DOC_A,
			organizationId: ORG_A,
		});
		expect(mocks.getDocumentStyle).toHaveBeenCalledWith({
			documentId: DOC_A,
			organizationId: ORG_A,
		});
	});

	it("cannot update the Style", async () => {
		const result = await refusal(
			call(
				updateProposalStyleProcedure,
				{ projectId: PROJECT_A, documentId: DOC_A, ...STYLE_INPUT },
				USERS.memberViewer,
			),
		);

		expect(result.code).toBe("FORBIDDEN");
		expect(mocks.upsertDocumentStyle).not.toHaveBeenCalled();
	});
});
