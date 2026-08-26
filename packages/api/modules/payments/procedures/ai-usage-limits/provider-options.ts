/**
 * `aiUsageLimits.providerOptions` — list the AI providers (and their
 * canonical model names) configured in the active tenant, so the limit
 * edit sheet can render selectable Provider + Model dropdowns instead of
 * the v1's free-text-only placeholder.
 *
 * Tenant isolation:
 * - Org context: provider rows come from `cloud_provider_config` filtered
 *   by `organizationId`. Member-role check matches `list` / `status` —
 *   non-admin members get an empty payload so they never see what's
 *   configured at the org level.
 * - Personal context: provider rows come from `user_cloud_provider_config`
 *   filtered by the caller's `userId`.
 *
 * Model lookup: each provider row is joined to `ai_model_provider_mapping`
 * to surface every `(provider, canonicalName)` pair the platform knows
 * about, filtered to `isAvailable: true`. We do NOT filter by the tenant's
 * own usage history — the edit sheet shows the full catalog so a user can
 * pre-emptively cap a model they haven't called yet.
 */
import { ORPCError } from "@orpc/server";
import {
	type AIProvider,
	db,
	getOrganizationMembership,
	getProviderDisplayName,
} from "@repo/database";
import { z } from "zod";
import {
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
});

export interface ProviderModelOption {
	/** Canonical model name (e.g. `gpt-4o`). */
	canonicalName: string;
	/** Display label — falls back to the canonical name. */
	displayName: string;
}

interface ProviderOption {
	/** UserCloudProviderConfig.id / CloudProviderConfig.id — written as
	 * `AiUsageLimit.providerConfigId` when the limit scopes to this
	 * provider. */
	id: string;
	/** Enum value (`OPENAI_DIRECT`, `ANTHROPIC_DIRECT`, …). */
	provider: AIProvider;
	displayName: string;
	models: ProviderModelOption[];
}

interface ProviderOptionsResult {
	providers: ProviderOption[];
}

function canManageLimits(role: string | undefined): boolean {
	return role === "owner" || role === "admin";
}

export const providerOptions = tenantProtectedProcedure
	.route({
		method: "GET",
		path: "/payments/ai-usage-limits/provider-options",
		tags: ["Payments"],
		summary: "List provider + model options for AI usage limit editing",
		description:
			"Returns each configured AI provider in the active tenant plus the canonical model names available through that provider. Used by the AiUsageLimitEditSheet to render Provider + Model selects.",
	})
	.input(inputSchema)
	.handler(
		async ({
			input,
			context: { user, session },
		}): Promise<ProviderOptionsResult> => {
			const organizationId = resolveOrganizationId(
				input.organizationId,
				session,
			);

			let providerRows: Array<{
				id: string;
				provider: AIProvider;
				displayName: string | null;
			}>;

			if (organizationId) {
				const membership = await getOrganizationMembership(
					organizationId,
					user.id,
				);
				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}
				if (!canManageLimits(membership.role)) {
					return { providers: [] };
				}

				providerRows = await db.cloudProviderConfig.findMany({
					where: { organizationId, enabled: true },
					select: { id: true, provider: true, displayName: true },
					orderBy: { priority: "asc" },
				});
			} else {
				providerRows = await db.userCloudProviderConfig.findMany({
					where: { userId: user.id, enabled: true },
					select: { id: true, provider: true, displayName: true },
					orderBy: { priority: "asc" },
				});
			}

			if (providerRows.length === 0) {
				return { providers: [] };
			}

			// Look up models once per distinct provider enum value (multiple
			// configs can map to the same enum — e.g. two OpenAI keys).
			const distinctProviders = Array.from(
				new Set(providerRows.map((r) => r.provider)),
			);
			const mappings = await db.aiModelProviderMapping.findMany({
				where: {
					provider: { in: distinctProviders },
					isAvailable: true,
				},
				select: {
					provider: true,
					model: {
						select: { canonicalName: true, displayName: true },
					},
				},
				// Stable order so the same model appears at the top of every
				// re-render — UI reads first-N for the popular subset.
				orderBy: { model: { canonicalName: "asc" } },
			});

			const modelsByProvider = new Map<
				AIProvider,
				ProviderModelOption[]
			>();
			for (const m of mappings) {
				if (!m.model) {
					continue;
				}
				const list = modelsByProvider.get(m.provider) ?? [];
				list.push({
					canonicalName: m.model.canonicalName,
					displayName: m.model.displayName ?? m.model.canonicalName,
				});
				modelsByProvider.set(m.provider, list);
			}

			const providers: ProviderOption[] = providerRows.map((row) => ({
				id: row.id,
				provider: row.provider,
				displayName:
					row.displayName ?? getProviderDisplayName(row.provider),
				models: modelsByProvider.get(row.provider) ?? [],
			}));

			return { providers };
		},
	);
