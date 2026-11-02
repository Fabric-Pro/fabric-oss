/**
 * References to stored objects in a client Proposal's text (Fizzy #2946):
 * a file that leaves the app carries no storage key and no signed URL.
 */

import { describe, expect, it } from "vitest";
import {
	STORAGE_REFERENCE,
	withoutStorageReferences,
	withoutStoredObjects,
} from "../lib/proposal-artifact/storage-references";

const SIGNED =
	"https://storage.example.com/document-media/project-example/document-example/x.png?X-Amz-Signature=abc";

describe("withoutStorageReferences", () => {
	it("removes the token that holds the reference and leaves the syntax around it", () => {
		expect(withoutStorageReferences(`See ${SIGNED} today.`)).toBe(
			"See  today.",
		);
		expect(withoutStorageReferences(`A["Brief ${SIGNED}"] --> B`)).toBe(
			'A["Brief "] --> B',
		);
		expect(
			withoutStorageReferences(
				"Logo at project-brand/p/recipient/logo.png.",
			),
		).toBe("Logo at ");
	});

	it("leaves ordinary paths and public URLs alone", () => {
		const text = "Read https://example.com/docs/projects/guide.html first.";
		expect(withoutStorageReferences(text)).toBe(text);
	});
});

describe("withoutStoredObjects", () => {
	it("drops an image tag or a Markdown image that names a stored object, whole", () => {
		const markdown = [
			"Intro.",
			`<img src="${SIGNED}" alt="27" display.png" width="320" data-s3-key="document-media/p/d/x.png" />`,
			"",
			"*Figure caption*",
			"",
			`![Site plan](${SIGNED} "Plan")`,
			"",
			"End.",
		].join("\n");

		const out = withoutStoredObjects(markdown);

		expect(out).not.toMatch(STORAGE_REFERENCE);
		expect(out).not.toContain("<img");
		expect(out).not.toContain("![Site plan]");
		expect(out).toContain("*Figure caption*");
		expect(out).toContain("Intro.");
		expect(out).toContain("End.");
	});

	it("keeps a link to a stored object as its words, and any other link whole", () => {
		const out = withoutStoredObjects(
			`Read [the brief](${SIGNED}) and [our site](https://example.com/about).`,
		);

		expect(out).toBe(
			"Read the brief and [our site](https://example.com/about).",
		);
	});

	it("removes a reference written in prose, code or a diagram", () => {
		const out = withoutStoredObjects(
			[
				"Unsigned: https://storage.example.com/document-media/p/d/y.png here.",
				"",
				"```bash",
				`curl ${SIGNED}`,
				"```",
				"",
				"```mermaid",
				"flowchart LR",
				`  A["Brief ${SIGNED}"] --> B[Build]`,
				"```",
			].join("\n"),
		);

		expect(out).not.toMatch(STORAGE_REFERENCE);
		expect(out).toContain("here.");
		expect(out).toContain("curl ");
		expect(out).toContain('A["Brief "] --> B[Build]');
	});

	it("keeps images already embedded as data URLs and images hosted elsewhere", () => {
		const embedded =
			'<img src="data:image/png;base64,iVBORw0KGgo+/AAAA" alt="Chart" width="320" />';
		const hosted = "![Logo](https://example.com/logo.png)";
		const markdown = `${embedded}\n\n${hosted}`;

		expect(withoutStoredObjects(markdown)).toBe(markdown);
	});
});
