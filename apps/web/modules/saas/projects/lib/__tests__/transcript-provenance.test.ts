import { describe, expect, it } from "vitest";
import { transcriptProvenanceLabel } from "../transcript-provenance";

describe("transcriptProvenanceLabel", () => {
	it.each([
		[{ total: 3, imported: 0, uploaded: 0 }, "Synced from Microsoft Teams"],
		[{ total: 0, imported: 0, uploaded: 0 }, "Synced from Microsoft Teams"],
		[
			{ total: 2, imported: 2, uploaded: 0 },
			"Added from a personal calendar",
		],
		[{ total: 2, imported: 0, uploaded: 2 }, "Uploaded as files"],
		[
			{ total: 3, imported: 1, uploaded: 0 },
			"Synced from Microsoft Teams · 1 added from a personal calendar",
		],
		[
			{ total: 3, imported: 0, uploaded: 1 },
			"Synced from Microsoft Teams · 1 uploaded as files",
		],
		[
			{ total: 4, imported: 1, uploaded: 1 },
			"Synced from Microsoft Teams · 1 added from a personal calendar · 1 uploaded as files",
		],
		[
			{ total: 2, imported: 1, uploaded: 1 },
			"1 added from a personal calendar · 1 uploaded as files",
		],
		// #3507: a folder import is neither a sync nor an upload.
		[
			{ total: 2, imported: 0, uploaded: 0, fromOneDrive: 2 },
			"Imported from OneDrive folders",
		],
		[
			{ total: 4, imported: 0, uploaded: 1, fromOneDrive: 2 },
			"Synced from Microsoft Teams · 1 uploaded as files · 2 imported from OneDrive folders",
		],
	])("%j", (counts, label) => {
		expect(transcriptProvenanceLabel(counts)).toBe(label);
	});
});
