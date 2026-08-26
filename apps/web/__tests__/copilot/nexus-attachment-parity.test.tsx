/**
 * U6 — Nexus gains per-file attachment state (R9).
 *
 * Nexus held a bare `File[]` and cleared it the instant the user pressed Send.
 * Its upload runs *during* send, so the chips were gone before the first byte
 * moved: nothing the server reported — a truncated read, a workbook with no
 * readable text, a refused container — had anywhere to land. The only signal
 * was a toast, and only for an outright failure.
 *
 * These tests pin the two halves of the fix that are worth pinning: the source
 * no longer clears on send, and the settle rule keeps a chip on screen exactly
 * when it has something to say.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nexusAttachmentsNeedAttention } from "@saas/ai/components/CopilotPage";
import { describe, expect, it } from "vitest";

const NEXUS = join(process.cwd(), "modules/saas/ai/components/CopilotPage.tsx");

function source(): string {
	return readFileSync(NEXUS, "utf-8");
}

/**
 * The composer's own predicate, imported rather than restated. A copy of the
 * rule here would let the component drift while these stayed green.
 */
const shouldKeepChips = nexusAttachmentsNeedAttention;

describe("Nexus attachment records", () => {
	it("carries a status union rather than a bare File list", () => {
		expect(source()).toContain("interface NexusAttachment");
		expect(source()).toContain(
			'"pending" | "uploading" | "processing" | "ready" | "error"',
		);
	});

	it("renders the shared chip row instead of a local span", () => {
		expect(source()).toContain("<CopilotSidebarAttachments");
	});

	it("reports each file's outcome back to the composer", () => {
		// The upload happens two levels above the composer, so the callback is
		// the only channel that connects them.
		const src = source();
		expect(src).toContain("onAttachmentOutcome");
		expect(src).toContain('status: "uploading"');
		expect(src).toContain('status: "processing"');
		expect(src).toContain('status: "error"');
	});

	it("does not clear the queue at send time", () => {
		// The regression this whole unit exists for: `setPendingFiles([])` in
		// the send handler drops the chips before the upload starts.
		//
		// Sliced to the callback body only — it ends at its dependency array.
		// A slice that ran to the next declaration would swallow the settle
		// effect below, which clears legitimately once everything has landed,
		// and this test would then fail against the correct implementation.
		const src = source();
		const start = src.indexOf("const handleSendNow");
		const end = src.indexOf("}, [value, pendingFiles, onSend]);", start);
		const sendHandler = src.slice(start, end);

		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		expect(sendHandler).not.toContain("setPendingFiles([])");
	});
});

describe("every send path settles the chips", () => {
	/**
	 * Not clearing at send time bought the chips a lifetime long enough to
	 * report on — and with it the obligation that *every* exit from the send
	 * handler settles them. A path that returns without reporting leaves the
	 * queue at `pending`, which never satisfies the clear rule: the chips stay
	 * on screen forever with no explanation.
	 *
	 * The two paths below both run outside the per-file try/catch, so neither
	 * is covered by the catch that settles a failed upload.
	 */
	it("settles them when the chat could not be created", () => {
		const src = source();
		const guard = src.slice(
			src.indexOf('toast.error("Failed to initialize chat.")') - 800,
			src.indexOf('toast.error("Failed to initialize chat.")'),
		);

		expect(guard).toContain("onAttachmentOutcome");
		expect(guard).toContain('status: "error"');
	});

	it("settles them when the readiness poll reports failure", () => {
		// Here the upload and the extraction call both succeeded, so the chips
		// are already at `ready`. Leaving them there would have the chip claim
		// success for a document the poll says failed.
		const src = src_readinessGuard();

		expect(src).toContain("onAttachmentOutcome");
		expect(src).toContain('status: "error"');
	});

	function src_readinessGuard(): string {
		const src = source();
		const marker = "One or more documents failed to process";
		return src.slice(src.indexOf(marker) - 900, src.indexOf(marker));
	}
});

describe("when the chips clear", () => {
	it("keeps them while anything is still in flight", () => {
		expect(
			shouldKeepChips([
				{
					status: "ready",
					extraction: { status: "extracted", sheets: [] },
				},
				{ status: "uploading" },
			]),
		).toBe(true);
	});

	it("clears them once everything settled cleanly", () => {
		// A clean upload should not leave chips behind for the next turn.
		expect(
			shouldKeepChips([
				{
					status: "ready",
					extraction: { status: "extracted", sheets: [] },
				},
				{
					status: "ready",
					extraction: { status: "extracted", sheets: [] },
				},
			]),
		).toBe(false);
	});

	it("keeps a truncated file on screen", () => {
		// R9. The truncation notice is the whole point; clearing here would
		// destroy it a frame after it appeared.
		expect(
			shouldKeepChips([
				{
					status: "ready",
					extraction: {
						status: "truncated",
						sheets: [],
						omittedCharCount: 5_000,
					},
				},
			]),
		).toBe(true);
	});

	it("keeps a file that carried no readable text", () => {
		expect(
			shouldKeepChips([
				{
					status: "ready",
					extraction: { status: "empty", sheets: [] },
				},
			]),
		).toBe(true);
	});

	it("keeps a failed upload", () => {
		// AE6 / R10. No surface may report success for an upload that failed.
		expect(shouldKeepChips([{ status: "error" }])).toBe(true);
	});

	it("clears a skipped extraction — nothing was attempted", () => {
		expect(
			shouldKeepChips([
				{ status: "ready", extraction: { status: "skipped" } },
			]),
		).toBe(false);
	});

	it("keeps the whole row when one of several files has something to say", () => {
		expect(
			shouldKeepChips([
				{
					status: "ready",
					extraction: { status: "extracted", sheets: [] },
				},
				{ status: "error" },
			]),
		).toBe(true);
	});
});
