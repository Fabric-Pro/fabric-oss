import { z } from "zod";

/**
 * The automation-link fields accepted by create + update, shared so the two
 * inputs cannot drift apart.
 *
 * `automationExternalUrl` accepts "" alongside a real URL: the same field that
 * sets a link is the one a user clears it through, and a bare `.url()` would
 * reject the emptied value. Blank is collapsed to null by the query layer, which
 * also owns the rule that a non-empty ref implies AUTOMATED.
 *
 * The caps are input hygiene only — the columns themselves are unbounded TEXT.
 */

/**
 * Only http(s) may be stored. Zod's `.url()` defers to the URL parser, which
 * happily accepts `javascript:alert(1)` — and this value is rendered as an
 * `href`, so a permissive scheme here is a stored-XSS sink. The editor already
 * refuses non-http(s), but the client is not the boundary: any API caller
 * reaches this schema directly.
 */
const httpUrl = z
	.string()
	.url()
	.max(2000)
	.refine(
		(value) => {
			try {
				const { protocol } = new URL(value);
				return protocol === "http:" || protocol === "https:";
			} catch {
				return false;
			}
		},
		{ message: "Must be an http(s) URL" },
	);

export const automationInputFields = {
	automationRef: z.string().max(500).nullable().optional(),
	automationFilePath: z.string().max(1000).nullable().optional(),
	automationExternalUrl: z
		.union([z.literal(""), httpUrl])
		.nullable()
		.optional(),
} as const;
