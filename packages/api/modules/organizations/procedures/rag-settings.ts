/**
 * Organization RAG Settings Procedures
 *
 * API procedures for managing organization-level RAG settings.
 * These settings serve as defaults for all workspaces in the organization.
 */

import { ORPCError } from "@orpc/server";
import {
	getOrCreateOrganizationRagSettings,
	updateOrganizationRagSettings,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	requireOrgMembership,
	verifyOrganizationMembership,
} from "../lib/membership";

/**
 * Get RAG settings for an organization
 *
 * AUTHORIZATION: Requires organization membership
 */
export const getOrganizationRagSettingsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_READ))
	.route({
		method: "GET",
		path: "/organizations/{organizationId}/rag-settings",
		tags: ["Organizations"],
		summary: "Get organization RAG settings",
		description: "Get default RAG settings for an organization",
	})
	.input(
		z.object({
			organizationId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { organizationId } = input;

		// Verify user is organization member
		const membership = await verifyOrganizationMembership(
			organizationId,
			context.user.id,
		);
		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You are not a member of this organization",
			});
		}

		const settings =
			await getOrCreateOrganizationRagSettings(organizationId);

		return {
			settings: {
				chunkSize: settings.chunkSize,
				chunkOverlap: settings.chunkOverlap,
				splitMethod: settings.splitMethod,
				embeddingModel: settings.embeddingModel,
				topK: settings.topK,
				similarityThreshold: settings.similarityThreshold,
				enableReranking: settings.enableReranking,
			},
		};
	});

/**
 * Update RAG settings for an organization
 *
 * AUTHORIZATION: Requires organization admin or owner role
 */
export const updateOrganizationRagSettingsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_UPDATE))
	.route({
		method: "PUT",
		path: "/organizations/{organizationId}/rag-settings",
		tags: ["Organizations"],
		summary: "Update organization RAG settings",
		description: "Update default RAG settings for an organization",
	})
	.input(
		z.object({
			organizationId: z.string(),
			chunkSize: z.number().min(100).max(10000).nullable().optional(),
			chunkOverlap: z.number().min(0).max(2000).nullable().optional(),
			splitMethod: z
				.enum([
					"PARAGRAPH",
					"SENTENCE",
					"FIXED",
					"RECURSIVE",
					"DOCUMENT",
					"SEMANTIC",
				])
				.nullable()
				.optional(),
			embeddingModel: z
				.enum(["TEXT_EMBEDDING_3_SMALL", "TEXT_EMBEDDING_3_LARGE"])
				.nullable()
				.optional(),
			topK: z.number().min(1).max(50).nullable().optional(),
			similarityThreshold: z.number().min(0).max(1).nullable().optional(),
			enableReranking: z.boolean().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { organizationId, ...data } = input;

		// Verify user is organization admin or owner
		const membership = await requireOrgMembership(
			context.user.id,
			organizationId,
			["admin", "owner"],
		);
		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You must be an admin or owner of this organization",
			});
		}

		const settings = await updateOrganizationRagSettings(
			organizationId,
			context.user.id,
			data,
		);

		// Audit-log emission. RAG defaults are organization-level
		// settings, so they map to `org.settings.updated`. Metadata records
		// the changed keys without leaking values that vary per tenant
		// (chunkSize ranges, embedding model names, etc are non-sensitive).
		const changedFields = Object.entries(data)
			.filter(([_, value]) => value !== undefined)
			.map(([key]) => key);
		recordAuditFromRequest(context, {
			action: "org.settings.updated",
			category: "org",
			organizationId,
			resource: {
				type: "organization",
				id: organizationId,
				name: null,
			},
			metadata: {
				setting: "rag_defaults",
				changedFields,
			},
		});

		return {
			success: true,
			settings: {
				chunkSize: settings.chunkSize,
				chunkOverlap: settings.chunkOverlap,
				splitMethod: settings.splitMethod,
				embeddingModel: settings.embeddingModel,
				topK: settings.topK,
				similarityThreshold: settings.similarityThreshold,
				enableReranking: settings.enableReranking,
			},
		};
	});
