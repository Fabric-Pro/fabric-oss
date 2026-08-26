/**
 * Create Kanban Token Procedure
 *
 * Creates a short-lived signed token for authenticating with fabric-kanban CLI.
 * The token is passed via URL/query params to enable deep-linking into kanban
 * without relying on process-local in-memory state.
 */

import { ORPCError } from "@orpc/client";
import { db, hasProjectAccess } from "@repo/database";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import {
	Permissions,
	publicProcedure,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const KANBAN_TOKEN_ISSUER = "fabric-kanban-launch";
const KANBAN_TOKEN_AUDIENCE = "fabric-kanban-runtime";
const KANBAN_TOKEN_TTL_SECONDS = 5 * 60;

const kanbanLaunchTokenClaimsSchema = z.object({
	sub: z.string(),
	organizationId: z.string().nullable().optional(),
	projectId: z.string(),
	projectName: z.string(),
	repositoryUrl: z.string().nullable().optional(),
	repositoryName: z.string().nullable().optional(),
	localRepoPath: z.string().nullable().optional(),
	storyId: z.string().optional(),
	storyTitle: z.string().optional(),
	storyIdentifier: z.string().optional(),
});

type KanbanLaunchTokenClaims = z.infer<typeof kanbanLaunchTokenClaimsSchema>;

function getKanbanLaunchTokenSecret(): Uint8Array {
	const secret =
		process.env.KANBAN_TOKEN_SECRET ||
		process.env.BETTER_AUTH_SECRET ||
		process.env.AUTH_SECRET;
	if (!secret) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message:
				"Kanban launch token secret is not configured (set KANBAN_TOKEN_SECRET, BETTER_AUTH_SECRET, or AUTH_SECRET)",
		});
	}
	return new TextEncoder().encode(secret);
}

async function signKanbanLaunchToken(
	claims: KanbanLaunchTokenClaims,
): Promise<string> {
	return await new SignJWT({
		organizationId: claims.organizationId ?? null,
		projectId: claims.projectId,
		projectName: claims.projectName,
		repositoryUrl: claims.repositoryUrl ?? null,
		repositoryName: claims.repositoryName ?? null,
		localRepoPath: claims.localRepoPath ?? null,
		storyId: claims.storyId,
		storyTitle: claims.storyTitle,
		storyIdentifier: claims.storyIdentifier,
	})
		.setProtectedHeader({ alg: "HS256" })
		.setIssuer(KANBAN_TOKEN_ISSUER)
		.setAudience(KANBAN_TOKEN_AUDIENCE)
		.setSubject(claims.sub)
		.setIssuedAt()
		.setExpirationTime(`${KANBAN_TOKEN_TTL_SECONDS}s`)
		.sign(getKanbanLaunchTokenSecret());
}

export async function verifyKanbanLaunchToken(
	token: string,
): Promise<KanbanLaunchTokenClaims> {
	try {
		const { payload } = await jwtVerify(
			token,
			getKanbanLaunchTokenSecret(),
			{
				issuer: KANBAN_TOKEN_ISSUER,
				audience: KANBAN_TOKEN_AUDIENCE,
				algorithms: ["HS256"],
			},
		);
		return kanbanLaunchTokenClaimsSchema.parse({
			sub: payload.sub,
			organizationId:
				typeof payload.organizationId === "string"
					? payload.organizationId
					: payload.organizationId === null
						? null
						: undefined,
			projectId: payload.projectId,
			projectName: payload.projectName,
			repositoryUrl:
				typeof payload.repositoryUrl === "string"
					? payload.repositoryUrl
					: payload.repositoryUrl === null
						? null
						: undefined,
			repositoryName:
				typeof payload.repositoryName === "string"
					? payload.repositoryName
					: payload.repositoryName === null
						? null
						: undefined,
			localRepoPath:
				typeof payload.localRepoPath === "string"
					? payload.localRepoPath
					: payload.localRepoPath === null
						? null
						: undefined,
			storyId:
				typeof payload.storyId === "string"
					? payload.storyId
					: undefined,
			storyTitle:
				typeof payload.storyTitle === "string"
					? payload.storyTitle
					: undefined,
			storyIdentifier:
				typeof payload.storyIdentifier === "string"
					? payload.storyIdentifier
					: undefined,
		});
	} catch {
		throw new ORPCError("NOT_FOUND", {
			message: "Invalid or expired token",
		});
	}
}

export const createKanbanTokenProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.STORY_CREATE))
	.route({
		method: "POST",
		path: "/kanban/token",
		tags: ["Kanban"],
		summary: "Create a short-lived token for fabric-kanban CLI",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string().optional(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			token: z.string(),
			kanbanUrl: z.string(),
			expiresIn: z.number(),
			projectName: z.string(),
			repositoryUrl: z.string().nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const canView = await hasProjectAccess(input.projectId, user.id);
		if (!canView) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have permission to view this project",
			});
		}

		const project = await db.project.findFirst({
			where: { id: input.projectId },
			select: {
				id: true,
				name: true,
				repositoryUrl: true,
				repositoryOwner: true,
				repositoryName: true,
				implementationDefaultWorkingDirectory: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		const preference = await db.projectUserPreference.findUnique({
			where: {
				projectId_userId: {
					projectId: input.projectId,
					userId: user.id,
				},
			},
			select: {
				kanbanLocalRepoPath: true,
			},
		});
		const localRepoPath =
			preference?.kanbanLocalRepoPath ??
			project.implementationDefaultWorkingDirectory ??
			null;

		let storyTitle: string | undefined;
		let storyIdentifier: string | undefined;
		if (input.storyId) {
			const story = await db.userStory.findFirst({
				where: { id: input.storyId, projectId: input.projectId },
				select: { title: true, identifier: true },
			});
			storyTitle = story?.title ?? undefined;
			storyIdentifier = story?.identifier ?? undefined;
		}

		const token = await signKanbanLaunchToken({
			sub: user.id,
			organizationId: organizationId ?? null,
			projectId: input.projectId,
			projectName: project.name,
			repositoryUrl: project.repositoryUrl,
			repositoryName: project.repositoryName,
			localRepoPath,
			storyId: input.storyId,
			storyTitle,
			storyIdentifier,
		});

		return {
			token,
			kanbanUrl: "http://localhost:3484",
			expiresIn: KANBAN_TOKEN_TTL_SECONDS * 1000,
			projectName: project.name,
			repositoryUrl: project.repositoryUrl,
		};
	});

/**
 * Exchange token for launch context.
 * Called by fabric-kanban when it receives a token via URL/query params.
 * This does not provide the long-lived Fabric API key used by runtime settings.
 */
export const exchangeKanbanTokenProcedure = publicProcedure
	.use(requirePermission(Permissions.STORY_CREATE))
	.route({
		method: "POST",
		path: "/kanban/token/exchange",
		tags: ["Kanban"],
		summary: "Exchange a short-lived token for launch context",
	})
	.input(
		z.object({
			token: z.string(),
		}),
	)
	.output(
		z.object({
			apiKey: z.string(),
			projectId: z.string(),
			projectName: z.string(),
			repositoryUrl: z.string().nullable(),
			repositoryName: z.string().nullable(),
			localRepoPath: z.string().nullable(),
			storyId: z.string().optional(),
			storyTitle: z.string().optional(),
			storyIdentifier: z.string().optional(),
			organizationId: z.string().nullable(),
			userId: z.string(),
		}),
	)
	.handler(async ({ input }) => {
		const tokenData = await verifyKanbanLaunchToken(input.token);

		return {
			// Return the JWT itself as the apiKey so the CLI can use it
			// to authenticate queue API calls without needing a separate long-lived key.
			apiKey: input.token,
			projectId: tokenData.projectId,
			projectName: tokenData.projectName,
			repositoryUrl: tokenData.repositoryUrl ?? null,
			repositoryName: tokenData.repositoryName ?? null,
			localRepoPath: tokenData.localRepoPath ?? null,
			storyId: tokenData.storyId,
			storyTitle: tokenData.storyTitle,
			storyIdentifier: tokenData.storyIdentifier,
			organizationId: tokenData.organizationId ?? null,
			userId: tokenData.sub,
		};
	});
