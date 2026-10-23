/**
 * The Proposal export activity end to end for a Word file (Fizzy #2946):
 * the real markdown preparation, diagram step and DOCX writer, with only the
 * edges replaced (the document read, storage, the database and the upload).
 * A Word export of a document without diagrams runs without a browser, so
 * this is the path that proves the stages fit together there.
 */

import { buildProposalThemeTokens } from "@repo/utils/proposal-artifact/theme-tokens";
import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";

const edges = vi.hoisted(() => ({
	loadExportInput: vi.fn(),
	uploadProposalExport: vi.fn(),
	withExportBrowser: vi.fn(),
}));

vi.mock("../load-export-input", async (importOriginal) => ({
	...(await importOriginal<typeof import("../load-export-input")>()),
	loadExportInput: edges.loadExportInput,
}));
vi.mock("../upload-export", () => ({
	uploadProposalExport: edges.uploadProposalExport,
}));
vi.mock("../../../lib/proposal-export/browser", () => ({
	withExportBrowser: edges.withExportBrowser,
}));
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	trustedOrganizationLogoKey: vi.fn(() => null),
	isRecipientLogoKeyForProject: vi.fn(() => false),
	recordProposalExportBrand: vi.fn(async () => true),
}));
vi.mock("@repo/storage", () => ({
	downloadFile: vi.fn(async () => {
		throw new Error("no storage in this test");
	}),
	uploadFile: vi.fn(),
}));

import { exportProposalDocumentActivity } from "../export-proposal";

const INPUT = {
	exportId: `proposal-export-${"cd".repeat(16)}`,
	userId: "user-example",
	organizationId: "org-example",
	projectId: "project-example-1",
	documentId: "document-example-1",
	format: "docx" as const,
};

beforeEach(() => {
	for (const mock of Object.values(edges)) {
		mock.mockReset();
	}
	edges.loadExportInput.mockResolvedValue({
		title: "Example Proposal",
		content: [
			"# Example Proposal",
			"",
			"## Approach",
			"",
			"We start with discovery [S1].",
			"",
			"## Source Index",
			"",
			"- [S1] Kickoff notes",
		].join("\n"),
		tokens: buildProposalThemeTokens({
			organization: { name: "Example Org", logoKey: null },
			style: null,
			brandKit: null,
			recipient: null,
		}),
	});
	edges.uploadProposalExport.mockImplementation(
		async (args: {
			projectId: string;
			exportId: string;
			format: string;
		}) => ({
			key: `proposal-exports/${args.projectId}/${args.exportId}.${args.format}`,
			contentType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		}),
	);
});

describe("exportProposalDocumentActivity, Word without diagrams", () => {
	it("writes and uploads a Word file without opening a browser", async () => {
		const result = await exportProposalDocumentActivity(INPUT);

		expect(edges.withExportBrowser).not.toHaveBeenCalled();
		expect(edges.uploadProposalExport).toHaveBeenCalledTimes(1);
		const { bytes } = edges.uploadProposalExport.mock.calls[0][0] as {
			bytes: Buffer;
		};
		expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
		const documentXml = await (await JSZip.loadAsync(bytes))
			.file("word/document.xml")
			?.async("string");
		expect(documentXml).toContain("We start with discovery");
		expect(documentXml).not.toMatch(/\[S1\]|Source Index|Kickoff notes/);
		expect(result).toMatchObject({
			key: `proposal-exports/project-example-1/${INPUT.exportId}.docx`,
			fileName: "example-proposal.docx",
			warnings: [],
		});
	});
});
