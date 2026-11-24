/**
 * The limits the connect dialog's disclosure names are the ones the server
 * applies. The web copies exist because the server's live in packages the
 * client bundle must not import; these imports are for the test only.
 */

import { DOCUMENT_FOLDER_IMPORT_CAP } from "@repo/database/prisma/queries/projects/document-folders";
import { describe, expect, it } from "vitest";
// The microsoft barrel loads image tooling, so the test reads the source file.
import { DRIVE_TREE_MAX_DEPTH } from "../../../../../../../../packages/integrations/src/microsoft/drive-folder";
import {
	DOCUMENT_FOLDER_IMPORT_LIMIT,
	DOCUMENT_FOLDER_READ_DEPTH,
} from "../use-document-folders";

describe("document folder limits", () => {
	it("names the server's import cap", () => {
		expect(DOCUMENT_FOLDER_IMPORT_LIMIT).toBe(DOCUMENT_FOLDER_IMPORT_CAP);
	});

	it("names the depth the folder listing reads", () => {
		expect(DOCUMENT_FOLDER_READ_DEPTH).toBe(DRIVE_TREE_MAX_DEPTH);
	});
});
