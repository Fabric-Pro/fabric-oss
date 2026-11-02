/**
 * The Mermaid templates of a Proposal's layers and team figures
 * (Fizzy #2946), kept apart from `./visual-templates` because only a
 * Proposal draws them; Glossy never does. `visualSpecToMermaid` there
 * dispatches to them, and that module re-exports both, so importers keep one
 * path.
 *
 * They build their labels with the helpers the other Mermaid templates use,
 * from `./visual-labels`.
 *
 * No Node built-ins: same browser-safety rule as `./visual-templates`.
 */

import {
	cutLabelAtWord,
	detailRepeatsTitle,
	multilineLabel,
	nodeColorLine,
	PROPOSAL_VISUAL_LINE_MAX_CHARS,
	PROPOSAL_VISUAL_TITLE_MAX_LINES,
	type VisualTemplateOptions,
} from "./visual-labels";
import type { LayersVisualSpec, TeamVisualSpec } from "./visual-spec";

/**
 * A figure node's label: the title on one line, cut at the two-line budget
 * (the figure template wraps it to its own width), then each detail on a
 * line of its own, cut at `PROPOSAL_VISUAL_LINE_MAX_CHARS`. A detail that
 * repeats the title is left out. The template draws the first line as the
 * title and the others as detail.
 */
function figureNodeLabel(
	title: string,
	details: ReadonlyArray<string | undefined> = [],
): string {
	const width = PROPOSAL_VISUAL_LINE_MAX_CHARS;
	const lines = [
		cutLabelAtWord(title, width * PROPOSAL_VISUAL_TITLE_MAX_LINES),
	];
	for (const detail of details) {
		if (detail?.trim() && !detailRepeatsTitle(title, detail)) {
			lines.push(cutLabelAtWord(detail, width));
		}
	}
	return multilineLabel(lines);
}

/**
 * A subgraph's title: its name, then an optional description, each on one
 * line cut at `PROPOSAL_VISUAL_LINE_MAX_CHARS`. The figure template draws
 * the first line as the heading and the second under it.
 */
function groupTitle(name: string, description?: string): string {
	const width = PROPOSAL_VISUAL_LINE_MAX_CHARS;
	const lines = [cutLabelAtWord(name, width)];
	if (description?.trim() && !detailRepeatsTitle(name, description)) {
		lines.push(cutLabelAtWord(description, width));
	}
	return multilineLabel(lines);
}

/**
 * Architecture layers for the Proposal's layers figure: one subgraph per
 * layer, top to bottom, each holding its components, and an optional
 * subgraph with the id `crosscutting` the template draws as a column on
 * the right. No edges: the template draws none, and a node outside every
 * subgraph would make it refuse the fence. A component is one short line,
 * since a row holds five. Ids are generated (`l<layer>c<index>`, `x<index>`),
 * never spec text.
 */
export function layersToMermaid(
	spec: LayersVisualSpec,
	options: VisualTemplateOptions = {},
): string {
	const lines = ["flowchart TD"];
	const ids: string[] = [];
	spec.layers.forEach((layer, layerIndex) => {
		lines.push(
			`subgraph l${layerIndex}["${groupTitle(layer.name, layer.description)}"]`,
		);
		layer.components.forEach((component, index) => {
			const id = `l${layerIndex}c${index}`;
			lines.push(
				`${id}["${multilineLabel([cutLabelAtWord(component, PROPOSAL_VISUAL_LINE_MAX_CHARS)])}"]`,
			);
			ids.push(id);
		});
		lines.push("end");
	});
	if (spec.crosscutting) {
		const side = spec.crosscutting;
		lines.push(
			`subgraph crosscutting["${groupTitle(side.name, side.description)}"]`,
		);
		side.items.forEach((item, index) => {
			const id = `x${index}`;
			lines.push(
				`${id}["${multilineLabel([cutLabelAtWord(item, PROPOSAL_VISUAL_LINE_MAX_CHARS)])}"]`,
			);
			ids.push(id);
		});
		lines.push("end");
	}
	for (const id of ids) {
		lines.push(nodeColorLine(id, options));
	}
	return lines.join("\n");
}

/**
 * A team for the Proposal's team figure: the proposer's subgraph first and
 * the client's second (the template reads them in that order), each card
 * the member's role with their name and a detail under it, and the shared
 * forum, when there is one, as the one node outside both. No edges between
 * people: a working link the section does not state would be a claim no
 * fact check reads, and with a shared forum the template joins both sides
 * through it. Ids are generated (`p<index>`, `c<index>`, `s0`).
 */
export function teamToMermaid(
	spec: TeamVisualSpec,
	options: VisualTemplateOptions = {},
): string {
	const lines = ["flowchart TD"];
	const ids: string[] = [];
	const side = (
		subgraphId: string,
		prefix: string,
		team: TeamVisualSpec["proposer"],
	) => {
		lines.push(
			`subgraph ${subgraphId}["${groupTitle(team.name, team.description)}"]`,
		);
		team.members.forEach((member, index) => {
			const id = `${prefix}${index}`;
			lines.push(
				`${id}["${figureNodeLabel(member.role, [member.name, member.description])}"]`,
			);
			ids.push(id);
		});
		lines.push("end");
	};
	side("proposer", "p", spec.proposer);
	side("client", "c", spec.client);
	if (spec.shared?.trim()) {
		lines.push(`s0["${figureNodeLabel(spec.shared)}"]`);
		ids.push("s0");
	}
	for (const id of ids) {
		lines.push(nodeColorLine(id, options));
	}
	return lines.join("\n");
}
