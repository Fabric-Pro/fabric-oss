/**
 * Template Rendering Utilities
 *
 * Provides unified interface for rendering templates in different formats:
 * - PLAIN_TEXT: No processing
 * - MARKDOWN: No processing (just pass through)
 * - HANDLEBARS: Handlebars template engine
 * - MUSTACHE: Mustache template engine
 * - LIQUID: Liquid template engine
 * - JINJA2: Nunjucks (Jinja2-like for JavaScript)
 */

import Handlebars from "handlebars";
import { Liquid } from "liquidjs";
import Mustache from "mustache";
import nunjucks from "nunjucks";

export type TemplateFormat =
	| "PLAIN_TEXT"
	| "MARKDOWN"
	| "HANDLEBARS"
	| "MUSTACHE"
	| "LIQUID"
	| "JINJA2";

export interface RenderOptions {
	format: TemplateFormat;
	template: string;
	variables: Record<string, any>;
}

export interface RenderResult {
	rendered: string;
	error?: string;
}

/**
 * Render a template with the specified format and variables
 */
export async function renderTemplate({
	format,
	template,
	variables,
}: RenderOptions): Promise<RenderResult> {
	try {
		switch (format) {
			case "PLAIN_TEXT":
			case "MARKDOWN":
				// No processing needed
				return { rendered: template };

			case "HANDLEBARS":
				return renderHandlebars(template, variables);

			case "MUSTACHE":
				return renderMustache(template, variables);

			case "LIQUID":
				return await renderLiquid(template, variables);

			case "JINJA2":
				return renderJinja2(template, variables);

			default:
				return {
					rendered: template,
					error: `Unknown template format: ${format}`,
				};
		}
	} catch (error) {
		return {
			rendered: template,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Render Handlebars template
 */
function renderHandlebars(
	template: string,
	variables: Record<string, any>,
): RenderResult {
	try {
		const compiled = Handlebars.compile(template);
		const rendered = compiled(variables);
		return { rendered };
	} catch (error) {
		return {
			rendered: template,
			error: `Handlebars error: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Render Mustache template
 */
function renderMustache(
	template: string,
	variables: Record<string, any>,
): RenderResult {
	try {
		const rendered = Mustache.render(template, variables);
		return { rendered };
	} catch (error) {
		return {
			rendered: template,
			error: `Mustache error: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Render Liquid template
 */
async function renderLiquid(
	template: string,
	variables: Record<string, any>,
): Promise<RenderResult> {
	try {
		const engine = new Liquid();
		const rendered = await engine.parseAndRender(template, variables);
		return { rendered };
	} catch (error) {
		return {
			rendered: template,
			error: `Liquid error: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Render Jinja2-like template using Nunjucks
 */
function renderJinja2(
	template: string,
	variables: Record<string, any>,
): RenderResult {
	try {
		// Configure nunjucks to not use file system
		const env = new nunjucks.Environment(null, { autoescape: false });
		const rendered = env.renderString(template, variables);
		return { rendered };
	} catch (error) {
		return {
			rendered: template,
			error: `Jinja2 error: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Validate template syntax without rendering
 */
export function validateTemplate(
	format: TemplateFormat,
	template: string,
): { valid: boolean; error?: string } {
	try {
		switch (format) {
			case "PLAIN_TEXT":
			case "MARKDOWN":
				return { valid: true };

			case "HANDLEBARS":
				// Handlebars.compile() is LAZY — it returns a function and defers
				// parsing to the first invocation, so compiling alone validates
				// nothing. Invoking against an empty bag forces the parse; missing
				// variables are not an error in Handlebars, so a valid template
				// renders cleanly here and an invalid one throws.
				Handlebars.compile(template)({});
				return { valid: true };

			case "MUSTACHE":
				Mustache.parse(template);
				return { valid: true };

			case "LIQUID": {
				const engine = new Liquid();
				engine.parse(template);
				return { valid: true };
			}

			case "JINJA2": {
				const env = new nunjucks.Environment(null, {
					autoescape: false,
				});
				env.renderString(template, {});
				return { valid: true };
			}

			default:
				return {
					valid: false,
					error: `Unknown template format: ${format}`,
				};
		}
	} catch (error) {
		return {
			valid: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
