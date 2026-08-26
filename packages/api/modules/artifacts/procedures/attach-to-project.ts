/**
 * Attach Chat Artifact To Project
 *
 * Optionally indexes the artifact content into project knowledge so it becomes
 * searchable through project RAG.
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
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const attachToProjectProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.input(
		z.object({
			id: z.string(),
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			indexInProjectKnowledge: z.boolean().default(true),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

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
			organizationId: organizationId ?? undefined,
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
			organizationId: organizationId ?? undefined,
		});

		const embedResult = await embedProjectContext({
			contextId: projectContext.id,
			projectId: input.projectId,
			userId: context.user.id,
			organizationId: organizationId ?? undefined,
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
