/**
 * Loom Orchestrator gains document attachment (AC8, AC12, FR8).
 *
 * The Orchestrator composer was image-only: its paperclip opened an
 * image-typed picker and there was no path to attach a document. This is the
 * one Loom surface a user lands on by default, so "attach an Excel to Loom"
 * failed there while Direct and Nexus already worked.
 *
 * The drift guard (`attachment-surface-drift.test.ts`) already pins the shared
 * invariants once the surface is in its `SURFACES` map — one envelope builder,
 * no hand-rolled allowlist, the shared size cap. These tests pin the parts that
 * are *specific* to this surface: the dual pipeline (images feed vision,
 * documents feed RAG/inline) stays split rather than merged, documents render
 * through the shared chip row, and the wire actually carries the inline channel
 * the route has always accepted but the hook never sent.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = process.cwd();

const ORCHESTRATOR = join(
	WEB_ROOT,
	"modules/saas/agents/components/FabricChat/FabricTemporalOrchestratorChat.tsx",
);
const STREAM_HOOK = join(
	WEB_ROOT,
	"modules/saas/agents/hooks/useOrchestratorStream.ts",
);

function orchestrator(): string {
	return readFileSync(ORCHESTRATOR, "utf-8");
}

function streamHook(): string {
	return readFileSync(STREAM_HOOK, "utf-8");
}

describe("Loom Orchestrator — documents and images stay two pipelines", () => {
	it("keeps a document queue distinct from the image queue", () => {
		const source = orchestrator();
		// Images feed the multimodal-vision path; documents feed RAG + inline
		// extracted text. Two states, not one merged list.
		expect(source).toContain("attachedImages");
		expect(source).toContain("attachedDocuments");
	});

	it("routes files by the shared client-renderable-image predicate, not a literal list", () => {
		// The split that sends png/jpeg/webp/gif to vision and everything else
		// (documents, TIFF) to the document pipeline — mirroring Loom Direct.
		expect(orchestrator()).toContain("isClientRenderableAiChatImage");
	});

	it("uploads documents through the createUploadUrl → process pipeline", () => {
		const source = orchestrator();
		expect(source).toContain("ai.documents.createUploadUrl");
		expect(source).toContain("ai.documents.process");
	});

	it("renders documents through the shared chip row", () => {
		expect(orchestrator()).toContain("CopilotSidebarAttachments");
	});

	it("derives the picker accept from the shared vocabulary", () => {
		const source = orchestrator();
		expect(source).toContain("LOOM_ORCHESTRATOR_FILE_ACCEPT");
		expect(source).toContain("buildAiChatAcceptAttribute");
		// The old image-only accept string is gone.
		expect(source).not.toContain(
			'accept="image/png,image/jpeg,image/webp,image/gif,image/tiff"',
		);
	});

	it("no longer advertises an image-only paperclip", () => {
		expect(orchestrator()).not.toContain('attachTooltip="Attach images"');
	});
});

describe("Loom Orchestrator — the inline channel reaches the route", () => {
	it("the composer collects and forwards inlineAttachmentContexts", () => {
		expect(orchestrator()).toContain("inlineAttachmentContexts");
	});

	it("the stream hook sends inlineAttachmentContexts on the request body", () => {
		// The orchestrator-temporal route has always destructured this field;
		// before this change the hook never put it on the wire, so a document's
		// extracted text could only reach the model via RAG retrieval. This is
		// the assertion that the inline channel is actually connected.
		expect(streamHook()).toContain("inlineAttachmentContexts");
	});

	it("merges composer-uploaded document ids with the pre-attached prop", () => {
		// Pre-attached project/workspace context docs (the `attachedDocumentIds`
		// option) must not be clobbered by composer-collected uploads.
		const source = streamHook();
		expect(source).toContain("sessionDocumentIds");
		expect(source).toContain("attachedDocumentIds");
	});
});
