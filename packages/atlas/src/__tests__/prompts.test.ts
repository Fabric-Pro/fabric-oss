import { describe, expect, it } from "vitest";
import {
	buildBusinessDerivationPrompt,
	buildChatSystemPromptHeader,
} from "../prompts";

describe("buildChatSystemPromptHeader", () => {
	const technical = buildChatSystemPromptHeader({
		repositoryName: "acme/widgets",
		projectName: "Widgets",
		mode: "TECHNICAL",
	}).join("\n");
	const business = buildChatSystemPromptHeader({
		repositoryName: "acme/widgets",
		projectName: "Widgets",
		mode: "BUSINESS",
	}).join("\n");

	it("identifies as the single Atlas Assistant in both modes", () => {
		expect(technical).toContain("Atlas Assistant");
		expect(business).toContain("Atlas Assistant");
		expect(technical).toContain("acme/widgets");
		expect(business).toContain("acme/widgets");
	});

	it("keeps the technical-precision quality floor in BOTH modes", () => {
		for (const header of [technical, business]) {
			// Engineering terminology + specificity (the former technical persona).
			expect(header).toContain("accurate engineering terminology");
			expect(header).toContain(
				"responsibilities, data flow, and dependencies",
			);
			// Direct answers + synthesis, grounded-only, confident/concise.
			expect(header).toContain("Lead with a direct answer");
			expect(header).toContain("Synthesise");
			expect(header.toLowerCase()).toContain("stay grounded");
			expect(header).toContain("Be confident and concise");
		}
	});

	it("adds the business-value enrichment in BOTH modes", () => {
		for (const header of [technical, business]) {
			expect(header).toContain(
				"tie each code area to the user-facing capability it serves",
			);
			expect(header.toLowerCase()).toContain("business value");
			expect(header.toLowerCase()).toContain("plain language");
		}
	});

	it("drops the former business persona's non-technical / no-file-paths restriction", () => {
		expect(business.toLowerCase()).not.toContain("non-technical person");
		expect(business.toLowerCase()).not.toContain("jargon-free");
		expect(business.toLowerCase()).not.toContain("no file paths");
	});

	it("keeps the mode-specific linkifier instruction and section header (canvas focus)", () => {
		// TECHNICAL: modules/files linkify; capabilities must not.
		expect(technical).toContain("## Modules");
		expect(technical).toContain("modules or files, write its EXACT label");
		expect(technical).toContain(
			"do NOT write capability names as exact labels",
		);
		// BUSINESS: capabilities linkify; modules must not.
		expect(business).toContain("## Business capabilities");
		expect(business).toContain(
			"business capabilities, write its EXACT label",
		);
		expect(business).toContain("do NOT write module names as exact labels");
		expect(technical.toLowerCase()).toContain("clickable links");
		expect(business.toLowerCase()).toContain("clickable links");
	});

	it("omits the project clause when projectName is null", () => {
		const header = buildChatSystemPromptHeader({
			repositoryName: "acme/widgets",
			projectName: null,
			mode: "BUSINESS",
		}).join("\n");
		expect(header).not.toContain('in project "');
	});
});

describe("buildBusinessDerivationPrompt", () => {
	it("folds an attached documentation excerpt into the module entry", () => {
		const prompt = buildBusinessDerivationPrompt([
			{
				label: "billing",
				path: "src/billing",
				business: "Handles invoices",
				doc: "The billing module issues invoices and processes refunds.",
			},
		]);
		expect(prompt).toContain("0. billing (src/billing) — Handles invoices");
		expect(prompt).toContain("docs: The billing module issues invoices");
	});

	it("omits the docs line when a module has no attached documentation", () => {
		const prompt = buildBusinessDerivationPrompt([
			{ label: "core", path: null, business: null },
		]);
		expect(prompt).toContain("0. core");
		expect(prompt).not.toContain("docs:");
	});

	it("caps a long documentation excerpt", () => {
		const longDoc = "x".repeat(5000);
		const prompt = buildBusinessDerivationPrompt([
			{ label: "big", path: null, business: null, doc: longDoc },
		]);
		const docLine = prompt
			.split("\n")
			.find((l) => l.trim().startsWith("docs:"));
		expect(docLine).toBeDefined();
		// 280-char excerpt cap + the "   docs: " prefix — well under the full 5000.
		expect((docLine as string).length).toBeLessThan(320);
	});
});
