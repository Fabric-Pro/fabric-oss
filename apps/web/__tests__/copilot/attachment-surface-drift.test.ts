/**
 * U7 — the drift guard behind the duplication map (R11, R12).
 *
 * The map in `docs/attachment-surface-map.md` records what is deliberately
 * still duplicated across the three attachment surfaces and what is shared. A
 * prose map rots; this is what keeps it honest.
 *
 * It reads live source with the filesystem and asserts against it, mirroring
 * the get-started drift test — the repo's existing pattern for pinning that a
 * component still carries the anchor a registry claims it does.
 *
 * The security-relevant half is the envelope: exactly one builder, three
 * callers. A surface that assembles its own would inherit no neutralizer, and
 * a fix applied to the shared builder would silently miss it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = process.cwd();
const REPO_ROOT = join(WEB_ROOT, "..", "..");

/** The four surfaces that attach files to an AI chat. */
const SURFACES = {
	"Feature Assistant": join(
		WEB_ROOT,
		"modules/saas/shared/components/copilot/use-copilot-document-upload.ts",
	),
	"Loom Direct": join(
		WEB_ROOT,
		"modules/saas/agents/components/FabricChat/FabricDirectChat.tsx",
	),
	"Loom Orchestrator": join(
		WEB_ROOT,
		"modules/saas/agents/components/FabricChat/FabricTemporalOrchestratorChat.tsx",
	),
	Nexus: join(WEB_ROOT, "modules/saas/ai/components/CopilotPage.tsx"),
} as const;

/** The server-side producer of the same envelope. */
const STORY_MEDIA_RESOLVER = join(
	REPO_ROOT,
	"packages/api/modules/projects/procedures/stories/resolve-story-media-for-agent.ts",
);

const MAP_DOC = join(REPO_ROOT, "docs/attachment-surface-map.md");
/** The shared core both non-chat vocabularies compose from. Fizzy #2149. */
const FORMAT_CORE = join(
	REPO_ROOT,
	"packages/utils/lib/document-format-core.ts",
);

function read(path: string): string {
	return readFileSync(path, "utf-8");
}

/**
 * The literal opening delimiter, assembled here rather than imported so this
 * test fails when the producer's spelling drifts from the router's — importing
 * the constant would make both sides move together and assert nothing.
 */
const ENVELOPE_OPEN = "<fabric_attachment>";

describe("attachment envelope — one builder, every caller", () => {
	it.each(Object.entries(SURFACES))(
		"%s builds its envelope through the shared builder",
		(_surface, path) => {
			expect(read(path)).toContain("buildAiChatAttachmentEntry");
		},
	);

	it.each(Object.entries(SURFACES))(
		"%s does not assemble the delimiter itself",
		(_surface, path) => {
			// A surface writing the tag inline is a surface that will not carry
			// the neutralizer with it.
			expect(read(path)).not.toContain(ENVELOPE_OPEN);
		},
	);

	it("the server-side story-media producer uses it too", () => {
		// This one interpolated the filename raw for a long time, which is how
		// the client path ended up guarded while a second door stayed open.
		const source = read(STORY_MEDIA_RESOLVER);

		expect(source).toContain("buildAiChatAttachmentEntry");
		expect(source).not.toContain(ENVELOPE_OPEN);
	});

	it.each(Object.entries(SURFACES))(
		"%s does not interpolate the upload prefix by hand",
		(_surface, path) => {
			// `[Uploaded Document: ` and `[Uploaded Image: ` are the envelope's
			// inner prefixes. Building either outside the shared builder means
			// building it without the filename neutralizer.
			expect(read(path)).not.toMatch(
				/\[Uploaded (?:Document|Image): \$\{/,
			);
		},
	);
});

describe("attachment vocabulary — read, not restated", () => {
	it.each(Object.entries(SURFACES))(
		"%s takes its size cap from the shared vocabulary",
		(_surface, path) => {
			const source = read(path);

			expect(source).toContain("DEFAULT_AI_CHAT_MAX_FILE_BYTES");
			// Five separate declarations of the same literal is what let the cap
			// differ per surface. `10 * 1024 * 1024` in particular is the value
			// the chat cap used to carry.
			expect(source).not.toContain("10 * 1024 * 1024");
		},
	);

	it("no surface re-derives the format allowlist as a literal array", () => {
		// Loom Direct restated its own list three times with two different
		// regexes. It still carries them, deliberately and recorded in the map,
		// but nothing may claim a format the shared vocabulary refuses.
		for (const [, path] of Object.entries(SURFACES)) {
			expect(read(path)).not.toContain("application/vnd.ms-excel");
		}
	});

	it("no surface hand-rolls an `allowedTypes` validation array", () => {
		// This is the bug that shipped: the picker's `accept` attribute was
		// derived from the shared vocabulary and offered `.xlsx`/`.csv`, but the
		// validation gate behind it was a hand-rolled `allowedTypes = [...]`
		// array that omitted those formats — so the picker offered a file the
		// gate then refused with "File type not supported". A local array drifts
		// from the vocabulary the moment a format is added to one and not the
		// other; the gate must read the vocabulary, not restate it.
		for (const [, path] of Object.entries(SURFACES)) {
			expect(read(path)).not.toMatch(/allowedTypes\s*=\s*\[/);
		}
	});

	it.each([
		[
			"Loom Direct",
			join(
				WEB_ROOT,
				"modules/saas/agents/components/FabricChat/FabricDirectChat.tsx",
			),
		],
		[
			"Loom Orchestrator",
			join(
				WEB_ROOT,
				"modules/saas/agents/components/FabricChat/FabricTemporalOrchestratorChat.tsx",
			),
		],
		["Nexus", join(WEB_ROOT, "modules/saas/ai/components/CopilotPage.tsx")],
	])(
		"%s gates file type on the shared MIME allowlist and extension guard",
		(_surface, path) => {
			// The two surfaces that validate on the client (the Feature
			// Assistant hook uses the narrower client set because it compresses
			// through a canvas) must gate on the shared vocabulary so the gate
			// admits exactly what the picker — derived from the same vocabulary —
			// offers.
			const source = read(path);
			expect(source).toContain("DEFAULT_AI_CHAT_MIME_ALLOWLIST");
			expect(source).toContain("AI_CHAT_SERVER_ALLOWED_EXTENSIONS");
		},
	);
});

/**
 * The file pickers that are not AI-chat surfaces (Fizzy #2139).
 *
 * Deliberately a second table rather than three more entries in `SURFACES`:
 * every assertion above is about the AI-chat envelope and the chat vocabulary,
 * which none of these carry. What they share with the four above is the rule
 * that makes both sets correct — a picker's `accept` attribute and the gate
 * behind it read one vocabulary instead of restating it.
 *
 * Each entry names the shared constant the picker must be reading. The names
 * are spelled out here rather than imported, on the same reasoning as
 * ENVELOPE_OPEN above: importing them would make both sides move together and
 * assert nothing.
 */
const PICKER_SURFACES = {
	"Project context": {
		path: join(
			WEB_ROOT,
			"modules/saas/projects/components/ContextUploaderDialog.tsx",
		),
		acceptConstant: "CONTEXT_UPLOAD_ACCEPT_ATTR",
		gateSymbol: "contextUploadConfigFor",
		labelsSource: "context-upload-copy",
	},
	"Project wizard": {
		path: join(
			WEB_ROOT,
			"modules/saas/projects/components/wizard/WizardFileUploader.tsx",
		),
		acceptConstant: "CONTEXT_UPLOAD_ACCEPT_ATTR",
		gateSymbol: "contextUploadConfigFor",
		labelsSource: "context-upload-copy",
	},
	"Workspace documents": {
		path: join(
			WEB_ROOT,
			"modules/saas/workspaces/components/DocumentUploader.tsx",
		),
		acceptConstant: "WORKSPACE_DOCUMENT_ACCEPT_ATTR",
		gateSymbol: "workspaceDocumentConfigFor",
		labelsSource: "WORKSPACE_DOCUMENT_FORMAT_LABELS",
	},
} as const;

describe("file pickers — accept and validation share one vocabulary", () => {
	it.each(Object.entries(PICKER_SURFACES))(
		"%s advertises formats from its shared constant",
		(_surface, { path, acceptConstant }) => {
			expect(read(path)).toContain(`accept={${acceptConstant}}`);
		},
	);

	it.each(Object.entries(PICKER_SURFACES))(
		"%s does not restate the format list as a local array",
		(_surface, { path }) => {
			// `ACCEPTED_TYPES = [...]` inside the workspace picker is the shape
			// this guards against: one hand-kept MIME list drove both the accept
			// attribute and the gate, so `.md` was greyed out of the OS dialog on
			// any machine without a `.md` registration.
			const source = read(path);

			expect(source).not.toMatch(/ACCEPTED_TYPES\s*=\s*\[/);
			expect(source).not.toMatch(/allowedTypes\s*=\s*\[/);
		},
	);

	it.each(Object.entries(PICKER_SURFACES))(
		"%s advertises extensions, not bare MIME types",
		(_surface, { acceptConstant }) => {
			// A MIME-valued accept attribute is what greys a file out of the OS
			// dialog when the OS has no registration for its extension — the
			// browser has nothing to match against. Assert the derivation emits
			// dotted extensions.
			//
			// Two halves, in two files since Fizzy #2149: each vocabulary still
			// exports its own accept constant, but the dotted projection that
			// builds it moved to the shared core both vocabularies compose from.
			const source =
				acceptConstant === "WORKSPACE_DOCUMENT_ACCEPT_ATTR"
					? read(
							join(
								REPO_ROOT,
								"packages/utils/lib/workspace-document-upload.ts",
							),
						)
					: read(
							join(
								REPO_ROOT,
								"packages/utils/lib/context-upload.ts",
							),
						);

			expect(source).toContain(`export const ${acceptConstant}`);
			expect(read(FORMAT_CORE)).toMatch(/`\.\$\{/);
		},
	);

	it.each(Object.entries(PICKER_SURFACES))(
		"%s composes its vocabulary from the shared core",
		(_surface, { acceptConstant }) => {
			// The drift this closes is the one no per-surface guard could see:
			// each surface was internally consistent while the two disagreed with
			// each other — workspace documents sat at five formats where project
			// context carried thirteen. Fizzy #2149.
			const source =
				acceptConstant === "WORKSPACE_DOCUMENT_ACCEPT_ATTR"
					? read(
							join(
								REPO_ROOT,
								"packages/utils/lib/workspace-document-upload.ts",
							),
						)
					: read(
							join(
								REPO_ROOT,
								"packages/utils/lib/context-upload.ts",
							),
						);

			expect(source).toContain("DOCUMENT_FORMAT_CORE");
		},
	);

	it.each(Object.entries(PICKER_SURFACES))(
		"%s gates on the vocabulary before the file is queued",
		(_surface, { path, gateSymbol }) => {
			// Resolving is not gating. Every surface resolver returns the caller's
			// own value when nothing resolves — deliberately, so the server can
			// normalize without refusing — so a picker testing the resolved MIME
			// for null would accept everything. The config lookup is the gate, and
			// its absence is what let an unsupported file sit in the context
			// queue reading "Ready" until the server refused it on submit, and
			// let the workspace picker advertise formats its own gate rejected.
			// Fizzy #2149.
			expect(read(path)).toContain(gateSymbol);
		},
	);

	it.each(Object.entries(PICKER_SURFACES))(
		"%s does not restate the format list as user-facing copy",
		(_surface, { path, labelsSource }) => {
			// The copy under two of these pickers read "PDF, DOC, DOCX, TXT, MD,
			// HTML" while the accept attribute beside it admitted six more. A
			// hand-kept sentence drifts exactly like a hand-kept array — the label
			// is what a screen reader announces, so a stale one tells a blind user
			// a supported format is unsupported.
			const source = read(path);

			// The exact sentence that drifted, in the order it was written.
			expect(source).not.toMatch(/PDF,\s*DOC,\s*DOCX/i);
			// And the positive half: the copy has to come from somewhere derived.
			expect(source).toContain(labelsSource);
		},
	);

	it.each(Object.entries(PICKER_SURFACES))(
		"%s resolves an unrecognised MIME rather than refusing it",
		(_surface, { path }) => {
			// Fizzy #2139: a file the OS did not type arrives as "" and the
			// client substitutes `application/octet-stream`. Every picker must
			// route that through a resolver that falls back to the extension —
			// directly, or through the category helper that wraps one.
			expect(read(path)).toMatch(
				/resolveContextUploadMime|resolveContextUploadCategory|resolveAttachmentMime|resolveWorkspaceDocumentMime/,
			);
		},
	);
});

describe("the duplication map matches the tree", () => {
	it("exists", () => {
		expect(() => read(MAP_DOC)).not.toThrow();
	});

	it("names every surface it claims to cover", () => {
		const doc = read(MAP_DOC);

		for (const surface of [
			...Object.keys(SURFACES),
			...Object.keys(PICKER_SURFACES),
		]) {
			expect(doc).toContain(surface);
		}
	});

	it("points at file paths that still exist", () => {
		// A map naming a file that has moved is worse than no map: it reads as
		// current.
		const doc = read(MAP_DOC);
		const paths = doc.match(/`((?:apps|packages)\/[^`]+\.(?:ts|tsx))`/g);

		expect(paths).not.toBeNull();
		for (const quoted of paths ?? []) {
			const relative = quoted.slice(1, -1);
			expect(() => read(join(REPO_ROOT, relative))).not.toThrow();
		}
	});
});
