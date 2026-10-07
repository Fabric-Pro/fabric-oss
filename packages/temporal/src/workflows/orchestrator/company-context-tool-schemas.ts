/**
 * The company-context search tool's name, description and input schema —
 * pure data, shared by the Direct chat tool and the Orchestrator's
 * registration of the same tool, so the two engines cannot describe different
 * arguments. Workflow-sandbox safe.
 *
 * The tool searches the organization's own company context: the material it
 * keeps about itself, for its members only. Who may call it is decided by the
 * tool's builder and re-checked on every call, never by this schema.
 */

export const COMPANY_CONTEXT_SEARCH_TOOL_NAME = "search_company_context";

export const COMPANY_CONTEXT_SEARCH_INPUT_SCHEMA = {
	type: "object",
	properties: {
		query: {
			type: "string",
			description:
				"What to look up in the organization's own material, as a short search phrase: a capability, service, industry, kind of client or past project, e.g. 'logistics case studies' or 'security certifications'.",
		},
	},
	required: ["query"],
} as const satisfies Record<string, unknown>;

export const COMPANY_CONTEXT_SEARCH_DESCRIPTION =
	"Search the organization's own company context — the material it keeps about itself, such as capabilities, services, case studies, positioning and security material — when a question is about the organization; an answer that uses the results must name the sources it drew on.";
