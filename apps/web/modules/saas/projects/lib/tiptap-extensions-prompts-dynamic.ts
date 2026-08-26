import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { Link } from "@tiptap/extension-link";
import { Placeholder } from "@tiptap/extension-placeholder";
import { TextStyle } from "@tiptap/extension-text-style";
import { StarterKit } from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";
import { TemplateVariable } from "./tiptap-template-variables";

// Create lowlight instance for syntax highlighting with additional languages
const lowlight = createLowlight(common);

// Register additional template languages for better syntax highlighting
// These are approximations using similar syntax highlighting
try {
	// Use handlebars syntax for Handlebars
	lowlight.register("handlebars", (_hljs) => ({
		name: "handlebars",
		contains: [
			{
				className: "template-variable",
				begin: "{{",
				end: "}}",
				contains: [
					{
						className: "name",
						begin: "[a-zA-Z_][a-zA-Z0-9_]*",
					},
					{
						className: "keyword",
						begin: "#|/|\\^|>|!",
					},
				],
			},
		],
	}));

	// Use similar syntax for Mustache (very similar to Handlebars)
	lowlight.register("mustache", (_hljs) => ({
		name: "mustache",
		contains: [
			{
				className: "template-variable",
				begin: "{{",
				end: "}}",
				contains: [
					{
						className: "name",
						begin: "[a-zA-Z_][a-zA-Z0-9_]*",
					},
					{
						className: "keyword",
						begin: "#|/|\\^|!",
					},
				],
			},
		],
	}));

	// Liquid template syntax
	lowlight.register("liquid", (_hljs) => ({
		name: "liquid",
		contains: [
			{
				className: "template-tag",
				begin: "{%",
				end: "%}",
				contains: [
					{
						className: "keyword",
						begin: "\\b(if|elsif|else|endif|for|endfor|case|when|endcase|assign|capture|endcapture|increment|decrement|cycle|include|render)\\b",
					},
					{
						className: "name",
						begin: "[a-zA-Z_][a-zA-Z0-9_]*",
					},
				],
			},
			{
				className: "template-variable",
				begin: "{{",
				end: "}}",
				contains: [
					{
						className: "name",
						begin: "[a-zA-Z_][a-zA-Z0-9_]*",
					},
					{
						className: "filter",
						begin: "\\|",
					},
				],
			},
		],
	}));

	// Jinja2 template syntax
	lowlight.register("jinja2", (_hljs) => ({
		name: "jinja2",
		contains: [
			{
				className: "template-tag",
				begin: "{%",
				end: "%}",
				contains: [
					{
						className: "keyword",
						begin: "\\b(if|elif|else|endif|for|endfor|block|endblock|extends|include|import|from|macro|endmacro|call|endcall|filter|endfilter|set|raw|endraw)\\b",
					},
					{
						className: "name",
						begin: "[a-zA-Z_][a-zA-Z0-9_]*",
					},
				],
			},
			{
				className: "template-variable",
				begin: "{{",
				end: "}}",
				contains: [
					{
						className: "name",
						begin: "[a-zA-Z_][a-zA-Z0-9_]*",
					},
					{
						className: "filter",
						begin: "\\|",
					},
				],
			},
			{
				className: "comment",
				begin: "{#",
				end: "#}",
			},
		],
	}));
} catch (error) {
	// Language registration errors are non-critical
	console.warn("Failed to register custom template languages:", error);
}

type PromptFormat =
	| "PLAIN_TEXT"
	| "MARKDOWN"
	| "HANDLEBARS"
	| "MUSTACHE"
	| "LIQUID"
	| "JINJA2";

/**
 * Get format-specific placeholder text
 */
function getPlaceholderForFormat(format: PromptFormat): string {
	const placeholders: Record<PromptFormat, string> = {
		PLAIN_TEXT: "Type your prompt here... Keep it simple and clear.",
		MARKDOWN:
			"Type your prompt here... Use **bold**, *italic*, # headings, and more markdown formatting.",
		HANDLEBARS:
			"Type your prompt here... Use {{variable}} for variables, {{#if condition}}...{{/if}} for conditionals, {{#each items}}...{{/each}} for loops.",
		MUSTACHE:
			"Type your prompt here... Use {{variable}} for variables, {{#section}}...{{/section}} for sections, {{^inverted}}...{{/inverted}} for inverted sections.",
		LIQUID: "Type your prompt here... Use {{ variable }} for output, {% if condition %}...{% endif %} for logic, {% for item in items %}...{% endfor %} for loops.",
		JINJA2: "Type your prompt here... Use {{ variable }} for variables, {% if condition %}...{% endif %} for conditionals, {% for item in items %}...{% endfor %} for loops, {{ variable | filter }} for filters.",
	};
	return placeholders[format];
}

/**
 * Get format-specific code block language
 */
function getCodeBlockLanguage(format: PromptFormat): string {
	const languages: Record<PromptFormat, string> = {
		PLAIN_TEXT: "text",
		MARKDOWN: "markdown",
		HANDLEBARS: "handlebars",
		MUSTACHE: "mustache",
		LIQUID: "liquid",
		JINJA2: "jinja2",
	};
	return languages[format];
}

/**
 * Create TipTap extensions for prompt editing with format-specific configuration
 */
export function createPromptExtensions(format: PromptFormat) {
	const extensions = [
		StarterKit.configure({
			heading: {
				levels: [1, 2, 3, 4, 5, 6],
			},
			bulletList: {
				keepMarks: true,
				keepAttributes: false,
			},
			orderedList: {
				keepMarks: true,
				keepAttributes: false,
			},
			// Disable default code block to use CodeBlockLowlight instead
			codeBlock: false,
			// Disable link — configured separately below
			link: false,
		}),

		// Enhanced code blocks with syntax highlighting
		CodeBlockLowlight.configure({
			lowlight,
			defaultLanguage: getCodeBlockLanguage(format),
		}),

		// Format-specific placeholder text
		Placeholder.configure({
			placeholder: ({ node }) => {
				if (node.type.name === "heading") {
					return "Heading";
				}
				return getPlaceholderForFormat(format);
			},
			showOnlyWhenEditable: true,
		}),

		// Text styling foundations
		TextStyle,

		// Text color
		Color.configure({
			types: ["textStyle"],
		}),

		// Text highlighting
		Highlight.configure({
			multicolor: true,
		}),

		// Template variable highlighting (for template formats)
		TemplateVariable,

		// Links
		Link.configure({
			openOnClick: false,
			HTMLAttributes: {
				class: "tiptap-link",
			},
		}),
	];

	return extensions;
}

/**
 * Get format-specific syntax examples
 */
export function getSyntaxExamples(format: PromptFormat): string[] {
	const examples: Record<PromptFormat, string[]> = {
		PLAIN_TEXT: [
			"Simple text without any special formatting",
			"Use {variable} for basic placeholders if needed",
		],
		MARKDOWN: [
			"**Bold text** and *italic text*",
			"# Heading 1, ## Heading 2, ### Heading 3",
			"[Link text](https://example.com)",
			"- Bullet point\n- Another point",
			"1. Numbered list\n2. Second item",
			"```code\ncode block\n```",
			"> Blockquote",
		],
		HANDLEBARS: [
			"{{variable}} - Simple variable",
			"{{#if condition}}...{{else}}...{{/if}} - Conditional",
			"{{#each items}}{{this}}{{/each}} - Loop",
			"{{#unless condition}}...{{/unless}} - Inverted conditional",
			"{{> partialName}} - Partial",
		],
		MUSTACHE: [
			"{{variable}} - Simple variable",
			"{{#section}}...{{/section}} - Section",
			"{{^inverted}}...{{/inverted}} - Inverted section",
			"{{! comment }} - Comment",
		],
		LIQUID: [
			"{{ variable }} - Output variable",
			"{% if condition %}...{% else %}...{% endif %} - Conditional",
			"{% for item in items %}...{% endfor %} - Loop",
			"{% assign name = value %} - Variable assignment",
			"{{ variable | filter }} - Filter",
			"{% case variable %}{% when value %}...{% endcase %} - Case statement",
		],
		JINJA2: [
			"{{ variable }} - Output variable",
			"{% if condition %}...{% elif %}...{% else %}...{% endif %} - Conditional",
			"{% for item in items %}...{% endfor %} - Loop",
			"{% set name = value %} - Variable assignment",
			"{{ variable | filter }} - Filter",
			"{{ variable | filter(arg) }} - Filter with argument",
			"{% block name %}...{% endblock %} - Block",
			"{% extends 'base.html' %} - Template inheritance",
		],
	};
	return examples[format];
}

/**
 * Get format-specific description
 */
export function getFormatDescription(format: PromptFormat): string {
	const descriptions: Record<PromptFormat, string> = {
		PLAIN_TEXT:
			"Simple text format without any special syntax. Best for basic prompts that don't need variable substitution or formatting.",
		MARKDOWN:
			"Rich text format supporting headings, lists, code blocks, links, and text formatting. Perfect for well-structured prompts with documentation.",
		HANDLEBARS:
			"Powerful templating engine with support for variables, conditionals, loops, and partials. Great for dynamic prompts with complex logic.",
		MUSTACHE:
			"Logic-less templating system with simple variable substitution and sections. Ideal for clean, maintainable prompt templates.",
		LIQUID: "Flexible templating language with filters and tags. Excellent for prompts that need data transformation and formatting.",
		JINJA2: "Full-featured templating engine with powerful control structures and filters. Best for complex prompts requiring advanced logic and template inheritance.",
	};
	return descriptions[format];
}
