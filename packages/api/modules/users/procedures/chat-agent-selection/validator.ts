/**
 * Server-side validator for `UserChatAgentSelection.selectedAgents`.
 *
 * Single source of truth for "what counts as resolvable" (Decision 7 / spec §5.4).
 * The validator is purposefully *silent*: invalid entries are dropped and a
 * single integer count is returned for telemetry. The validator NEVER throws —
 * on any unexpected error it degrades to `{ kept: [], droppedCount: 0 }` so
 * the caller falls through to the first-run path.
 *
 * Drop rules:
 *   1. Real agent (no `:` prefix in `agentId`) — drop on:
 *      - `RegisteredAgent.status !== "ACTIVE"`
 *      - tenant-scope mismatch (ORGANIZATION-scoped agent in personal
 *        context or cross-org leak; USER-scoped agent owned by another user
 *        or surfaced in org context)
 *      The picker hydrates real agents from `RegisteredAgent` (the
 *      `/agents/registry/list` procedure), keyed by the slug-style
 *      `RegisteredAgent.agentId` column — NOT the cuid `id`. The validator
 *      MUST look there with the same key, or every persisted SYSTEM/USER/ORG
 *      chip is silently dropped on read.
 *   2. `model:<canonicalName>` — drop if missing from the AI model catalog
 *      OR the tenant has no enabled provider config for the model's vendor.
 *   3. `template-instance:<id>` — drop if the instance row is hard-deleted
 *      or its tenant scope does not match the current `(user, org)` context.
 *   4. `history:<slug>` — dropped unconditionally. History entries are
 *      conversation-bound (synthesized inside `deriveSelectedAgentsFromHistory`)
 *      and have no meaning outside their originating chat. Persisting them
 *      across sessions is a write-side artifact, not a stable identity.
 *   5. Schema/version mismatch — drop entries that fail
 *      `PersistedSelectedAgentSchema.safeParse`.
 *   6. Forward-compat — drop entries with an unknown `agentId` prefix.
 *
 * Performance: exactly 4 batched `findMany` queries (one per chip type) +
 * 1 provider-config fetch, all run in parallel via `Promise.all`. No N+1.
 */

import {
	type AIProvider,
	db,
	type PersistedSelectedAgent,
	PersistedSelectedAgentSchema,
} from "@repo/database";
import { logger } from "@repo/logs";

interface ValidatorInput {
	entries: unknown;
	userId: string;
	organizationId: string | null;
}

interface ValidatorOutput {
	kept: PersistedSelectedAgent[];
	droppedCount: number;
}

/**
 * Map a `vendor` display string from the persisted chip (e.g. "OpenAI",
 * "Anthropic") to the matching `AIProvider` enum value. Used for
 * model-as-agent provider-config matching.
 *
 * Conservative: returns `null` on miss so the caller drops the entry.
 * Multiple `AIProvider` enum members can share a vendor name (e.g. OpenAI
 * via OPENAI_DIRECT vs via VERCEL_GATEWAY); membership in *any* matching
 * provider's enabled config is enough to keep the entry.
 */
function vendorToProviders(vendor: string | undefined): AIProvider[] {
	if (!vendor) {
		return [];
	}
	const lower = vendor.toLowerCase();
	const providers: AIProvider[] = [];

	// Direct vendor matches.
	if (lower.includes("openai")) {
		providers.push("OPENAI_DIRECT");
	}
	if (lower.includes("anthropic") || lower === "claude") {
		providers.push("ANTHROPIC_DIRECT");
	}
	if (lower.includes("groq")) {
		providers.push("GROQ");
	}
	if (lower.includes("together")) {
		providers.push("TOGETHER_AI");
	}
	if (lower.includes("deepseek")) {
		providers.push("DEEPSEEK");
	}
	if (lower.includes("cohere")) {
		providers.push("COHERE");
	}
	if (lower.includes("mistral")) {
		providers.push("MISTRAL_AI");
	}
	if (lower.includes("fireworks")) {
		providers.push("FIREWORKS");
	}
	if (lower.includes("perplexity")) {
		providers.push("PERPLEXITY");
	}
	if (lower.includes("xai") || lower === "x.ai" || lower.includes("grok")) {
		providers.push("XAI");
	}
	if (lower.includes("cerebras")) {
		providers.push("CEREBRAS");
	}
	if (lower.includes("azure")) {
		providers.push("AZURE_AI_FOUNDRY");
	}
	if (lower.includes("databricks")) {
		providers.push("DATABRICKS");
	}
	if (lower.includes("bedrock") || lower.includes("aws")) {
		providers.push("AWS_BEDROCK");
	}
	if (lower.includes("vertex") || lower.includes("google")) {
		providers.push("GOOGLE_VERTEX_AI");
	}

	// Gateway providers can serve any vendor — treat them as a wildcard
	// match if they're enabled. We always include them as candidates so
	// that a tenant configured only with Vercel Gateway / OpenRouter /
	// Cloudflare can still satisfy any model.
	providers.push("VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI");

	return providers;
}

/**
 * Fetch the set of enabled `AIProvider` enum values configured for the
 * current tenant (org-scope queries `cloud_provider_config`, personal-scope
 * queries `user_cloud_provider_config`). Used for vendor reachability checks.
 *
 * Returns an empty `Set` on any error (caller treats this as "no providers
 * available" → all model / agent entries are dropped, which is the correct
 * fail-closed behavior).
 */
async function getEnabledProviders(
	userId: string,
	organizationId: string | null,
): Promise<Set<AIProvider>> {
	if (organizationId) {
		const rows = await db.cloudProviderConfig.findMany({
			where: { organizationId, enabled: true },
			select: { provider: true },
		});
		return new Set(rows.map((r) => r.provider));
	}
	const rows = await db.userCloudProviderConfig.findMany({
		where: { userId, enabled: true },
		select: { provider: true },
	});
	return new Set(rows.map((r) => r.provider));
}

interface BucketedEntries {
	realAgentIds: string[];
	modelNames: string[];
	templateInstanceIds: string[];
}

function bucketize(entries: PersistedSelectedAgent[]): {
	buckets: BucketedEntries;
	// Indexed by entry's position in `entries`. `kind: "drop"` means the
	// entry's prefix was unrecognized (forward-compat drop) — counted in
	// droppedCount immediately.
	classification: Array<
		| { kind: "real"; key: string }
		| { kind: "model"; key: string }
		| { kind: "template"; key: string }
		| { kind: "history" } // unconditional drop
		| { kind: "drop" } // unknown prefix → drop
	>;
} {
	const buckets: BucketedEntries = {
		realAgentIds: [],
		modelNames: [],
		templateInstanceIds: [],
	};
	const classification: Array<
		| { kind: "real"; key: string }
		| { kind: "model"; key: string }
		| { kind: "template"; key: string }
		| { kind: "history" }
		| { kind: "drop" }
	> = [];

	for (const entry of entries) {
		const id = entry.agentId;
		if (id.startsWith("model:")) {
			const name = id.slice("model:".length);
			classification.push({ kind: "model", key: name });
			if (name) {
				buckets.modelNames.push(name);
			}
			continue;
		}
		if (id.startsWith("template-instance:")) {
			const instanceId = id.slice("template-instance:".length);
			classification.push({ kind: "template", key: instanceId });
			if (instanceId) {
				buckets.templateInstanceIds.push(instanceId);
			}
			continue;
		}
		if (id.startsWith("history:")) {
			classification.push({ kind: "history" });
			continue;
		}
		if (id.includes(":")) {
			// Unknown `prefix:rest` shape — forward-compat drop.
			classification.push({ kind: "drop" });
			continue;
		}
		// Otherwise: real agent.
		classification.push({ kind: "real", key: id });
		buckets.realAgentIds.push(id);
	}

	return { buckets, classification };
}

export async function validatePersistedAgents(
	input: ValidatorInput,
): Promise<ValidatorOutput> {
	try {
		// Step 1 — schema/version gate. Entries that do not parse against
		// PersistedSelectedAgentSchema are dropped here. (Drop rule 5.)
		const rawEntries = Array.isArray(input.entries) ? input.entries : [];
		let droppedCount = 0;
		const parsed: PersistedSelectedAgent[] = [];
		for (const raw of rawEntries) {
			const result = PersistedSelectedAgentSchema.safeParse(raw);
			if (result.success) {
				parsed.push(result.data);
			} else {
				droppedCount += 1;
			}
		}

		if (parsed.length === 0) {
			return { kept: [], droppedCount };
		}

		// Step 2 — bucket parsed entries by chip variant.
		const { buckets, classification } = bucketize(parsed);

		// Step 3 — batched existence checks. Four parallel queries +
		// the provider-config fetch.
		//
		// Real agents come from `RegisteredAgent` — the same table the picker
		// reads via `/agents/registry/list`. Persisted chips store the
		// slug-style `RegisteredAgent.agentId` (e.g. "sidekick"), NOT the
		// cuid PK; we MUST look up by `agentId`. Earlier wiring queried
		// `db.agent` by `id`, which silently dropped every chip because no
		// row matched and the validator then deleted the persistence row
		// (read-time empty cleanup) — so reload always took the first-run
		// path even when set/200 had just succeeded.
		const [enabledProviders, realAgents, models, templateInstances] =
			await Promise.all([
				getEnabledProviders(input.userId, input.organizationId),
				buckets.realAgentIds.length > 0
					? db.registeredAgent.findMany({
							where: {
								agentId: { in: buckets.realAgentIds },
								status: "ACTIVE",
							},
							// Select only the fields the validator needs (no
							// large columns) — `backend/queries.md`
							// "Select Only Needed Data". RegisteredAgent has
							// no `aiProvider` column, so vendor reachability
							// for real agents is decided at send time by the
							// runtime defaults, not here.
							select: {
								agentId: true,
								scope: true,
								organizationId: true,
								userId: true,
							},
						})
					: Promise.resolve([]),
				buckets.modelNames.length > 0
					? db.aiModel.findMany({
							where: {
								canonicalName: { in: buckets.modelNames },
							},
							select: {
								canonicalName: true,
								vendor: true,
								// A model is reachable via any provider it has a
								// catalog mapping for (e.g. a Meta/Anthropic-vendored
								// model served through Databricks), not just its
								// display vendor.
								providerMappings: {
									where: { isAvailable: true },
									select: { provider: true },
								},
							},
						})
					: Promise.resolve([]),
				buckets.templateInstanceIds.length > 0
					? db.agentTemplateInstance.findMany({
							where: { id: { in: buckets.templateInstanceIds } },
							select: {
								id: true,
								userId: true,
								organizationId: true,
							},
						})
					: Promise.resolve([]),
			]);

		// Build per-bucket "kept" sets.
		const keptRealAgentIds = new Set<string>();
		for (const agent of realAgents) {
			// Tenant-scope check — must mirror `listRegisteredAgents` (the
			// picker source) so anything visible in the picker is also
			// keepable on read. SYSTEM passes unconditionally; ORGANIZATION
			// must match the active org and is invisible in personal context;
			// USER must match the user and is invisible in any org context.
			if (agent.scope === "ORGANIZATION") {
				if (
					!input.organizationId ||
					agent.organizationId !== input.organizationId
				) {
					continue;
				}
			} else if (agent.scope === "USER") {
				if (
					input.organizationId !== null ||
					agent.userId !== input.userId
				) {
					continue;
				}
			}
			// SYSTEM scope: passes the tenant check unconditionally.

			// `RegisteredAgent` has no `aiProvider` column — vendor
			// reachability for real agents is decided at send time by the
			// runtime defaults, not here. This is intentional and matches
			// the picker's behavior (the picker doesn't gate on cloud
			// providers either).

			keptRealAgentIds.add(agent.agentId);
		}

		const keptModelNames = new Set<string>();
		for (const model of models) {
			const allowed = new Set<AIProvider>(
				vendorToProviders(model.vendor),
			);
			for (const mapping of model.providerMappings ?? []) {
				allowed.add(mapping.provider);
			}
			if ([...allowed].some((p) => enabledProviders.has(p))) {
				keptModelNames.add(model.canonicalName);
			}
		}

		const keptTemplateInstanceIds = new Set<string>();
		for (const inst of templateInstances) {
			// Tenant-scope check matches the AgentTemplateInstance ownership
			// model: org-scoped instances live under `organizationId`,
			// personal under `userId` with `organizationId === null`.
			if (input.organizationId) {
				if (inst.organizationId === input.organizationId) {
					keptTemplateInstanceIds.add(inst.id);
				}
			} else {
				if (
					inst.organizationId === null &&
					inst.userId === input.userId
				) {
					keptTemplateInstanceIds.add(inst.id);
				}
			}
		}

		// Step 4 — assemble `kept` preserving original order.
		const kept: PersistedSelectedAgent[] = [];
		for (let i = 0; i < parsed.length; i += 1) {
			const c = classification[i];
			if (!c) {
				continue;
			}
			const entry = parsed[i];
			if (!entry) {
				continue;
			}
			let isKept = false;
			switch (c.kind) {
				case "real":
					isKept = keptRealAgentIds.has(c.key);
					break;
				case "model":
					isKept = keptModelNames.has(c.key);
					break;
				case "template":
					isKept = keptTemplateInstanceIds.has(c.key);
					break;
				// "history" + "drop" are always dropped.
			}
			if (isKept) {
				kept.push(entry);
			} else {
				droppedCount += 1;
			}
		}

		return { kept, droppedCount };
	} catch (error) {
		// Decision 7 + spec §8 — degrade to first-run path on any unexpected
		// failure. NEVER throw out of this function.
		logger.warn("validatePersistedAgents failed; degrading to first-run", {
			error: error instanceof Error ? error.message : String(error),
			userId: input.userId,
			organizationId: input.organizationId,
		});
		return { kept: [], droppedCount: 0 };
	}
}
