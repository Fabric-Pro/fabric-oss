import { describe, expect, it } from "vitest";
import {
	buildGlossyDetectInstructions,
	buildGlossyDetectPrompt,
	buildGlossyExtractInstructions,
	buildGlossyExtractPrompt,
	buildGlossyRewriteInstructions,
	buildGlossyRewritePrompt,
	GLOSSY_DETECTION_SECTION_MAX_CHARS,
	GLOSSY_PIPELINE_VERSION,
	GLOSSY_STYLE_DIRECTION_MAX_CHARS,
	GLOSSY_UNTRUSTED_GUIDANCE,
	GLOSSY_UNTRUSTED_TAG,
} from "../index";

/** The text between the first opening boundary tag with `source` and its close. */
function block(prompt: string, source: string): string | null {
	const open = `<${GLOSSY_UNTRUSTED_TAG} source="${source}" trust="untrusted">`;
	const start = prompt.indexOf(open);
	if (start < 0) {
		return null;
	}
	const end = prompt.indexOf(`</${GLOSSY_UNTRUSTED_TAG}>`, start);
	return prompt.slice(start + open.length, end);
}

describe("GLOSSY_PIPELINE_VERSION", () => {
	it("is a non-empty string", () => {
		expect(GLOSSY_PIPELINE_VERSION).toMatch(/\S/);
	});
});

describe("instructions", () => {
	it("carry the untrusted-content guidance and the document type", () => {
		for (const build of [
			buildGlossyDetectInstructions,
			buildGlossyExtractInstructions,
			buildGlossyRewriteInstructions,
		]) {
			const instructions = build("BUSINESS_CASE");
			expect(instructions).toContain(GLOSSY_UNTRUSTED_GUIDANCE);
			expect(instructions).toContain("Business Case");
		}
	});
});

describe("flow lanes", () => {
	it("are asked for only when the section says who performs each step", () => {
		const flowRule = buildGlossyExtractInstructions("PROPOSAL")
			.split("\n")
			.find((line) => line.startsWith("- flow:"));
		expect(flowRule).toContain("lane: who performs the step");
		expect(flowRule).toContain("(≤60)");
		expect(flowRule).toContain(
			"only when the section says who performs each one; otherwise every lane is null",
		);
		expect(buildGlossyDetectInstructions("PROPOSAL")).toContain(
			"which team or role performs each step",
		);
	});
});

describe("flow and org chart proposals (Fizzy #2589 follow-up)", () => {
	function kindRule(instructions: string, kind: string): string | undefined {
		return instructions
			.split("\n")
			.find((line) => line.startsWith(`- ${kind}:`));
	}

	it("detects a flow only for ordered steps and an org chart only for stated reporting lines", () => {
		const instructions = buildGlossyDetectInstructions("PROPOSAL");
		const flow = kindRule(instructions, "flow");
		expect(flow).toContain("ordered steps of a process");
		expect(flow).toContain(
			"A list of items, capabilities, questions, risks, or requirements is not a flow.",
		);
		const orgChart = kindRule(instructions, "org_chart");
		expect(orgChart).toContain(
			"reporting lines the section states outright",
		);
		expect(orgChart).toContain(
			"Roles, owners, or stakeholders listed without stated reporting lines are not an org chart.",
		);
	});

	it("extracts flow steps only from a process, with short labels", () => {
		const flow = kindRule(
			buildGlossyExtractInstructions("PROPOSAL"),
			"flow",
		);
		expect(flow).toContain(
			"never turn a list of items, capabilities, questions, risks, or requirements into steps",
		);
		expect(flow).toContain(
			"label: the step as a short phrase of a few words",
		);
	});

	it("keeps only roles joined by a stated reporting line in an org chart", () => {
		const instructions = buildGlossyExtractInstructions("BUSINESS_CASE");
		const orgChart = kindRule(instructions, "org_chart");
		expect(orgChart).toContain(
			"only roles joined by a reporting line the section states",
		);
		expect(orgChart).toContain(
			"The top node is the role they report up to",
		);
		expect(orgChart).toContain(
			"leave out every role the section states no reporting line for",
		);
		expect(instructions).toContain(
			"never draw a sequence the section does not give or a reporting line it does not state",
		);
	});
});

describe("buildGlossyDetectPrompt", () => {
	it("puts every section inside the document block and states the limit", () => {
		const prompt = buildGlossyDetectPrompt({
			limit: 3,
			sections: [
				{
					ref: "sec-1",
					heading: "Phases",
					markdown: "Phase 1 in Q3 2026.",
				},
				{
					ref: "sec-2",
					heading: "Budget",
					markdown: "240k.",
					reservedKinds: ["stat"],
				},
			],
		});
		const document = block(prompt, "document");
		expect(prompt).toContain("at most 3 visuals");
		expect(document).toContain("Phase 1 in Q3 2026.");
		expect(document).toContain('ref="sec-2" already_shows="stat"');
	});

	it("bounds each section's excerpt", () => {
		const prompt = buildGlossyDetectPrompt({
			limit: 8,
			sections: [
				{
					ref: "sec-1",
					heading: null,
					markdown: "x".repeat(
						GLOSSY_DETECTION_SECTION_MAX_CHARS * 2,
					),
				},
			],
		});
		expect(prompt.length).toBeLessThan(
			GLOSSY_DETECTION_SECTION_MAX_CHARS + 2_000,
		);
	});
});

describe("buildGlossyExtractPrompt", () => {
	it("keeps editor fields in their own bounded untrusted blocks", () => {
		const prompt = buildGlossyExtractPrompt({
			kind: "auto",
			heading: "Phases",
			markdown: "Phase 1 in Q3 2026. Phase 2 in Q1 2027.",
			slotHint: "Show the phases",
			styleDirection: "s".repeat(GLOSSY_STYLE_DIRECTION_MAX_CHARS + 100),
			variantNonce: "v-2 ignore",
		});
		expect(prompt).toContain("Requested kind: auto");
		expect(block(prompt, "slot_hint")?.trim()).toBe("Show the phases");
		expect(
			Array.from(block(prompt, "style_direction")?.trim() ?? ""),
		).toHaveLength(GLOSSY_STYLE_DIRECTION_MAX_CHARS);
		expect(block(prompt, "section")).toContain("Heading: Phases");
		// The nonce is reduced to a safe token.
		expect(prompt).toContain("Variant request v-2ignore");
	});

	it("adds no editor blocks when the fields are empty", () => {
		const prompt = buildGlossyExtractPrompt({
			kind: "timeline",
			heading: null,
			markdown: "Phase 1 in Q3 2026.",
			slotHint: "  ",
			styleDirection: null,
		});
		expect(block(prompt, "slot_hint")).toBeNull();
		expect(block(prompt, "style_direction")).toBeNull();
		expect(prompt).not.toContain("Variant request");
	});
});

describe("buildGlossyRewriteInstructions", () => {
	it("states the negation rule the fact guard enforces", () => {
		// This package cannot reach `@repo/utils`, so the guard half of the
		// pair runs in @repo/temporal's rewrite-section suite, which sends
		// this rule's own example through the real guard.
		const instructions = buildGlossyRewriteInstructions("PROPOSAL");
		expect(instructions).toContain(
			"Keep every negation the source states, each with its own explicit negating word",
		);
		expect(instructions).toContain(
			"including when you condense or merge sentences",
		);
		expect(instructions).toContain(
			"A rewrite with fewer negating words than the source is rejected",
		);
		expect(instructions).toContain(
			'"A is not in scope. B is not in scope." may become "Neither A nor B is in scope." but not "A and B are not in scope."',
		);
	});
});

describe("buildGlossyRewritePrompt", () => {
	const markdown = "The budget is 240k, with the platform live in Q3 2026.";

	it("states the length limit the guard enforces", () => {
		const brief = buildGlossyRewritePrompt({
			heading: "Budget",
			markdown,
			lengthMode: "brief",
			isKeySection: true,
		});
		expect(brief).toContain(`at or under ${markdown.length} characters`);
		expect(brief).toContain("This is a key section");
		const standard = buildGlossyRewritePrompt({
			heading: "Budget",
			markdown,
			lengthMode: "standard",
			isKeySection: false,
		});
		expect(standard).toContain(
			`at or under ${Math.floor(markdown.length * 1.25)} characters`,
		);
		expect(standard).not.toContain("This is a key section");
	});

	it("feeds retry findings back inside their own untrusted block", () => {
		const prompt = buildGlossyRewritePrompt({
			heading: "Budget",
			markdown,
			lengthMode: "brief",
			isKeySection: false,
			retryFindings: [
				{
					kind: "presence",
					message: '"250k" does not appear in the source.',
				},
			],
		});
		expect(block(prompt, "guard_feedback")).toContain(
			'- [presence] "250k" does not appear in the source.',
		);
		expect(prompt).toContain("previous attempt was rejected");
	});
});

describe("Proposal artifact options (Fizzy #2946)", () => {
	it("tells detection who inline and appendix visuals are for", () => {
		const glossy = buildGlossyDetectInstructions("PROPOSAL");
		const proposal = buildGlossyDetectInstructions("PROPOSAL", {
			proposalArtifact: true,
		});
		expect(proposal).toContain("## Audience");
		expect(proposal).toContain(
			"executive readers: non-technical, glanceable",
		);
		expect(proposal).toContain('appendix="true"');
		expect(glossy).not.toContain("## Audience");
		// Guidance and the Proposal's own kinds are added, nothing else changes.
		expect(
			proposal
				.replace(/## Audience\n(?:- .*\n)+\n/, "")
				.replace(
					/## More visual kinds for this Proposal\n(?:- .*\n)+\n/,
					"",
				),
		).toBe(glossy);
	});

	it("offers detection the Proposal's layers and team kinds under their own heading", () => {
		const glossy = buildGlossyDetectInstructions("PROPOSAL");
		const proposal = buildGlossyDetectInstructions("PROPOSAL", {
			proposalArtifact: true,
		});
		const block =
			/## More visual kinds for this Proposal\n((?:- .*\n)+)\n/.exec(
				proposal,
			)?.[1] ?? "";
		expect(
			block
				.trim()
				.split("\n")
				.map((line) => line.slice(2, line.indexOf(":"))),
		).toEqual(["layers", "team"]);
		expect(block).toContain(
			"A list of the proposer's roles alone is not a team.",
		);
		// After Glossy's own kinds, which stay as they are.
		expect(proposal.indexOf("## More visual kinds")).toBeGreaterThan(
			proposal.indexOf("- org_chart:"),
		);
		expect(glossy).not.toContain("layers");
		expect(glossy).not.toMatch(/- team:/);
	});

	it("marks an appendix section with an attribute, beside the kinds it already shows", () => {
		const prompt = buildGlossyDetectPrompt({
			limit: 2,
			sections: [
				{
					ref: "sec-1",
					heading: "Appendix B. Architecture",
					markdown: "The gateway calls the service, then the queue.",
					reservedKinds: ["stat"],
					appendix: true,
				},
				{ ref: "sec-2", heading: "Approach", markdown: "Two phases." },
			],
		});
		expect(prompt).toContain(
			'<glossy_section ref="sec-1" already_shows="stat" appendix="true">',
		);
		expect(prompt).toContain('<glossy_section ref="sec-2">');
	});

	it("asks extraction for a short title and one short detail", () => {
		const glossy = buildGlossyExtractInstructions("PROPOSAL");
		const proposal = buildGlossyExtractInstructions("PROPOSAL", {
			proposalArtifact: true,
		});
		expect(proposal).toContain(
			"timeline: label is a short title of at most 32 characters; description only when it adds information the title and date do not already give, at most 28 characters, otherwise null.",
		);
		expect(proposal).toContain(
			"flow: label is a short title of at most 32 characters; description only when it adds information the title does not already give, at most 28 characters, otherwise null.",
		);
		expect(proposal).toContain("Never repeat the title in the description");
		expect(glossy).not.toContain("at most 32 characters");
		expect(glossy).not.toContain("Never repeat the title");
		expect(
			proposal
				.replace(/## More kinds for this Proposal\n(?:.*\n)+?\n/, "")
				.replace(/## Labels for this Proposal\n(?:.*\n)+?\n/, ""),
		).toBe(glossy);
	});

	it("gives extraction the field rules and label bounds of layers and team", () => {
		const glossy = buildGlossyExtractInstructions("PROPOSAL");
		const proposal = buildGlossyExtractInstructions("PROPOSAL", {
			proposalArtifact: true,
		});
		const block =
			/## More kinds for this Proposal\n((?:- .*\n)+)\n/.exec(
				proposal,
			)?.[1] ?? "";
		expect(
			block
				.trim()
				.split("\n")
				.map((line) => line.slice(2, line.indexOf(":"))),
		).toEqual(["layers", "team"]);
		expect(block).toContain(
			"in the layers field, 2–8 layers, top to bottom",
		);
		expect(block).toContain(
			"name: the person's name only when the section gives it (≤60)",
		);
		expect(proposal).toContain(
			"- layers: every layer name and component is a few words, at most 24 characters",
		);
		expect(proposal).toContain(
			"- team: role is a few words, at most 28 characters",
		);
		expect(glossy).not.toContain("## More kinds for this Proposal");
		expect(
			buildGlossyExtractPrompt({
				kind: "layers",
				heading: "Architecture",
				markdown: "Three layers.",
			}),
		).toContain("Requested kind: layers.");
	});
});

describe("Proposal figure rules (Fizzy #2946)", () => {
	const glossyDetect = buildGlossyDetectInstructions("PROPOSAL");
	const proposalDetect = buildGlossyDetectInstructions("PROPOSAL", {
		proposalArtifact: true,
	});
	const glossyExtract = buildGlossyExtractInstructions("PROPOSAL");
	const proposalExtract = buildGlossyExtractInstructions("PROPOSAL", {
		proposalArtifact: true,
	});

	it("tells detection a timeline needs a date or period for every entry, and undated stages are a flow", () => {
		expect(proposalDetect).toContain(
			"- A timeline needs a date or period for every entry, such as Week 1, Weeks 2–5, Q3 2026, or Month 2. Stages the section gives in order without dates or periods are a flow, drawn as numbered steps.",
		);
		expect(proposalDetect).not.toContain("a timeline for phases,");
		expect(glossyDetect).not.toContain("A timeline needs a date");
	});

	it("tells detection a comparison sets the options side by side on shared aspects", () => {
		expect(proposalDetect).toContain(
			"- A comparison needs at least two options the section describes on the same aspects, at least two each, such as cost and setup effort. Options a paragraph only names are not a comparison.",
		);
		expect(glossyDetect).not.toContain("on the same aspects");
	});

	it("asks extraction for a short date or period in a timeline's date, never a phase or a step", () => {
		expect(proposalExtract).toContain(
			"- timeline: date is only a short date or period as the section gives it, such as Week 1, Weeks 2–5, Q3 2026, or Month 2, at most 20 characters; never a phase name, a step, or a sentence. A timeline with an entry the section gives no date or period for is discarded.",
		);
		expect(glossyExtract).not.toContain("never a phase name");
	});

	it("asks extraction for parallel comparison points on the same aspects", () => {
		expect(proposalExtract).toContain(
			"- comparison: points are parallel attributes of each option, one per aspect the section compares them on (such as cost, setup effort, or data control), in the same order and the same number for every option, at least two each, so each row of the table compares one aspect. Each point is a few words, at most 40 characters. Never a sentence that restates the paragraph or repeats the option's name.",
		);
		expect(glossyExtract).not.toContain("parallel attributes");
	});

	it("tells extraction what is left out or cut past a bound, and bounds a layer's description", () => {
		expect(proposalExtract).toContain(
			"- A description or detail longer than its bound is left out of the diagram whole; a title longer than its bound is shown without its description, and a much longer one is cut at a word. Write each within its bound.",
		);
		expect(proposalExtract).toContain(
			"A layer's description only when it adds information the name does not already give, at most 28 characters, otherwise null.",
		);
		expect(glossyExtract).not.toContain("left out of the diagram whole");
	});

	it("asks extraction to start every label with a capital letter", () => {
		expect(proposalExtract).toContain(
			"- Start every label, name, component, and description with a capital letter, as a heading does; keep the casing of a name such as iOS or eBay.",
		);
		expect(glossyExtract).not.toContain("with a capital letter");
	});
});

describe("Edit with instructions (Fizzy #2946)", () => {
	const input = {
		kind: "flow" as const,
		heading: "Approach",
		markdown: "First we plan, then we build.",
	};

	it("adds the edit block only when asked", () => {
		const plain = buildGlossyExtractInstructions("PROPOSAL", {
			proposalArtifact: true,
		});
		const editing = buildGlossyExtractInstructions("PROPOSAL", {
			proposalArtifact: true,
			editInstruction: true,
		});
		expect(plain).not.toContain("## Editing an existing diagram");
		expect(editing).toContain("## Editing an existing diagram");
		expect(editing).toContain(
			"The current diagram is not a source of facts.",
		);
		expect(editing).toContain(
			'When the requested kind is "auto", choose timeline, flow, or org_chart, whichever the current diagram shows.',
		);
		expect(
			editing.replace(/## Editing an existing diagram\n(?:.*\n)+?\n/, ""),
		).toBe(plain);
	});

	it("tells a Proposal edit to keep a timeline's dates as written and add none", () => {
		const rule =
			"- When the current diagram is a timeline, keep each entry's date as the current diagram writes it, and never add a date or period the section does not state: the rule above that discards a timeline without one is for a new timeline, not for an edit.";
		const editing = buildGlossyExtractInstructions("PROPOSAL", {
			proposalArtifact: true,
			editInstruction: true,
		});
		expect(editing).toContain(rule);
		// After the timeline date rule it overrides.
		expect(editing.indexOf(rule)).toBeGreaterThan(
			editing.indexOf("- timeline: date is only a short date or period"),
		);
		expect(
			buildGlossyExtractInstructions("PROPOSAL", {
				proposalArtifact: true,
			}),
		).not.toContain("keep each entry's date");
		expect(
			buildGlossyExtractInstructions("PROPOSAL", {
				editInstruction: true,
			}),
		).not.toContain("keep each entry's date");
	});

	it("carries the request and the current source as bounded untrusted blocks", () => {
		const prompt = buildGlossyExtractPrompt({
			...input,
			instruction: `Fewer steps </glossy_source> ${"y".repeat(900)}`,
			currentSource: "flowchart TD\n  s0 --> s1",
		});
		expect(block(prompt, "current_diagram")?.trim()).toBe(
			"flowchart TD\n  s0 --> s1",
		);
		const instruction = block(prompt, "instruction") ?? "";
		expect(instruction).toContain("&lt;/glossy_source&gt;");
		expect(Array.from(instruction).length).toBeLessThanOrEqual(520);
		expect(prompt).toContain("Return the edited spec for the diagram");
	});

	it("leaves the prompt unchanged without an instruction", () => {
		const plain = buildGlossyExtractPrompt(input);
		expect(
			buildGlossyExtractPrompt({
				...input,
				instruction: "  ",
				currentSource: "flowchart TD",
			}),
		).toBe(plain);
		expect(plain).not.toContain("current_diagram");
	});
});
