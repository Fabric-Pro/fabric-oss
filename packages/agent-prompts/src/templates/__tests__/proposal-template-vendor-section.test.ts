/**
 * The default Proposal template and company context (Fizzy #2719).
 *
 * When the organization's company context reaches a Proposal run — as
 * vendor-marked retrieved entries — the default template permits exactly one
 * section for the vendor's qualifications and past work, and the forbidden
 * entries that name that section's subject leave the forbidden list. Without
 * vendor entries the template is byte-for-byte what it was. A custom prompt
 * decides its own sections and gets the labeled material unchanged.
 *
 * The same marked entries are not the project's own context, so they must not
 * push the wizard features out of the prompt.
 */

import { VENDOR_CONTEXT_MARKER } from "@repo/agent-types";
import { describe, expect, it } from "vitest";
import { buildUnifiedSystemPrompt } from "../../builders/unified-prompt-builder";
import {
	formatProposalForbiddenSections,
	getProposalForbiddenSections,
	getProposalOverrideInstructions,
	getProposalVendorSectionInstructions,
	getProposalVendorSectionReminder,
	PROPOSAL_FORBIDDEN_SECTIONS,
	PROPOSAL_TEMPLATE,
	PROPOSAL_VENDOR_SECTION,
} from "../proposal-template";

const VENDOR_HEADING = `### **${PROPOSAL_VENDOR_SECTION}**`;
const REPLACED = ["Company Overview", "About Us", "Vendor Overview"];

const VENDOR_ENTRY = `${VENDOR_CONTEXT_MARKER}\n[Source: Case study]\nWe rolled out scanning at a regional distributor.`;
const PROJECT_ENTRY = "The client picks 4,000 orders a day on paper.";

const PROJECT_CONTEXT = {
	name: "Warehouse modernization",
	description: "Replace paper-based picking.",
	techStack: ["React"],
	features: ["Barcode scanning", "Pick-path optimization"],
};

describe("default Proposal template without vendor material", () => {
	it("keeps the forbidden list whole", () => {
		expect(getProposalForbiddenSections()).toBe(
			PROPOSAL_FORBIDDEN_SECTIONS,
		);
		expect(getProposalForbiddenSections({ hasVendorContext: false })).toBe(
			PROPOSAL_FORBIDDEN_SECTIONS,
		);
		for (const section of REPLACED) {
			expect(formatProposalForbiddenSections()).toContain(
				`- "${section}"`,
			);
		}
	});

	it("permits no vendor section", () => {
		const instructions = getProposalOverrideInstructions();

		expect(instructions).toBe(
			getProposalOverrideInstructions({ hasVendorContext: false }),
		);
		expect(instructions).not.toContain(PROPOSAL_VENDOR_SECTION);
		expect(instructions).toContain(PROPOSAL_TEMPLATE);
	});
});

describe("default Proposal template with vendor material", () => {
	const instructions = getProposalOverrideInstructions({
		hasVendorContext: true,
	});

	it("permits exactly one vendor-qualifications section, before Stakeholders", () => {
		expect(instructions).toContain(getProposalVendorSectionInstructions());
		expect(instructions).toMatch(/exactly ONE section/);
		// The template shows it in place.
		const templateStart = instructions.indexOf(
			"## EXACT TEMPLATE TO FOLLOW:",
		);
		const template = instructions.slice(templateStart);
		expect(template.indexOf(VENDOR_HEADING)).toBeGreaterThan(-1);
		expect(template.indexOf(VENDOR_HEADING)).toBeLessThan(
			template.indexOf("### **Stakeholders**"),
		);
		expect(
			template.match(new RegExp(PROPOSAL_VENDOR_SECTION, "g")),
		).toHaveLength(1);
	});

	it("drops only the entries the vendor section replaces from the forbidden list", () => {
		const forbidden = getProposalForbiddenSections({
			hasVendorContext: true,
		});

		for (const section of REPLACED) {
			expect(forbidden).not.toContain(section);
		}
		expect(forbidden).toHaveLength(
			PROPOSAL_FORBIDDEN_SECTIONS.length - REPLACED.length,
		);
		expect(forbidden).toContain("Team Overview");
		expect(forbidden).toContain("Executive Summary");
		expect(
			formatProposalForbiddenSections({ hasVendorContext: true }),
		).not.toContain('"Company Overview"');
	});

	it("changes nothing else in the instructions", () => {
		const withoutInsertions = instructions
			.replace(`\n\n${getProposalVendorSectionInstructions()}`, "")
			.replace(
				`${VENDOR_HEADING}\n\n- [Relevant capability or past project, tied to this client's needs]\n\n`,
				"",
			);

		expect(withoutInsertions).toBe(getProposalOverrideInstructions());
	});
});

describe("buildUnifiedSystemPrompt with company context", () => {
	it("permits the vendor section in a default Proposal, up front and in both closing reminders", () => {
		const prompt = buildUnifiedSystemPrompt({
			documentType: "proposal",
			projectContext: PROJECT_CONTEXT,
			ragContexts: [PROJECT_ENTRY, VENDOR_ENTRY],
		});

		expect(prompt).toContain(getProposalVendorSectionInstructions());
		expect(
			prompt.split(getProposalVendorSectionReminder()).length - 1,
		).toBe(2);
		// The labeled material reaches the prompt as retrieved context.
		expect(prompt).toContain(VENDOR_CONTEXT_MARKER);
	});

	it("leaves a default Proposal without vendor material untouched", () => {
		const prompt = buildUnifiedSystemPrompt({
			documentType: "proposal",
			projectContext: PROJECT_CONTEXT,
			ragContexts: [PROJECT_ENTRY],
		});

		expect(prompt).not.toContain(PROPOSAL_VENDOR_SECTION);
	});

	it("gives a custom Proposal prompt the labeled vendor material unchanged, and no vendor section", () => {
		const prompt = buildUnifiedSystemPrompt({
			customPrompt: "Write our statement of work.",
			documentType: "proposal",
			projectContext: PROJECT_CONTEXT,
			ragContexts: [PROJECT_ENTRY, VENDOR_ENTRY],
		});

		expect(prompt).toContain(VENDOR_ENTRY);
		expect(prompt).not.toContain(PROPOSAL_VENDOR_SECTION);
	});

	it("adds no vendor section to a Business Case", () => {
		const prompt = buildUnifiedSystemPrompt({
			documentType: "business_case",
			projectContext: PROJECT_CONTEXT,
			ragContexts: [VENDOR_ENTRY],
		});

		expect(prompt).toContain(VENDOR_ENTRY);
		expect(prompt).not.toContain(PROPOSAL_VENDOR_SECTION);
	});

	it.each(["proposal", "business_case"] as const)(
		"keeps the wizard features in a %s when only vendor entries were retrieved",
		(documentType) => {
			const prompt = buildUnifiedSystemPrompt({
				documentType,
				projectContext: PROJECT_CONTEXT,
				ragContexts: [VENDOR_ENTRY],
			});

			expect(prompt).toContain("**Key Features:**");
			expect(prompt).toContain("1. Barcode scanning");
		},
	);

	it("drops the wizard features once the project has context of its own", () => {
		const prompt = buildUnifiedSystemPrompt({
			documentType: "proposal",
			projectContext: PROJECT_CONTEXT,
			ragContexts: [PROJECT_ENTRY, VENDOR_ENTRY],
		});

		expect(prompt).not.toContain("**Key Features:**");
	});
});
