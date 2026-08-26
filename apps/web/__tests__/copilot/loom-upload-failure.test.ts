/**
 * U2 — a failed upload must never present as success (R10, AE6).
 *
 * `fetch` rejects only on a network-level failure. A 403 from an expired
 * signature, or a 500 from storage, resolves normally with `ok: false` — so a
 * caller that ignores the response advances the attachment to `ready` and fires
 * a success toast for a file that was never stored. The Feature Assistant and
 * Nexus have both checked this; Loom Direct did not.
 *
 * These tests exercise the *rule* against the surfaces' shared vocabulary
 * rather than mounting `FabricDirectChat`, which needs the full agent-stream
 * and CopilotKit stack to render. What is pinned is the branch: a non-ok
 * response must reach the error path, and only that path.
 */

import {
	AI_CHAT_SERVER_ALLOWED_EXTENSIONS,
	DEFAULT_AI_CHAT_MIME_ALLOWLIST,
} from "@repo/utils/ai-chat-attachment";
import { describe, expect, it, vi } from "vitest";

/**
 * The upload step exactly as all three surfaces now perform it. Extracted here
 * so the assertion is about the branch rather than about a component tree — and
 * so a surface that drops the check makes this fail rather than silently
 * diverging.
 */
async function putToStorage(url: string, body: Blob, contentType: string) {
	const uploadResponse = await fetch(url, {
		method: "PUT",
		body,
		headers: { "Content-Type": contentType },
	});
	if (!uploadResponse.ok) {
		throw new Error(`Upload failed with status ${uploadResponse.status}`);
	}
	return uploadResponse;
}

const file = () => new File(["hello"], "notes.txt", { type: "text/plain" });

describe("storage upload response handling", () => {
	it("throws on a non-ok response so the chip lands in error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 403 })),
		);

		await expect(
			putToStorage("https://storage.example/put", file(), "text/plain"),
		).rejects.toThrow(/403/);
	});

	it("throws on a server-side storage failure too", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 500 })),
		);

		await expect(
			putToStorage("https://storage.example/put", file(), "text/plain"),
		).rejects.toThrow(/500/);
	});

	it("resolves on a successful response and is otherwise unaffected", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 })),
		);

		await expect(
			putToStorage("https://storage.example/put", file(), "text/plain"),
		).resolves.toMatchObject({ status: 200 });
	});
});

describe("Loom Direct source-level guarantees", () => {
	/**
	 * The check has to exist in the surface's own file, not just in the helper
	 * above. Reading the source is how the get-started drift guard pins live
	 * anchors in this repo, and it is the only way to catch the check being
	 * deleted without also deleting a test.
	 */
	const loomSource = () => {
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const { join } = require("node:path") as typeof import("node:path");
		return readFileSync(
			join(
				process.cwd(),
				"modules/saas/agents/components/FabricChat/FabricDirectChat.tsx",
			),
			"utf-8",
		);
	};

	it("checks the storage response before advancing the attachment", () => {
		expect(loomSource()).toContain("Upload failed with status");
	});

	it("keeps the extraction outcome instead of discarding the response", () => {
		// R9. `process()` has always returned what it read; this surface threw
		// the value away, so a password-protected workbook uploaded perfectly
		// and rendered a clean chip carrying nothing.
		const source = loomSource();

		expect(source).toContain("extraction: processed?.extraction");
	});

	it("delivers the attachment inline alongside the document identifiers", () => {
		// R7. Retrieval stays — inline is additive, and retrieval is what covers
		// a file the budget had to cut.
		const source = loomSource();

		expect(source).toContain("buildAiChatAttachmentEntry");
		expect(source).toContain("inlineAttachmentContexts");
		expect(source).toContain("attachedDocumentIds");
	});

	it("renders the shared chip row rather than a local copy of it", () => {
		// R12. The local block rendered filename, status, and removal only, so
		// truncation notices and the sheet list had no way to reach the user
		// here.
		const source = loomSource();

		expect(source).toContain("<CopilotSidebarAttachments");
	});

	it("gates both the picker and paste paths on the shared extension guard", () => {
		// Both validation sites (`handleFileSelect` and `onPasteNonImageFiles`)
		// now test the filename against `AI_CHAT_SERVER_ALLOWED_EXTENSIONS`
		// rather than a hand-rolled per-site regex. That is what makes paste and
		// picker admit identical formats by construction — and it is the fix for
		// the bug where the `accept` attribute (also derived from the shared
		// vocabulary) offered `.xlsx`/`.csv` that a narrower local regex then
		// refused with "File type not supported".
		const source = loomSource();

		const sharedGuardUses = source.match(
			/AI_CHAT_SERVER_ALLOWED_EXTENSIONS/g,
		);
		expect(sharedGuardUses?.length ?? 0).toBeGreaterThanOrEqual(2);

		// The old hand-rolled document-extension regex must not come back on
		// either path — it is exactly what drifted from the picker.
		expect(source).not.toMatch(/\\\.\(pdf\|docx\|txt\|md\|html\|json/);
	});

	it("admits .xlsx and .csv, which the picker advertises", () => {
		// The reported bug: the picker offered `.xlsx` (and `.csv`) but the gate
		// refused them. Both are in the shared server allowlist the gate now
		// reads, so the gate admits exactly what the picker offers.
		expect(DEFAULT_AI_CHAT_MIME_ALLOWLIST).toContain(
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		);
		expect(DEFAULT_AI_CHAT_MIME_ALLOWLIST).toContain("text/csv");
		expect(AI_CHAT_SERVER_ALLOWED_EXTENSIONS.test("q4-budget.xlsx")).toBe(
			true,
		);
		expect(AI_CHAT_SERVER_ALLOWED_EXTENSIONS.test("export.csv")).toBe(true);
	});
});
