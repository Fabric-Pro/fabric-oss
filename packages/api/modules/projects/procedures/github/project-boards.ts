/**
 * GitHub Projects (v2) board picker.
 *
 * Lists the boards the caller's own GitHub connection can reach and reads
 * one board's Status options and linked repositories, so Project Settings
 * can pick the PM container (the board), the repository new issues go to,
 * and map the Status options to Fabric statuses. Always the caller's
 * connection in the resolved tenant — never a teammate's or a project grant.
 */
import { ORPCError } from "@orpc/server";
import {
	gitHubProjectsCredentialMessage,
	resolveGitHubProjectsCredential,
} from "@repo/integrations/github/projects-credential";
import {
	getGitHubProjectBoard,
	githubStatusLabels,
	githubTokenReadsPersonalBoards,
	listGitHubIssueTypes,
	listGitHubProjectBoards,
} from "@repo/integrations/github/projects-pm-adapter";
import { z } from "zod";
import {
	Permissions,
	requireOrganizationMembership,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { rethrowGitHubProjectsError } from "../../lib/github-projects-pm-source";

const boardSchema = z.object({
	id: z.string(),
	number: z.number(),
	title: z.string(),
	url: z.string(),
	ownerLogin: z.string(),
	ownerType: z.enum(["Organization", "User"]),
	closed: z.boolean(),
});

async function requireToken(
	userId: string,
	organizationId: string | null | undefined,
	credentialId?: string | null,
): Promise<string> {
	// The organization comes from the caller: a credential shared in it is
	// read only for its members.
	if (organizationId) {
		await requireOrganizationMembership(organizationId, userId);
	}
	// The saved credential the settings chose, else the caller's GitHub
	// connection.
	const credential = await resolveGitHubProjectsCredential(
		userId,
		organizationId,
		credentialId,
	);
	if (!credential.ok) {
		throw new ORPCError("BAD_REQUEST", {
			message: gitHubProjectsCredentialMessage(credential.reason),
		});
	}
	return credential.token;
}

export const listGitHubProjectBoardsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.INTEGRATION_READ))
	.route({
		method: "GET",
		path: "/projects/github/project-boards",
		tags: ["Projects", "GitHub"],
		summary: "List GitHub Projects boards the caller can reach",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			/** A saved credential to list with, instead of the connection. */
			credentialId: z.string().min(1).nullable().optional(),
		}),
	)
	.output(
		z.object({
			boards: z.array(boardSchema),
			/** False: the token cannot see a personal account's boards. */
			readsPersonalBoards: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const token = await requireToken(
			context.user.id,
			organizationId,
			input.credentialId,
		);
		try {
			return {
				boards: await listGitHubProjectBoards(token),
				readsPersonalBoards: githubTokenReadsPersonalBoards(token),
			};
		} catch (error) {
			return rethrowGitHubProjectsError(error);
		}
	});

export const getGitHubProjectBoardProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.INTEGRATION_READ))
	.route({
		method: "GET",
		path: "/projects/github/project-boards/{boardId}",
		tags: ["Projects", "GitHub"],
		summary:
			"Read a GitHub Projects board's Status options and repositories",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			credentialId: z.string().min(1).nullable().optional(),
			boardId: z.string().min(1),
			/** `owner/name`: also return the Issue Types new issues can use. */
			repository: z
				.string()
				.regex(/^[^/\s]+\/[^/\s]+$/)
				.optional(),
		}),
	)
	.output(
		z.object({
			board: boardSchema,
			statusOptions: z.array(
				z.object({ label: z.string(), optionName: z.string() }),
			),
			repositories: z.array(z.string()),
			issueTypes: z.array(z.string()),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const token = await requireToken(
			context.user.id,
			organizationId,
			input.credentialId,
		);
		try {
			const board = await getGitHubProjectBoard(token, input.boardId);
			const issueTypes = input.repository
				? (await listGitHubIssueTypes(token, input.repository)).map(
						(t) => t.name,
					)
				: [];
			const { id, number, title, url, ownerLogin, ownerType, closed } =
				board;
			return {
				board: {
					id,
					number,
					title,
					url,
					ownerLogin,
					ownerType,
					closed,
				},
				statusOptions: githubStatusLabels(board),
				repositories: board.repositories,
				issueTypes,
			};
		} catch (error) {
			return rethrowGitHubProjectsError(error);
		}
	});
