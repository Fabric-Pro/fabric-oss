/**
 * Azure DevOps work-item FORM metadata.
 *
 * A field's catalogued `name` is frequently not what an admin sees on the work
 * item. Rich-text bodies are typically rendered with an empty control label
 * inside a titled group, so the visible heading comes from the GROUP:
 *
 *   <Group Label="++ Story Details (Analysis) ++">
 *     <Control Label="" FieldName="Custom.BusinessRules" Type="HtmlFieldControl" />
 *   </Group>
 *
 * Catalogued as "Business Rules"; on screen it reads "++ Story Details
 * (Analysis) ++". Someone searching for what they can see finds nothing.
 *
 * The form also DECLARES which controls are rich-text bodies (`HtmlFieldControl`).
 * That is the field class an inbound content mapping wants, stated outright in
 * metadata rather than inferred from how long the values happen to be — so it
 * beats every content heuristic, needs no sampling, and stays explainable.
 *
 * `xmlForm` is returned for XML/classic-process projects. Projects on the
 * inherited process model do not expose it here, so callers must degrade to
 * value-based scoring when {@link parseAdoFormMetadata} yields nothing.
 */

/** Control types that render a long-form, formatted body. */
const CONTENT_CONTROL_TYPES = new Set(["htmlfieldcontrol", "plaintextcontrol"]);

export interface AdoFormField {
	/** Field referenceName, e.g. `Custom.BusinessRules`. */
	referenceName: string;
	/** The label actually shown on the form (control label, else group label). */
	label: string;
	/** Raw control type from the form definition. */
	controlType: string;
	/** True when the control renders a rich-text/long-form body. */
	isContentControl: boolean;
}

/** Decode the small set of XML entities that appear in form labels. */
function decodeXmlEntities(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function attr(tag: string, name: string): string | undefined {
	const match = tag.match(new RegExp(`${name}="([^"]*)"`, "i"));
	return match ? decodeXmlEntities(match[1] ?? "") : undefined;
}

/**
 * Parse a work item type's `xmlForm` into per-field form metadata.
 *
 * Walks the document in order, tracking the innermost enclosing `<Group>` label
 * so a control with an empty label inherits the heading a user actually reads.
 * Returns an empty map for absent/oversized/unparseable input — callers treat
 * that as "no form metadata" and fall back.
 */
export function parseAdoFormMetadata(
	xmlForm: string | undefined | null,
): Map<string, AdoFormField> {
	const fields = new Map<string, AdoFormField>();
	if (!xmlForm || typeof xmlForm !== "string") {
		return fields;
	}

	// Group labels nest; keep a stack so closing a group restores the outer one.
	const groupLabels: string[] = [];
	const tagPattern = /<(\/?)(Group|Control)\b([^>]*?)(\/?)>/gi;

	let match: RegExpExecArray | null = tagPattern.exec(xmlForm);
	while (match !== null) {
		const [full, closing, rawName, , selfClosing] = match;
		const name = (rawName ?? "").toLowerCase();

		if (name === "group") {
			if (closing) {
				groupLabels.pop();
			} else if (!selfClosing) {
				groupLabels.push(attr(full, "Label") ?? "");
			}
		} else if (name === "control" && !closing) {
			const referenceName = attr(full, "FieldName");
			if (referenceName) {
				const controlLabel = (attr(full, "Label") ?? "").trim();
				const groupLabel = (
					groupLabels[groupLabels.length - 1] ?? ""
				).trim();
				const controlType = attr(full, "Type") ?? "";

				// First definition wins: a field repeated on several form tabs
				// keeps the label from where it is defined first.
				if (!fields.has(referenceName)) {
					fields.set(referenceName, {
						referenceName,
						label: controlLabel || groupLabel,
						controlType,
						isContentControl: CONTENT_CONTROL_TYPES.has(
							controlType.toLowerCase(),
						),
					});
				}
			}
		}

		match = tagPattern.exec(xmlForm);
	}

	return fields;
}

/**
 * Merge form metadata from several work item types.
 *
 * A project's inbound mapping is configured per type, but a field can appear on
 * more than one; the first type that defines a field supplies its label, matching
 * `parseAdoFormMetadata`'s first-definition-wins rule.
 */
export function mergeAdoFormMetadata(
	maps: Array<Map<string, AdoFormField>>,
): Map<string, AdoFormField> {
	const merged = new Map<string, AdoFormField>();
	for (const map of maps) {
		for (const [referenceName, field] of map) {
			if (!merged.has(referenceName)) {
				merged.set(referenceName, field);
			}
		}
	}
	return merged;
}
