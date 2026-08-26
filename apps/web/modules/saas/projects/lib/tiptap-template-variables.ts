import type { RawCommands } from "@tiptap/core";
import { Mark, mergeAttributes } from "@tiptap/core";

/**
 * TipTap extension for highlighting template variables
 * Supports multiple template formats:
 * - Handlebars: {{variable}}
 * - Mustache: {{variable}}
 * - Liquid: {{ variable }}, {% if %}
 * - Jinja2: {{ variable }}, {% if %}
 */
export const TemplateVariable = Mark.create({
	name: "templateVariable",

	addOptions() {
		return {
			HTMLAttributes: {
				class: "template-variable",
			},
		};
	},

	parseHTML() {
		return [
			{
				tag: "span.template-variable",
			},
		];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"span",
			mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
			0,
		];
	},

	addCommands() {
		return {
			setTemplateVariable:
				() =>
				({ commands }: { commands: RawCommands }) => {
					return commands.setMark(this.name);
				},
			toggleTemplateVariable:
				() =>
				({ commands }: { commands: RawCommands }) => {
					return commands.toggleMark(this.name);
				},
			unsetTemplateVariable:
				() =>
				({ commands }: { commands: RawCommands }) => {
					return commands.unsetMark(this.name);
				},
		} as Partial<RawCommands>;
	},
});

/**
 * CSS styles for template variables
 * Add this to your global CSS or component styles:
 *
 * .template-variable {
 *   background-color: rgba(59, 130, 246, 0.1);
 *   color: rgb(59, 130, 246);
 *   padding: 0.125rem 0.25rem;
 *   border-radius: 0.25rem;
 *   font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
 *   font-size: 0.875em;
 * }
 */
