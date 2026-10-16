import { resolveGuestSafeProposalThemeTokens } from "@repo/database";
import {
	mapThemeAssets,
	type ProposalThemeTokens,
	THEME_TOKEN_SOURCES,
	type ThemeAssetUrl,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { signThemeAsset } from "../../lib/brand-logo-reads";
import { loadProposalClientDocument } from "../../lib/proposal-artifact-access";
import { requireProposalArtifactEnabled } from "../../lib/proposal-artifact-feature";

const themeTokenSourceSchema = z.enum(THEME_TOKEN_SOURCES);

function sourced<T extends z.ZodType>(value: T) {
	return z.object({ value, source: themeTokenSourceSchema });
}

/** A short-lived signed read; null when there is no asset or it is untrusted. */
const themeAssetUrlSchema = z.object({ url: z.string() }).nullable();

/**
 * The tokens as the live page receives them, field by field: every asset a
 * signed read, and nothing else. An object schema drops any key it does not
 * name, so a field added to the tokens later reaches the wire only when it
 * is added here too.
 */
const proposalThemeTokensSchema = z.object({
	proposer: z.object({
		name: sourced(z.string().nullable()),
		logo: sourced(themeAssetUrlSchema),
		/** `#rrggbb`. */
		primary: sourced(z.string()),
		/** `#rrggbb`, at most three. */
		accents: sourced(z.array(z.string())),
		surface: sourced(z.string()),
		ink: sourced(z.string()),
		fonts: z.object({
			display: sourced(z.string()),
			body: sourced(z.string()),
			mono: sourced(z.string()),
		}),
		hero: sourced(themeAssetUrlSchema),
	}),
	recipient: z.object({
		name: sourced(z.string().nullable()),
		logo: sourced(themeAssetUrlSchema),
		/** `#rrggbb`, at most three. */
		colors: sourced(z.array(z.string())),
	}),
}) satisfies z.ZodType<ProposalThemeTokens<ThemeAssetUrl>>;

/**
 * The brand tokens of a Proposal in artifact mode (Fizzy #2946): the colours,
 * names and logos its live page and exports wear. Members and project guests
 * read the same tokens, since the document is written for the client.
 *
 * Only what a guest may see is read: the Style's colours, the Brand kit's
 * accents, the recipient brand and the organization's name and logo. The
 * style direction and the Brand kit guidance stay with the members' Style
 * tab and are never selected here. Logos are signed after their keys are
 * checked again; one that fails the check, or cannot be signed, is null.
 * A read, so no audit row.
 *
 * AUTHORIZATION: `requireProposalArtifactEnabled` first (gate off → NOT_FOUND
 * for every caller), then `requireProjectPermission(DOCUMENT_READ)`, then
 * `loadProposalClientDocument` (document in project, project access, a
 * Proposal with the gate on for the owning organization; NOT_FOUND for every
 * failure). No membership of the owning organization is required.
 */
export const getProposalThemeTokensProcedure = tenantProtectedProcedure
	.use(requireProposalArtifactEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/documents/{documentId}/proposal-artifact/theme-tokens",
		tags: ["Projects", "Proposal artifact"],
		summary: "Get the Proposal theme tokens",
		description:
			"The colours, names and signed logo reads a Proposal's live page and exports wear. Readable by anyone with access to the project.",
	})
	.input(z.object({ projectId: z.string(), documentId: z.string() }))
	.output(z.object({ tokens: proposalThemeTokensSchema }))
	.handler(async ({ input, context }) => {
		const { document, organizationId } = await loadProposalClientDocument({
			projectId: input.projectId,
			documentId: input.documentId,
			userId: context.user.id,
		});

		const tokens = await resolveGuestSafeProposalThemeTokens({
			organizationId,
			projectId: input.projectId,
			documentId: document.id,
		});
		return {
			tokens: await mapThemeAssets(tokens, (ref) =>
				signThemeAsset(ref, {
					organizationId,
					projectId: input.projectId,
				}),
			),
		};
	});
