import { z } from "zod";
import { frameRevisionSchema } from "./frame-edit-contract";

export const frameExportStartSchema = z.strictObject({
	expectedUpdatedAt: frameRevisionSchema,
	requestId: z.string().uuid(),
	orientation: z.enum(["portrait", "landscape"]).optional(),
});
export const frameShareSchema = z.strictObject({
	expectedUpdatedAt: frameRevisionSchema,
	scope: z.enum(["PRIVATE", "PUBLIC", "EMAILS_ONLY", "WORKSPACE_AND_EMAILS"]),
	emails: z.array(z.string().email()).max(50).optional(),
});
export const frameRevokeSharingSchema = z
	.strictObject({
		expectedUpdatedAt: frameRevisionSchema,
		mode: z.enum(["public-link", "invitation", "all"]),
		email: z.string().email().optional(),
	})
	.refine(
		(value) =>
			value.mode === "invitation"
				? Boolean(value.email)
				: value.email === undefined,
		{
			message:
				"Provide an email only when removing an individual invitation.",
		},
	);

/** Explicit sharing results may disclose a link; general reads never do. */
export function frameSharingMutationDto(result: {
	ok: true;
	scope: string;
	updatedAt: Date;
	shareToken?: string;
	invited?: string[];
	grants?: Array<{ id: string; email: string | null; invitedAt: Date }>;
	revokedInvitations?: number;
}) {
	return {
		ok: true as const,
		scope: result.scope,
		updatedAt: result.updatedAt.toISOString(),
		...(result.scope === "PUBLIC" && result.shareToken
			? { shareToken: result.shareToken }
			: {}),
		...(result.invited ? { invited: result.invited } : {}),
		...(result.grants
			? {
					grants: result.grants.map((g) => ({
						id: g.id,
						email: g.email,
						invitedAt: g.invitedAt.toISOString(),
					})),
				}
			: {}),
		...(result.revokedInvitations !== undefined
			? { revokedInvitations: result.revokedInvitations }
			: {}),
	};
}
