/**
 * Storing a finished Proposal export (Fizzy #2946): a private object under
 * the project's export prefix in the project contexts bucket, keyed by the
 * export's own id so a retried attempt overwrites its own file. Storage is a
 * mock that records the upload.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ uploadFile: vi.fn() }));

vi.mock("@repo/storage", () => ({ uploadFile: storage.uploadFile }));

import { config } from "@repo/config";
import { proposalExportProjectPrefix } from "../../../lib/proposal-export/types";
import { proposalExportKey, uploadProposalExport } from "../upload-export";

const EXPORT_ID = `proposal-export-${"ab".repeat(16)}`;

beforeEach(() => {
	storage.uploadFile.mockReset();
	storage.uploadFile.mockResolvedValue({});
});

describe("uploadProposalExport", () => {
	it.each([
		["pdf", "application/pdf"],
		[
			"docx",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		],
	] as const)(
		"stores a %s privately under the project's export prefix",
		async (format, contentType) => {
			const bytes = Buffer.from("example file");
			const result = await uploadProposalExport({
				exportId: EXPORT_ID,
				projectId: "project-example-1",
				format,
				bytes,
			});

			const key = `proposal-exports/project-example-1/${EXPORT_ID}.${format}`;
			expect(result).toEqual({ key, contentType });
			expect(
				key.startsWith(
					proposalExportProjectPrefix("project-example-1"),
				),
			).toBe(true);
			expect(storage.uploadFile).toHaveBeenCalledTimes(1);
			expect(storage.uploadFile).toHaveBeenCalledWith(key, bytes, {
				bucket: config.storage.bucketNames.projectContexts,
				contentType,
				access: "private",
			});
		},
	);

	it("names a retried attempt's file the same, so it overwrites rather than adds", () => {
		expect(proposalExportKey("project-example-1", EXPORT_ID, "pdf")).toBe(
			proposalExportKey("project-example-1", EXPORT_ID, "pdf"),
		);
	});
});
