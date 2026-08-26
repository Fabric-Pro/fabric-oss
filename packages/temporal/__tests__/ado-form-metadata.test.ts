/**
 * Form-metadata parsing tests.
 *
 * The shapes here mirror what a real classic-process form emits: rich-text
 * bodies carry an EMPTY control label inside a titled group, so the visible
 * heading has to come from the group. Getting that wrong is why an admin can
 * search for the heading they see and find nothing.
 *
 * All labels and field names are synthetic.
 */
import { describe, expect, it } from "vitest";
import {
	type AdoFormField,
	mergeAdoFormMetadata,
	parseAdoFormMetadata,
} from "../src/activities/pm-integration/ado-form-metadata";

const FORM = `
<FORM>
  <Layout>
    <Group Label="Summary">
      <Column PercentWidth="100">
        <Control Label="Title" FieldName="System.Title" Type="FieldControl" />
        <Control Label="State" FieldName="System.State" Type="FieldControl" />
      </Column>
    </Group>
    <Group Label="++ Story Details (Design) ++">
      <Column PercentWidth="100">
        <Control Label="" LabelPosition="Top" FieldName="Custom.DesignCriteria" Type="HtmlFieldControl" />
      </Column>
    </Group>
    <Group Label="++ Story Details (Analysis -&gt; Acceptance) ++">
      <Column PercentWidth="100">
        <Control Label="" LabelPosition="Top" FieldName="Custom.BusinessRules" Type="HtmlFieldControl" />
      </Column>
    </Group>
    <Group Label="++ Story Details (Outgoing) ++ (OLD - Do Not Use)">
      <Column PercentWidth="100">
        <Control Label="" FieldName="Custom.LegacyNotes" Type="HtmlFieldControl" />
      </Column>
    </Group>
    <Group Label="Automation">
      <Column PercentWidth="100">
        <Control Label="StateSummary" FieldName="Custom.StateSummary" Type="FieldControl" />
      </Column>
    </Group>
  </Layout>
</FORM>
`;

describe("parseAdoFormMetadata", () => {
	const parsed = parseAdoFormMetadata(FORM);

	it("takes the visible heading from the enclosing group when the control label is empty", () => {
		expect(parsed.get("Custom.BusinessRules")?.label).toBe(
			"++ Story Details (Analysis -> Acceptance) ++",
		);
		expect(parsed.get("Custom.DesignCriteria")?.label).toBe(
			"++ Story Details (Design) ++",
		);
	});

	it("prefers an explicit control label over the group heading", () => {
		expect(parsed.get("System.Title")?.label).toBe("Title");
		expect(parsed.get("Custom.StateSummary")?.label).toBe("StateSummary");
	});

	it("decodes XML entities in labels", () => {
		expect(parsed.get("Custom.BusinessRules")?.label).toContain("->");
		expect(parsed.get("Custom.BusinessRules")?.label).not.toContain("&gt;");
	});

	it("flags rich-text controls as content, and nothing else", () => {
		expect(parsed.get("Custom.BusinessRules")?.isContentControl).toBe(true);
		expect(parsed.get("Custom.DesignCriteria")?.isContentControl).toBe(
			true,
		);
		// A status field is on the form and populated on every ticket, but it is
		// not a body — the declared control type says so without any heuristic.
		expect(parsed.get("Custom.StateSummary")?.isContentControl).toBe(false);
		expect(parsed.get("System.Title")?.isContentControl).toBe(false);
	});

	it("closes groups so later controls do not inherit a stale heading", () => {
		// StateSummary follows several groups; it must not pick up an earlier one.
		expect(parsed.get("Custom.StateSummary")?.label).not.toContain("Story");
	});

	it("still surfaces a retired content field, label intact", () => {
		// Deliberately NOT filtered: the form marks it, and the label carries the
		// warning. Hiding it would be a guess; showing it is a judgment the admin
		// can make in one glance.
		const legacy = parsed.get("Custom.LegacyNotes");
		expect(legacy?.isContentControl).toBe(true);
		expect(legacy?.label).toContain("OLD - Do Not Use");
	});

	it("records the raw control type", () => {
		expect(parsed.get("Custom.BusinessRules")?.controlType).toBe(
			"HtmlFieldControl",
		);
	});

	it("returns an empty map for absent or unusable input", () => {
		expect(parseAdoFormMetadata(undefined).size).toBe(0);
		expect(parseAdoFormMetadata(null).size).toBe(0);
		expect(parseAdoFormMetadata("").size).toBe(0);
		expect(parseAdoFormMetadata("not xml at all").size).toBe(0);
	});

	it("ignores controls with no FieldName", () => {
		const map = parseAdoFormMetadata(
			'<Group Label="G"><Control Type="WebpageControl" /></Group>',
		);
		expect(map.size).toBe(0);
	});

	it("keeps the first definition when a field repeats across tabs", () => {
		const map = parseAdoFormMetadata(`
			<Group Label="First"><Control Label="" FieldName="Custom.Dup" Type="HtmlFieldControl" /></Group>
			<Group Label="Second"><Control Label="" FieldName="Custom.Dup" Type="FieldControl" /></Group>
		`);
		expect(map.get("Custom.Dup")?.label).toBe("First");
		expect(map.get("Custom.Dup")?.isContentControl).toBe(true);
	});

	it("treats a self-closing group as introducing no heading", () => {
		const map = parseAdoFormMetadata(
			'<Group Label="Outer"><Group Label="Empty" /><Control Label="" FieldName="Custom.A" Type="HtmlFieldControl" /></Group>',
		);
		expect(map.get("Custom.A")?.label).toBe("Outer");
	});
});

describe("mergeAdoFormMetadata", () => {
	const a = new Map<string, AdoFormField>([
		[
			"Custom.Shared",
			{
				referenceName: "Custom.Shared",
				label: "From Story",
				controlType: "HtmlFieldControl",
				isContentControl: true,
			},
		],
	]);
	const b = new Map<string, AdoFormField>([
		[
			"Custom.Shared",
			{
				referenceName: "Custom.Shared",
				label: "From Bug",
				controlType: "HtmlFieldControl",
				isContentControl: true,
			},
		],
		[
			"Custom.BugOnly",
			{
				referenceName: "Custom.BugOnly",
				label: "Repro",
				controlType: "HtmlFieldControl",
				isContentControl: true,
			},
		],
	]);

	it("unions fields across types, first definition winning", () => {
		const merged = mergeAdoFormMetadata([a, b]);
		expect(merged.get("Custom.Shared")?.label).toBe("From Story");
		expect(merged.get("Custom.BugOnly")?.label).toBe("Repro");
		expect(merged.size).toBe(2);
	});

	it("handles an empty input list", () => {
		expect(mergeAdoFormMetadata([]).size).toBe(0);
	});
});
