/** Model-facing definition shared by Advisor pre-registration and Fabric tool discovery. */
export const PROJECT_CREATE_STORY_TOOL = {
	description:
		"Create a feature or bug in the Fabric project bound to this agent. " +
		"Use this when a user asks to add, file, log, open, or create a feature, bug, " +
		"story, or work item. The story is drafted automatically by the project's " +
		"bound prompt — you do NOT need to write the description or acceptance " +
		"criteria yourself. Pass the user's raw request verbatim as `request`. A short " +
		"working `title` is optional — if absent, one will be generated automatically " +
		"from `request`. When `title` is omitted, the server uses `request` as both " +
		"the description AND as `origin_context` for the title generator. " +
		"The system classifies the request as BUG or FEATURE automatically using an " +
		"AI classifier — you do NOT need to set `kind`. If you have strong context, " +
		"you may pass a `kind` hint; the classifier will override it when warranted. " +
		"Optional reporter fields (`reporterSource`, `reporterSourceUrl`, " +
		"`reporterName`) let you attribute the work item to its origin (a Slack " +
		"thread, Teams message, etc.) — pass them when you have that context. " +
		"KEYWORDS: create feature, file bug, log bug, add feature, open ticket, " +
		"create story, new feature, new bug, report bug, add to backlog.",
	inputSchema: {
		type: "object",
		properties: {
			kind: {
				type: "string",
				enum: ["FEATURE", "BUG", "INITIATIVE"],
				description:
					"Optional hint. The system may reclassify FEATURE/BUG; INITIATIVE is kept as is.",
			},
			title: {
				type: "string",
				description:
					"Optional short working title (≤120 chars). If omitted, generated server-side from `request`.",
			},
			request: {
				type: "string",
				description:
					"The user's raw request, verbatim. Becomes the drafting context.",
			},
			priority: {
				type: "string",
				enum: ["P0_CRITICAL", "P1_HIGH", "P2_MEDIUM", "P3_LOW"],
				default: "P2_MEDIUM",
				description: "Story priority. Default P2_MEDIUM.",
			},
			size: {
				type: "string",
				enum: ["XS", "S", "M", "L", "XL"],
				description: "T-shirt size estimate. Optional; omit if unsure.",
			},
			reporterSource: {
				type: "string",
				enum: ["SLACK", "TEAMS", "MANUAL"],
				description:
					"Origin of this report. Set SLACK / TEAMS when invoked from those channels; defaults to MANUAL.",
			},
			reporterSourceUrl: {
				type: "string",
				description:
					"Permalink to the originating message/thread (e.g. Slack thread URL, Teams message URL).",
			},
			reporterName: {
				type: "string",
				description:
					"Display name of the user who reported this. Falls back to the agent owner when omitted.",
			},
		},
		required: ["request"],
	},
};
