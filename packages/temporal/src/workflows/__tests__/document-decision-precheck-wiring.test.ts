import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const wf = readFileSync(
	join(__dirname, "../document-generation-child.ts"),
	"utf8",
);
const activity = readFileSync(
	join(__dirname, "../../activities/project-document-generation.ts"),
	"utf8",
);
const idx = readFileSync(join(__dirname, "../../activities/index.ts"), "utf8");

describe("document decision pre-check wiring", () => {
	it("gates the new activity call behind the patch marker", () => {
		// Replay safety: the marker must be present so histories recorded before
		// this activity existed replay deterministically (regression #1251).
		expect(wf).toContain('patched("document-decision-precheck-v1")');
	});

	it("invokes the pre-check activity after the document is saved", () => {
		expect(wf).toContain("runDocumentDecisionPrecheckActivity(");
		const saveIdx = wf.indexOf("await saveProjectDocument(");
		const precheckIdx = wf.indexOf("runDocumentDecisionPrecheckActivity(");
		expect(saveIdx).toBeGreaterThan(-1);
		expect(precheckIdx).toBeGreaterThan(saveIdx);
	});

	it("keeps the pre-check call non-fatal (try/catch around the activity)", () => {
		expect(wf).toContain("Decision pre-check activity failed; continuing");
	});

	it("defines and barrel-exports the activity", () => {
		expect(activity).toContain(
			"export async function runDocumentDecisionPrecheckActivity(",
		);
		expect(idx).toContain('export * from "./project-document-generation"');
	});
});
