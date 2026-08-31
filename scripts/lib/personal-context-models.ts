/**
 * Which models can hold personal-context rows, and how personal is encoded on
 * each of them.
 *
 * Shared by the inventory and the drop job because they were written apart and
 * immediately disagreed: the drop job knew that two tables encode personal as
 * an empty string, the inventory did not, and so the inventory reported those
 * two as uncountable while their rows sat there. A count that disagrees with
 * the delete is worse than either alone — it is the disagreement that gets
 * believed.
 *
 * Read from the schema rather than from the tenancy-class sets in the query
 * layer. Those sets are the authority on how a model is FILTERED at runtime;
 * the question here is narrower and structural — does this table have an
 * organization column, and can that column say "no organization" — which the
 * schema answers directly and keeps answering as models are added.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

type PersonalEncoding =
	/** `organizationId String?` — personal is a null. The common case. */
	| "null"
	/**
	 * `organizationId String @default("")` — personal is an empty string,
	 * because the column was declared non-nullable. Invisible to any sweep or
	 * verification written against `IS NULL`, which is exactly how rows here
	 * would survive a drop that reported itself complete.
	 */
	| "empty-string";

export type PersonalBearingModel = {
	name: string;
	encoding: PersonalEncoding;
	/** Personal rows are attributable to a person only when this is true. */
	hasUserId: boolean;
	/**
	 * True when `userId` is nullable, so a row on this model can have NO owner.
	 *
	 * Such a row is not personal context. "No organization AND no user" is a
	 * GLOBAL row — the seeded MCP catalog and the system prompt library are
	 * exactly this shape — and a sweep written against `organizationId IS NULL`
	 * alone takes them with it. On a local database that was seventy-two rows
	 * of the eighty-seven the inventory found.
	 */
	userIdNullable: boolean;
};

const SCHEMA = join(
	__dirname,
	"..",
	"..",
	"packages",
	"database",
	"prisma",
	"schema.prisma",
);

/**
 * Models that can hold a personal row, with the encoding each one uses.
 *
 * A model whose `organizationId` is required and carries no empty-string
 * default is organization-only: it has no way to express "no organization", so
 * there is nothing personal on it to find. Those are excluded rather than
 * reported as uncountable — calling them a gap would put eighteen permanent
 * entries on a list whose whole purpose is to be read as "look here".
 */
export function personalBearingModels(
	schemaPath: string = SCHEMA,
): PersonalBearingModel[] {
	const schema = readFileSync(schemaPath, "utf8");
	const models: PersonalBearingModel[] = [];

	for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
		const [, name, body] = match;

		const organizationLine = body
			.split("\n")
			.find((line) => /^\s*organizationId\s/.test(line));
		if (!organizationLine) {
			continue;
		}

		const nullable = /^\s*organizationId\s+String\?/.test(organizationLine);
		const emptyDefault = /@default\(""\)/.test(organizationLine);

		if (!nullable && !emptyDefault) {
			// Organization-only. No personal concept to count or delete.
			continue;
		}

		const userLine = body
			.split("\n")
			.find((line) => /^\s*userId\s/.test(line));

		models.push({
			name,
			encoding: nullable ? "null" : "empty-string",
			hasUserId: userLine !== undefined,
			userIdNullable: userLine
				? /^\s*userId\s+String\?/.test(userLine)
				: false,
		});
	}

	return models.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The `where` clause selecting every personal row on a model.
 *
 * "Personal" means a row that belongs to a PERSON and to no organization. A row
 * with neither is global — the seeded MCP catalog and the system prompts are
 * exactly that — so where a model allows an ownerless row, this excludes it.
 * Without that predicate the sweep reads as "everything with no organization",
 * which on a local database was seventy-two global rows out of eighty-seven.
 */
export function personalWhere(
	model: PersonalBearingModel,
): Record<string, unknown> {
	return {
		organizationId: model.encoding === "empty-string" ? "" : null,
		...(model.userIdNullable ? { userId: { not: null } } : {}),
	};
}

/** The Prisma delegate for a model name, or null when it is not queryable. */
export function delegateFor<T>(
	client: Record<string, unknown>,
	modelName: string,
): T | null {
	const key = modelName.charAt(0).toLowerCase() + modelName.slice(1);
	const value = client[key];
	return value && typeof value === "object" ? (value as T) : null;
}

/**
 * The action a refusal row carries. Kept in step with
 * `recordOrganizationRefusal` in the web app by the predicate test, which reads
 * both — the script cannot import that module, which pulls the whole audit
 * dispatch stack behind it.
 */
export const ORGANIZATION_REFUSAL_ACTION = "mcp.session.organization_denied";

/**
 * Add an owner condition to a personal predicate WITHOUT discarding the
 * ownerless-row guard `personalWhere` may already have placed on `userId`.
 *
 * Spreading a fresh `userId` over the base silently dropped that guard. Global
 * rows survived only because SQL's IN and NOT IN exclude NULLs anyway — an
 * accident of the operator rather than the predicate, and one that stops being
 * true the moment this filter's shape changes.
 */
export function withOwner(
	base: Record<string, unknown>,
	owner: Record<string, unknown>,
): Record<string, unknown> {
	const guard = base.userId;
	return {
		...base,
		userId:
			guard && typeof guard === "object"
				? { ...(guard as Record<string, unknown>), ...owner }
				: owner,
	};
}

/**
 * The `where` clause for the audit trail, which is the one model here where
 * `organizationId: null` does NOT mean "personal".
 *
 * A null tenant on an audit row is any of: an organization's own trail kept
 * after the organization was deleted (`onDelete: SetNull`, so the trail
 * outlives its subject); a system actor, which writes no organization at all;
 * or a refusal, whose null tenant is deliberate and whose whole value is being
 * the record that someone reached for a tenant they had no standing in.
 *
 * So there is no safe bare sweep. This never degenerates to the whole column:
 * an ownerless row can never match, and the refusal evidence is excluded
 * outright. What it still cannot separate is an in-scope user's rows from a
 * deleted organization — undecidable from the row — which is why deleting
 * anything this selects takes its own operator switch.
 */
export function auditLogWhere(
	clearedUserIds: string[] | null,
	refusedUserIds: string[],
): Record<string, unknown> {
	const owner: Record<string, unknown> = { not: null };
	if (clearedUserIds) {
		owner.in = clearedUserIds;
	} else if (refusedUserIds.length > 0) {
		owner.notIn = refusedUserIds;
	}
	return {
		organizationId: null,
		userId: owner,
		NOT: { action: ORGANIZATION_REFUSAL_ACTION },
	};
}
