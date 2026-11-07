/**
 * What Fabric tells a client about its frame tools: names, descriptions, input
 * schemas, annotations, the scope each needs and when a call needs the person's
 * yes. A Frame is a page the agent writes; the Fabric MCP gateway serves these
 * definitions, and both chat engines take them from it, so the Orchestrator and
 * Direct chat offer the same `surface`, `runtimeTools` and
 * `sharedWithOrganization` arguments. Pure data (see
 * `fabric-workflow-tool-definitions`), importable by the web app through
 * `@repo/temporal/fabric-frame-tool-definitions`.
 *
 * Writing a page asks nothing, with one exception: a call that sets
 * `runtimeTools` gives the page the power to call Fabric tools as whoever opens
 * it, so that call asks the person first, in both engines.
 */

import { FRAME_PRESENTATIONS } from "@repo/utils/frame-presentation";
import { defineFabricTools } from "./fabric-tool-definition";

const BLOCKS_SCHEMA = {
	type: "array",
	items: {
		type: "object",
		properties: {
			id: { type: "string" },
			type: {
				type: "string",
				enum: ["html", "json", "mermaid", "markdown"],
			},
			title: { type: "string" },
			content: { type: "string" },
		},
		required: ["id", "type", "content"],
	},
} as const;

const SURFACE_SCHEMA = {
	type: "string",
	enum: ["artifact", "workspace"],
} as const;

const PRESENTATION_SCHEMA = {
	type: "string",
	enum: [...FRAME_PRESENTATIONS],
	description:
		"DOCUMENT applies report typography and a saved brand cover. INTERFACE preserves authored layout; it does not grant script or tool access. Omitted on edits preserves the saved choice.",
} as const;

const RUNTIME_TOOLS_SCHEMA = {
	type: "array",
	items: { type: "string" },
	description:
		"Declared fabric.call tools, max 50. Discover schemas with fabric_list_page_tools; use fabric_list_features(projectId), never fabric_list_project_features. Writes ask the viewer.",
} as const;

const READ = { readOnlyHint: true } as const;

const WRITE = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
} as const;

const REWRITE = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
} as const;

const ASK_WHEN_GIVEN_TOOLS = { whenArgumentPresent: "runtimeTools" } as const;

/** Who may open a frame, from the widest to the narrowest the owner can choose. */
export const FRAME_SHARE_SCOPES = [
	"PUBLIC",
	"WORKSPACE_AND_EMAILS",
	"EMAILS_ONLY",
	"PRIVATE",
] as const;

export type FrameShareScopeName = (typeof FRAME_SHARE_SCOPES)[number];

export const FABRIC_FRAME_TOOL_DEFINITIONS = defineFabricTools([
	{
		name: "fabric_create_frame_draft",
		description:
			"Create a private page with a stable requestId. No tools or external sharing are granted.",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string" },
				description: { type: "string" },
				kind: { type: "string", enum: ["frame", "slideshow"] },
				presentation: {
					type: "string",
					enum: ["DOCUMENT", "INTERFACE"],
				},
				blocks: {
					type: "array",
					minItems: 1,
					maxItems: 100,
					items: {
						type: "object",
						properties: {
							id: { type: "string" },
							type: {
								type: "string",
								enum: ["html", "json", "mermaid", "markdown"],
							},
							title: { type: "string" },
							content: { type: "string" },
							language: { type: "string" },
						},
						required: ["id", "type", "content"],
						additionalProperties: false,
					},
				},
				theme: {
					type: "object",
					properties: {
						mode: {
							type: "string",
							enum: ["light", "dark", "system"],
						},
						accentColor: { type: "string" },
					},
					additionalProperties: false,
				},
				requestId: { type: "string" },
				projectId: { type: "string" },
				conversationId: { type: "string" },
			},
			required: ["title", "blocks", "requestId"],
			additionalProperties: false,
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
		},
		scope: "frames:write",
	},
	{
		name: "fabric_validate_frame_document",
		description:
			"Check page structure and JSON syntax; does not execute code or verify facts.",
		inputSchema: {
			type: "object",
			properties: {
				document: {
					type: "object",
					properties: {
						title: { type: "string" },
						description: { type: "string" },
						kind: { type: "string", enum: ["frame", "slideshow"] },
						presentation: {
							type: "string",
							enum: ["DOCUMENT", "INTERFACE"],
						},
						blocks: {
							type: "array",
							minItems: 1,
							maxItems: 100,
							items: {
								type: "object",
								properties: {
									id: { type: "string" },
									type: {
										type: "string",
										enum: [
											"html",
											"json",
											"mermaid",
											"markdown",
										],
									},
									title: { type: "string" },
									content: { type: "string" },
									language: { type: "string" },
								},
								required: ["id", "type", "content"],
								additionalProperties: false,
							},
						},
						theme: {
							type: "object",
							properties: {
								mode: {
									type: "string",
									enum: ["light", "dark", "system"],
								},
								accentColor: { type: "string" },
							},
							additionalProperties: false,
						},
					},
					required: ["title", "blocks"],
					additionalProperties: false,
				},
			},
			required: ["document"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true },
		scope: "frames:read",
	},
	{
		name: "fabric_list_frame_templates",
		description: "List reusable page templates in the organization.",
		inputSchema: {
			type: "object",
			properties: {
				category: { type: "string" },
				includeSystem: { type: "boolean" },
			},
			required: [],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true },
		scope: "frames:read",
	},
	{
		name: "fabric_get_frame_template",
		description: "Read a template and its declared typed inputs.",
		inputSchema: {
			type: "object",
			properties: { templateId: { type: "string" } },
			required: ["templateId"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true },
		scope: "frames:read",
	},
	{
		name: "fabric_create_frame_template",
		description:
			"Create a reusable organization-wide template from an authored definition. Do not copy private/project content or branding into an organization template.",
		inputSchema: {
			type: "object",
			properties: {
				requestId: { type: "string" },
				name: { type: "string" },
				description: { type: "string" },
				category: { type: "string" },
				content: {
					type: "object",
					properties: {
						title: { type: "string" },
						description: { type: "string" },
						kind: { type: "string", enum: ["frame", "slideshow"] },
						presentation: {
							type: "string",
							enum: ["DOCUMENT", "INTERFACE"],
						},
						blocks: {
							type: "array",
							minItems: 1,
							maxItems: 100,
							items: {
								type: "object",
								properties: {
									id: { type: "string" },
									type: {
										type: "string",
										enum: [
											"html",
											"json",
											"mermaid",
											"markdown",
										],
									},
									title: { type: "string" },
									content: { type: "string" },
									language: { type: "string" },
								},
								required: ["id", "type", "content"],
								additionalProperties: false,
							},
						},
						theme: {
							type: "object",
							properties: {
								mode: {
									type: "string",
									enum: ["light", "dark", "system"],
								},
								accentColor: { type: "string" },
							},
							additionalProperties: false,
						},
					},
					required: ["title", "blocks"],
					additionalProperties: false,
				},
				variables: {
					type: "object",
					additionalProperties: {
						type: "object",
						properties: {
							type: {
								type: "string",
								enum: ["string", "number", "boolean", "select"],
							},
							label: { type: "string" },
							default: { type: ["string", "number", "boolean"] },
							required: { type: "boolean" },
							options: {
								type: "array",
								items: { type: "string" },
							},
						},
						required: ["type", "label"],
						additionalProperties: false,
					},
				},
				confirmOrganizationAudience: { type: "boolean", const: true },
			},
			required: [
				"requestId",
				"name",
				"category",
				"content",
				"confirmOrganizationAudience",
			],
			additionalProperties: false,
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
		},
		scope: "frames:write",
		confirm: "always",
	},
	{
		name: "fabric_create_frame_from_template",
		description:
			"Create a private page from a template; values support text, numbers and booleans.",
		inputSchema: {
			type: "object",
			properties: {
				requestId: { type: "string" },
				templateId: { type: "string" },
				variables: {
					type: "object",
					additionalProperties: {
						type: ["string", "number", "boolean"],
					},
				},
				title: { type: "string" },
				description: { type: "string" },
				projectId: { type: "string" },
				conversationId: { type: "string" },
			},
			required: ["requestId", "templateId"],
			additionalProperties: false,
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
		},
		scope: "frames:write",
	},
	{
		name: "fabric_propose_frame_change",
		description:
			"Propose content changes to a saved page using its current updatedAt and a stable requestId. This does not change the saved page. Show the review URL; the person reviews original, proposed and preview before applying. Prefer this for conversational edits.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
				requestId: { type: "string" },
				expectedUpdatedAt: { type: "string" },
				edit: {
					type: "object",
					properties: {
						title: { type: "string" },
						description: { type: "string" },
						presentation: {
							type: "string",
							enum: ["DOCUMENT", "INTERFACE"],
						},
						blocks: {
							type: "array",
							minItems: 1,
							maxItems: 100,
							items: {
								type: "object",
								properties: {
									id: { type: "string" },
									type: {
										type: "string",
										enum: [
											"html",
											"json",
											"mermaid",
											"markdown",
										],
									},
									title: { type: "string" },
									content: { type: "string" },
									language: { type: "string" },
								},
								required: ["id", "type", "content"],
								additionalProperties: false,
							},
						},
						theme: {
							type: "object",
							properties: {
								mode: {
									type: "string",
									enum: ["light", "dark", "system"],
								},
								accentColor: { type: "string" },
							},
							additionalProperties: false,
						},
					},
					additionalProperties: false,
				},
			},
			required: ["frameId", "requestId", "expectedUpdatedAt", "edit"],
			additionalProperties: false,
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
		},
		scope: "frames:write",
	},
	{
		name: "fabric_list_frame_changes",
		description: "List bounded change reviews for a page.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
				limit: { type: "integer", minimum: 1, maximum: 50 },
				offset: { type: "integer", minimum: 0 },
			},
			required: ["frameId"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true },
		scope: "frames:read",
	},
	{
		name: "fabric_get_frame_change",
		description:
			"Read the complete original and proposed page change. Conflict means the saved page has changed; never blindly reapply.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
				proposalId: { type: "string" },
			},
			required: ["frameId", "proposalId"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true },
		scope: "frames:read",
	},
	{
		name: "fabric_apply_frame_change",
		description:
			"Apply the exact proposal hash the person reviewed. Asks confirmation; a conflict preserves the proposal and never overwrites newer work.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
				proposalId: { type: "string" },
				expectedProposalHash: { type: "string" },
			},
			required: ["frameId", "proposalId", "expectedProposalHash"],
			additionalProperties: false,
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
		},
		scope: "frames:write",
		confirm: "always",
	},
	{
		name: "fabric_dismiss_frame_change",
		description:
			"Dismiss a pending page change; it cannot subsequently be applied.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
				proposalId: { type: "string" },
			},
			required: ["frameId", "proposalId"],
			additionalProperties: false,
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
		},
		scope: "frames:write",
		confirm: "always",
	},
	{
		name: "fabric_get_frame_review",
		description: "Read draft, approved and published revision status.",
		inputSchema: {
			type: "object",
			properties: { frameId: { type: "string" } },
			required: ["frameId"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true },
		scope: "frames:read",
	},
	{
		name: "fabric_approve_frame_revision",
		description:
			"Approve the exact saved draft hash after review. Approval never makes the page public.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
				expectedUpdatedAt: { type: "string" },
				expectedContentHash: { type: "string" },
			},
			required: ["frameId", "expectedUpdatedAt", "expectedContentHash"],
			additionalProperties: false,
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
		},
		scope: "frames:write",
		confirm: "always",
	},
	{
		name: "fabric_get_frame_branding",
		description:
			"Review a Frame's saved company/client brand choices and current formatting snapshot.",
		inputSchema: {
			type: "object",
			properties: { frameId: { type: "string" } },
			required: ["frameId"],
		},
		annotations: READ,
		scope: "frames:read",
	},
	{
		name: "fabric_apply_frame_branding",
		description:
			"Apply reviewed saved branding to a private Frame revision. Read its branding choices first. No private logos or uploaded fonts are copied.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
				expectedUpdatedAt: { type: "string", format: "date-time" },
				source: { type: "string", enum: ["COMPANY", "CLIENT"] },
				expectedBrandVersion: { type: "integer", minimum: 0 },
			},
			required: [
				"frameId",
				"expectedUpdatedAt",
				"source",
				"expectedBrandVersion",
			],
		},
		annotations: WRITE,
		scope: "frames:write",
		confirm: "always",
	},
	{
		name: "fabric_get_report_branding",
		description:
			"Review saved company/client brand choices before selecting a report's branding source and saved version.",
		inputSchema: {
			type: "object",
			properties: { projectId: { type: "string" } },
		},
		annotations: READ,
		scope: "reports:read",
	},

	{
		name: "fabric_get_report_instance_branding",
		description:
			"Read the saved report's exact audience, current branding and instance version/timestamp before changing branding.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { instanceId: { type: "string", minLength: 1 } },
			required: ["instanceId"],
		},
		annotations: READ,
		scope: "reports:read",
	},
	{
		name: "fabric_apply_report_branding",
		description:
			"Save reviewed branding on an existing configured report only. Get its current instance/brand versions first. branding:null removes branding. Keeps audience, period, schedule and generator settings unchanged. Does not run or publish the report.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				instanceId: { type: "string", minLength: 1 },
				expectedInstanceVersion: { type: "integer", minimum: 1 },
				expectedUpdatedAt: { type: "string", format: "date-time" },
				branding: {
					anyOf: [
						{ type: "null" },
						{
							type: "object",
							additionalProperties: false,
							properties: {
								source: {
									type: "string",
									enum: ["COMPANY", "CLIENT"],
								},
								expectedBrandVersion: {
									type: "integer",
									minimum: 0,
								},
							},
							required: ["source", "expectedBrandVersion"],
						},
					],
				},
			},
			required: [
				"instanceId",
				"expectedInstanceVersion",
				"expectedUpdatedAt",
				"branding",
			],
		},
		annotations: WRITE,
		scope: "reports:write",
		confirm: "always",
	},

	{
		name: "fabric_create_frame",
		description:
			"Creates html/json/mermaid/markdown blocks only when asked (chat renders ```mermaid). surface=artifact: current/projectId; workspace: organization Pages. Html: inline <style>, light/dark, tiles/cards/tables/SVG; no network. Scripts act as viewer: window.fabric.call(tool, args)->Promise, fabric.openAgent(prompt), fabric.navigate('/app/...'). Discover fabric_list_page_tools; declare runtimeTools. PRIVATE: owner-only outside projects, linked project members retain access. Artifact/Pages grant project/org access; shareOnCreate adds an allowed public link.",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string" },
				description: {
					type: "string",
					description: "Shown below the title",
				},
				blocks: { ...BLOCKS_SCHEMA, description: "Content blocks" },
				surface: SURFACE_SCHEMA,
				presentation: PRESENTATION_SCHEMA,
				projectId: { type: "string" },
				runtimeTools: RUNTIME_TOOLS_SCHEMA,
				sharedWithOrganization: { type: "boolean", default: true },
				kind: {
					type: "string",
					enum: ["frame", "slideshow"],
					default: "frame",
				},
				shareOnCreate: { type: "boolean" },
			},
			required: ["title"],
		},
		annotations: WRITE,
		scope: "frames:write",
		confirm: ASK_WHEN_GIVEN_TOOLS,
	},
	{
		name: "fabric_update_frame",
		description:
			"Edits title/description/blocks/runtimeTools; omitted fields stay. Text edits: fabric_edit_frame_block. frameId defaults to open Page. Runtime: fabric_create_frame.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
				expectedUpdatedAt: {
					type: "string",
					description:
						"Revision from fabric_get_frame; re-read after conflicts.",
				},
				title: { type: "string" },
				description: { type: "string" },
				blocks: { ...BLOCKS_SCHEMA, description: "Replacement blocks" },
				surface: SURFACE_SCHEMA,
				presentation: PRESENTATION_SCHEMA,
				runtimeTools: RUNTIME_TOOLS_SCHEMA,
			},
			required: ["expectedUpdatedAt"],
		},
		annotations: REWRITE,
		scope: "frames:write",
		confirm: ASK_WHEN_GIVEN_TOOLS,
	},
	{
		name: "fabric_edit_frame_block",
		description:
			"Replaces saved block text. Read fabric_get_frame outline:true then source window. oldText must match once unless replaceAll. Send latest read/edit updatedAt as expectedUpdatedAt; conflicts require re-read.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string", minLength: 1 },
				blockId: { type: "string", minLength: 1 },
				edits: {
					type: "array",
					minItems: 1,
					maxItems: 20,
					items: {
						type: "object",
						properties: {
							oldText: { type: "string", minLength: 1 },
							newText: { type: "string" },
							replaceAll: { type: "boolean" },
						},
						required: ["oldText", "newText"],
					},
				},
				expectedUpdatedAt: { type: "string", format: "date-time" },
			},
			required: ["frameId", "blockId", "edits"],
		},
		annotations: REWRITE,
		scope: "frames:write",
		confirm: ASK_WHEN_GIVEN_TOOLS,
	},
	{
		name: "fabric_get_frame",
		description:
			"Reads blocks/surface/tools/share URL; default open Page. outline:true: ids/types/sizes only. Edit: read blockId offset:0,limit:6000, follow nextOffset, restart if updatedAt changes, then fabric_edit_frame_block. Never edit summaries.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
				outline: { type: "boolean" },
				blockId: { type: "string", minLength: 1 },
				offset: { type: "integer", minimum: 0 },
				limit: { type: "integer", minimum: 1, maximum: 6_000 },
			},
		},
		annotations: READ,
		scope: "frames:read",
	},
	{
		name: "fabric_list_frames",
		description:
			"Lists yours; surface=workspace lists accessible organization Workspaces; artifact+projectId lists project artifacts.",
		inputSchema: {
			type: "object",
			properties: {
				surface: SURFACE_SCHEMA,
				projectId: { type: "string" },
				conversationId: {
					type: "string",
					description: "Only pages created in this conversation.",
				},
				limit: { type: "integer", minimum: 1, maximum: 200 },
				offset: { type: "integer", minimum: 0 },
			},
		},
		annotations: READ,
		scope: "frames:read",
	},
	{
		name: "fabric_share_frame",
		description:
			"Change sharing after reviewing the current revision: PUBLIC if allowed, PRIVATE removes all explicit sharing, EMAILS_ONLY or WORKSPACE_AND_EMAILS grants the named recipients access. Does not send email.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
				scope: { type: "string", enum: [...FRAME_SHARE_SCOPES] },
				expectedUpdatedAt: { type: "string", format: "date-time" },
				emails: { type: "array", items: { type: "string" } },
			},
			required: ["frameId", "scope", "expectedUpdatedAt"],
		},
		annotations: WRITE,
		scope: "frames:write",
		confirm: "always",
	},
	{
		name: "fabric_get_frame_sharing",
		description:
			"Inspect the owned page's current sharing, invitation metadata and revision without revealing a public link credential.",
		inputSchema: {
			type: "object",
			properties: { frameId: { type: "string" } },
			required: ["frameId"],
		},
		annotations: READ,
		scope: "frames:read",
	},
	{
		name: "fabric_revoke_frame_sharing",
		description:
			"Remove the public link, one invitation, or all explicit sharing. Requires the reviewed revision. Project access remains governed by the project.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
				expectedUpdatedAt: { type: "string", format: "date-time" },
				mode: {
					type: "string",
					enum: ["public-link", "invitation", "all"],
				},
				email: { type: "string", format: "email" },
			},
			required: ["frameId", "expectedUpdatedAt", "mode"],
		},
		annotations: WRITE,
		scope: "frames:write",
		confirm: "always",
	},
	{
		name: "fabric_start_frame_export",
		description:
			"Start a durable PDF export of the reviewed page revision. Keep requestId (UUID) unchanged when recovering a lost response; inspect the returned exportId for progress.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
				expectedUpdatedAt: { type: "string", format: "date-time" },
				requestId: { type: "string", format: "uuid" },
				orientation: {
					type: "string",
					enum: ["portrait", "landscape"],
				},
			},
			required: ["frameId", "expectedUpdatedAt", "requestId"],
		},
		annotations: { ...WRITE, idempotentHint: true },
		scope: "frames:write",
		confirm: "always",
	},
	{
		name: "fabric_get_frame_export",
		description:
			"Inspect a page export's progress and expiry. Returns no download credential.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
				exportId: { type: "string" },
			},
			required: ["frameId", "exportId"],
		},
		annotations: READ,
		scope: "frames:read",
	},
	{
		name: "fabric_cancel_frame_export",
		description:
			"Request cancellation of your page export and cleanup of its retained result. Inspect status to confirm cancellation.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
				exportId: { type: "string" },
			},
			required: ["frameId", "exportId"],
		},
		annotations: { ...WRITE, idempotentHint: true },
		scope: "frames:write",
		confirm: "always",
	},
	{
		name: "fabric_download_frame_export",
		description:
			"Explicitly request a short-lived PDF download link after rechecking the export actor, current page access and reviewed revision.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
				exportId: { type: "string" },
			},
			required: ["frameId", "exportId"],
		},
		annotations: READ,
		scope: "frames:read",
	},

	{
		name: "fabric_create_slideshow",
		description:
			"Creates a Slideshow: one slide per component. Private; shareOnCreate=true adds a public link if allowed.",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string" },
				description: { type: "string" },
				components: {
					...BLOCKS_SCHEMA,
					description: "One entry per slide",
				},
				format: {
					type: "string",
					enum: ["html", "json", "mermaid", "markdown"],
					default: "html",
				},
				shareOnCreate: { type: "boolean" },
			},
			required: ["title"],
		},
		annotations: WRITE,
		scope: "frames:write",
	},
]);

export type FabricFrameToolName =
	(typeof FABRIC_FRAME_TOOL_DEFINITIONS)[number]["name"];

/** Runtime reviews stay on a signed grant's project; organization authoring/catalog operations do not. */
export const FRAME_REVIEW_TOOL_NAMES: ReadonlySet<string> = new Set([
	"fabric_propose_frame_change",
	"fabric_list_frame_changes",
	"fabric_get_frame_change",
	"fabric_apply_frame_change",
	"fabric_dismiss_frame_change",
	"fabric_get_frame_review",
	"fabric_approve_frame_revision",
]);
export const FRAME_ORGANIZATION_AUTHORING_TOOL_NAMES: ReadonlySet<string> =
	new Set([
		"fabric_create_frame_draft",
		"fabric_validate_frame_document",
		"fabric_list_frame_templates",
		"fabric_get_frame_template",
		"fabric_create_frame_template",
		"fabric_create_frame_from_template",
	]);
