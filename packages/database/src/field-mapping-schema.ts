import { z } from "zod";

/**
 * Provider-agnostic PM custom-field read-mapping config.
 *
 * Persisted as the `fieldMapping` key inside the existing
 * `Project.projectManagementAdditionalContext` Json column (no new table). This
 * is the single source of truth for the shape, imported by BOTH the oRPC API
 * input validation (`packages/api`) and the aggregation reader
 * (`packages/temporal`) — both already depend on `@repo/database`, so hosting it
 * here avoids a circular cross-package import.
 */

/**
 * Concrete provider discriminator for Azure DevOps. Equals the runtime
 * `capabilities.detectedType` (`tool-analyzer.ts`), so replace-mode activation is
 * a plain equality check. decisions.md wrote `"ado"` as shorthand; the stored
 * value is `"azure-devops"` to match `detectedType`.
 */
export const ADO_FIELD_MAPPING_PROVIDER = "azure-devops";

/** One selected field. `id` = provider field identifier (ADO `referenceName`);
 *  `displayName` = human label captured at save time, used as the `## <heading>`. */
export const fieldMappingFieldSchema = z.object({
	id: z.string().min(1),
	displayName: z.string().min(1),
});
export type FieldMappingField = z.infer<typeof fieldMappingFieldSchema>;

/**
 * The full config. `provider` equals the connected `detectedType`; `fields[]` is
 * ordered — array index IS the display order. An empty `fields[]` is a VALID
 * config (persisted on explicit clear) that the aggregation reader treats as
 * "no active config" via a `fields.length` check — it is NOT rejected here.
 */
export const fieldMappingConfigSchema = z.object({
	provider: z.string().min(1),
	fields: z.array(fieldMappingFieldSchema),
});
export type FieldMappingConfig = z.infer<typeof fieldMappingConfigSchema>;

/**
 * Defensive parse of a stored/incoming `fieldMapping` value. Malformed or legacy
 * shapes return the `null` "no config" sentinel instead of throwing, so the
 * aggregation reader can safely fall back to the legacy precedence chain. A
 * valid-but-empty `fields: []` is returned as-is (not nulled).
 */
export function parseFieldMappingConfig(
	value: unknown,
): FieldMappingConfig | null {
	const parsed = fieldMappingConfigSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/**
 * Convenience reader: extract and defensively parse the `fieldMapping` config
 * from a project's `projectManagementAdditionalContext` Json blob. Returns the
 * "no config" sentinel (`null`) when the context is absent, not an object, or the
 * `fieldMapping` key is missing/malformed.
 */
export function readFieldMappingConfig(
	additionalContext: unknown,
): FieldMappingConfig | null {
	if (!additionalContext || typeof additionalContext !== "object") {
		return null;
	}
	return parseFieldMappingConfig(
		(additionalContext as Record<string, unknown>).fieldMapping,
	);
}
