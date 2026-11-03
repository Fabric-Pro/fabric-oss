/**
 * The Mermaid templates of a Proposal's layers and team figures
 * (Fizzy #2946), kept apart from `./visual-templates` because only a
 * Proposal draws them; Glossy never does. `visualSpecToMermaid` there
 * dispatches to them, and that module re-exports both, so importers keep one
 * path.
 *
 * They build their labels with the helpers the other Mermaid templates use,
 * from `./visual-labels`: every label in `proposalLabelCase`, a detail too
 * long for its line left out whole rather than cut, and only a title past
 * the two-line cap cut, at a word.
 *
 * No Node built-ins: same browser-safety rule as `./visual-templates`.
 */

import {
	multilineLabel,
	nodeColorLine,
	proposalDetailLines,
	proposalKeptDetailLines,
	proposalTitleText,
	type VisualTemplateOptions,
} from "./visual-labels";
import type { LayersVisualSpec, TeamVisualSpec } from "./visual-spec";

/**
 * A figure node's label: the title on one line (the figure template wraps
 * it to its own width, and ends its last line at a word with an ellipsis
 * when the box holds fewer lines), then each detail on a line of its own.
 * No detail is cut: one that does not fit one line, or repeats the title,
 * is left out whole, and a title longer than the extraction asks for keeps
 * no details (`proposalDetailLines`); in the fence, only a title past the
 * two-line cap is cut, at a word (`proposalTitleText`). The template draws
 * the first line as the title and the others as detail, and cuts short a
 * single word wider than its box on any of them.
 */
function figureNodeLabel(
	title: string,
	details: ReadonlyArray<string | undefined> = [],
): string {
	return multilineLabel([
		proposalTitleText(title),
		...proposalDetailLines(title, details),
	]);
}

/**
 * A subgraph's title: its name, then an optional description on a line of
 * its own, left out whole when it does not fit one. The figure template
 * draws the first line as the heading and the second under it.
 */
function groupTitle(name: string, description?: string): string {
	return multilineLabel([
		proposalTitleText(name),
		...proposalDetailLines(name, [description]),
	]);
}

/**
 * A team member's card: the role as its title, then the person's name and
 * a detail. The name is what the card is there to show, so a role longer
 * than the extraction asks for drops only the detail; the name is left out
 * only when it does not fit one line or repeats the role
 * (`proposalKeptDetailLines`).
 */
function memberLabel(
	member: TeamVisualSpec["proposer"]["members"][number],
): string {
	return multilineLabel([
		proposalTitleText(member.role),
		...proposalKeptDetailLines(member.role, [member.name]),
		...proposalDetailLines(member.role, [member.description]),
	]);
}

/**
 * A layer's component or a crosscutting item: one line, whole up to the
 * two-line cap and cut at a word past it (`proposalTitleText`). The figure
 * template wraps it to its own width, as it does a title.
 */
function componentLabel(text: string): string {
	return multilineLabel([proposalTitleText(text)]);
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
			lines.push(`${id}["${componentLabel(component)}"]`);
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
			lines.push(`${id}["${componentLabel(item)}"]`);
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
 * the member's role with their name and a detail under it (`memberLabel`),
 * and the shared forum, when there is one, as the one node outside both.
 * No edges between people: a working link the section does not state would
 * be a claim no fact check reads, and with a shared forum the template
 * joins both sides through it. Ids are generated (`p<index>`, `c<index>`,
 * `s0`).
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
			lines.push(`${id}["${memberLabel(member)}"]`);
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
