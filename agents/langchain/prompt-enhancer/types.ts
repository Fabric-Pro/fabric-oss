/**
 * Prompt Enhancer Types
 *
 * Defines types and structures for the Prompt Enhancer Agent.
 */

/**
 * Supported prompt formats
 */
export type PromptFormat =
	| "PLAIN_TEXT"
	| "MARKDOWN"
	| "HANDLEBARS"
	| "MUSTACHE"
	| "LIQUID"
	| "JINJA2";

/**
 * Prompt categories
 */
export type PromptCategory =
	| "document-generation"
	| "agent-instructions"
	| "code-generation"
	| "workflow"
	| "general";

/**
 * Enhancement type
 */
export type EnhancementType =
	| "rewrite" // Rewrite for clarity and professionalism
	| "expand" // Expand with more detail and examples
	| "restructure" // Restructure for better flow
	| "add_variables" // Add template variables
	| "apply_best_practices" // Apply best practices for the category
	| "optimize" // Optimize for specific use case
	| "general"; // General enhancement based on user request

/**
 * Format-specific guidance with explicit preservation examples
 */
export const FORMAT_GUIDANCE: Record<PromptFormat, string> = {
	PLAIN_TEXT:
		"Plain text format with no special syntax. Use simple {variable} placeholders if needed.",
	MARKDOWN:
		"Markdown format supporting headers, lists, code blocks, and emphasis. Use {variable} for placeholders.",
	HANDLEBARS: `Handlebars template syntax. CRITICAL PRESERVATION RULES:
- Simple variables: {{variable}} - Keep the double curly braces exactly
- Loops: {{#each items}}{{this}}{{/each}} - Keep #each, /each intact
- Conditionals: {{#if condition}}...{{/if}} - Keep #if, /if intact
- Unless: {{#unless condition}}...{{/unless}}
- Index: {{@index}} - Keep the @ symbol
- Nested: {{this.property}} - Keep the dot notation
EXAMPLE INPUT: "{{#each features}}### {{this.name}}{{/each}}"
EXAMPLE OUTPUT: "{{#each features}}### {{this.name}}\\n{{this.description}}{{/each}}"`,
	MUSTACHE: `Mustache template syntax. CRITICAL PRESERVATION RULES:
- Variables: {{variable}} - Keep double curly braces
- Sections: {{#items}}{{name}}{{/items}} - Keep # and / markers
- Inverted: {{^items}}No items{{/items}} - Keep ^ for inverted
- Comments: {{! comment }} - Keep the ! for comments
EXAMPLE: "{{#users}}Name: {{name}}{{/users}}"`,
	LIQUID: `Liquid template syntax. CRITICAL PRESERVATION RULES:
- Output: {{ variable }} - Note the spaces inside braces
- Logic: {% if condition %}...{% endif %} - Use {% %} for logic
- Loops: {% for item in items %}...{% endfor %}
- Filters: {{ variable | filter }}
EXAMPLE: "{% for item in items %}{{ item.name }}{% endfor %}"`,
	JINJA2: `Jinja2 template syntax. CRITICAL PRESERVATION RULES:
- Variables: {{ variable }} - Note the spaces inside braces
- Conditionals: {% if condition %}...{% endif %}
- Loops: {% for item in items %}...{% endfor %}
- Filters: {{ variable | filter }}
- Raw blocks: {% raw %}...{% endraw %} - Escape template syntax
EXAMPLE: "{% for user in users %}{{ user.name | capitalize }}{% endfor %}"`,
};
