/**
 * Attach Chat Artifact To Project
 *
 * Optionally indexes the artifact content into project knowledge so it becomes
 * searchable through project RAG.
 *
 * TENANT: `requireProjectPermission(PROJECT_UPDATE)` authorizes the target
 * project, and every tenant use below (the artifact lookup, the attach, the
 * RAG provider that embeds it, the new project context) takes that project's
 * organization — never `input.organizationId`, which is the caller's own
 * string and could name an organization they have no tie to. An artifact from
 * another organization is therefore not found here, and a project with no
 * organization is refused (ADR-018).
 */

import { ORPCError } from "@orpc/server";
import { getRAGProviderConfig } from "@repo/ai";
import {
	attachArtifactToProject,
	createContext,
	getChatArtifact,
	markArtifactIndexed,
} from "@repo/database";
import { embedProjectContext } from "@repo/rag";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { loadProjectOrganizationId } from "../../projects/lib/project-organization";

export const attachToProjectProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.input(
		z.object({
			id: z.string(),
			projectId: z.string(),
			// Accepted for client compatibility and ignored: the tenant is the
			// project's own organization (see the handler).
			organizationId: z.string().nullable().optional(),
			indexInProjectKnowledge: z.boolean().default(true),
		}),
	)
	.handler(async ({ input, context }) => {
		// Refuses a missing project and one with no organization, before any
		// lookup, write or embedding.
		const organizationId = await loadProjectOrganizationId(input.projectId);

		const artifact = await getChatArtifact(
			input.id,
			context.user.id,
			organizationId,
		);
		if (!artifact) {
			throw new ORPCError("NOT_FOUND", {
				message: "Artifact not found",
			});
		}

		await attachArtifactToProject(
			artifact.id,
			input.projectId,
			context.user.id,
			organizationId,
		);

		if (
			!input.indexInProjectKnowledge ||
			artifact.indexedAt ||
			!artifact.content?.trim()
		) {
			return { success: true, indexed: Boolean(artifact.indexedAt) };
		}

		const providerConfig = await getRAGProviderConfig({
			userId: context.user.id,
			organizationId,
		});

		const projectContext = await createContext({
			projectId: input.projectId,
			type: "TEXT",
			content: artifact.content,
			metadata: {
				source: "chat-artifact",
				artifactId: artifact.id,
				artifactType: artifact.type,
				artifactTitle: artifact.title,
				description: artifact.description,
			},
			userId: context.user.id,
			organizationId,
		});

		const embedResult = await embedProjectContext({
			contextId: projectContext.id,
			projectId: input.projectId,
			userId: context.user.id,
			organizationId,
			content: artifact.content,
			type: "TEXT",
			apiKey: providerConfig,
			metadata: {
				sourceTitle: artifact.title,
			},
		});

		if (embedResult.success && embedResult.qdrantId) {
			await markArtifactIndexed(artifact.id, embedResult.qdrantId);
		}

		return {
			success: true,
			indexed: Boolean(embedResult.success),
			projectContextId: projectContext.id,
		};
	});
