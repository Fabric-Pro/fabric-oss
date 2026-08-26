/**
 * Sign-in credentials for a `ProjectEnvironment`.
 *
 * The rule this module exists to enforce: **a secret goes in, and only a
 * redacted description ever comes back out** — except on the one server-side
 * path that actually needs the plaintext to drive a browser. There is no query
 * here that returns a decrypted secret to anything a caller could render.
 *
 * Encryption reuses `encryptApiKey` (AES-256-GCM), the same helper the repo
 * credentials use, so there is one implementation to audit rather than two.
 *
 * **Auditing is the CALLER's job and is not done here.** These are database
 * queries; they have no actor. The oRPC procedure that wires them must record
 * who wrote or used a credential — especially for a PRODUCTION environment —
 * and must be the place that warns. Said explicitly because an earlier draft of
 * this comment claimed the auditing already happened, which was not true and is
 * exactly the kind of assurance a reader would have relied on.
 */

import { logger } from "@repo/logs";
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import { db } from "../../client";

export type EnvironmentAuthKind = "NONE" | "FORM" | "TOKEN" | "HEADER";

/**
 * The environment fields that are safe to send to a browser.
 *
 * A landmine this exists to defuse: the GENERATED whole-model
 * `ProjectEnvironmentSchema` (prisma/zod) now includes `encryptedAuthSecret`,
 * because it mirrors every column. It has no importers today, but the moment a
 * procedure reaches for it as an `output` schema — the obvious thing to do —
 * ciphertext goes over the wire. Editing the generated file is pointless; it is
 * rewritten by `prisma generate`. So the safe shape lives here, by hand, next
 * to the module that owns the secret.
 *
 * Use this, never the generated whole-model schema, for anything an environment
 * is serialised into.
 */
export const ENVIRONMENT_PUBLIC_FIELDS = [
	"id",
	"projectId",
	"type",
	"name",
	"baseUrl",
	"authKind",
	"authUsername",
	"authHeaderName",
	"authUpdatedAt",
	"createdAt",
	"updatedAt",
] as const;

/**
 * Columns that must never leave the server, in a form a test can assert
 * against. Keeping the list explicit means adding another secret column is a
 * deliberate act rather than something a projection quietly picks up.
 */
export const ENVIRONMENT_SECRET_FIELDS = ["encryptedAuthSecret"] as const;

/**
 * What the browser is allowed to know about an environment's credential:
 * whether one exists, what shape it is, and when it was last written. Never the
 * secret, and never enough to reconstruct it.
 */
export interface EnvironmentAuthSummary {
	authKind: EnvironmentAuthKind;
	/** Not secret on its own, and needed to show WHICH account is configured. */
	authUsername: string | null;
	authHeaderName: string | null;
	/** True when a secret is stored. The value itself never leaves the server. */
	hasSecret: boolean;
	authUpdatedAt: Date | null;
}

export interface SetEnvironmentAuthInput {
	projectId: string;
	environmentId: string;
	authKind: EnvironmentAuthKind;
	authUsername?: string | null;
	authHeaderName?: string | null;
	/**
	 * The plaintext secret. Omit to KEEP the stored one (so a user can edit the
	 * username without re-typing the password); pass `null` to clear it.
	 */
	secret?: string | null;
}

/**
 * Write an environment's credential.
 *
 * `projectId` is in the WHERE, so an environment id belonging to another
 * project matches nothing rather than being rewritten — the same tenant guard
 * the rest of the QA writes use.
 *
 * Switching to `NONE` wipes the secret rather than orphaning it: "this
 * environment needs no sign-in" and "this environment still has my password
 * lying about" must not be the same state.
 */
export async function setEnvironmentAuth(
	input: SetEnvironmentAuthInput,
): Promise<{ updated: boolean }> {
	const clearing = input.authKind === "NONE";

	// An empty string means "clear it", not "encrypt nothing". `encryptApiKey`
	// THROWS on empty input, so a form that blanks a password field and submits
	// "" would otherwise get a 500 out of a database write instead of the
	// obvious outcome. Treated identically to an explicit null.
	// Inline rather than via a `clearSecret` boolean: narrowing does not flow
	// through a separate variable, so TS could not prove `input.secret` is a
	// string by the time `encryptApiKey` sees it.
	const secretUpdate =
		clearing || input.secret === null || input.secret === ""
			? { encryptedAuthSecret: null, authUpdatedAt: null }
			: input.secret !== undefined
				? {
						encryptedAuthSecret: encryptApiKey(input.secret),
						authUpdatedAt: new Date(),
					}
				: // Untouched — the caller is editing something else.
					{};

	const { count } = await db.projectEnvironment.updateMany({
		where: { id: input.environmentId, projectId: input.projectId },
		data: {
			authKind: input.authKind,
			authUsername: clearing ? null : (input.authUsername ?? null),
			authHeaderName: clearing ? null : (input.authHeaderName ?? null),
			...secretUpdate,
		},
	});
	return { updated: count > 0 };
}

/**
 * The redacted description of every environment's credential for a project —
 * what Settings ▸ Environments renders. Deliberately selects no ciphertext at
 * all: a column that is never read cannot be accidentally returned.
 */
export async function listEnvironmentAuthSummaries(input: {
	projectId: string;
}): Promise<Array<EnvironmentAuthSummary & { environmentId: string }>> {
	const rows = await db.projectEnvironment.findMany({
		where: { projectId: input.projectId },
		select: {
			id: true,
			authKind: true,
			authUsername: true,
			authHeaderName: true,
			authUpdatedAt: true,
			// Selected ONLY to derive `hasSecret` below; never returned.
			encryptedAuthSecret: true,
		},
		orderBy: { createdAt: "asc" },
	});
	return rows.map((r) => ({
		environmentId: r.id,
		authKind: r.authKind as EnvironmentAuthKind,
		authUsername: r.authUsername,
		authHeaderName: r.authHeaderName,
		hasSecret: r.encryptedAuthSecret !== null,
		authUpdatedAt: r.authUpdatedAt,
	}));
}

/** The plaintext credential, for the runner only. */
export interface ResolvedEnvironmentAuth {
	authKind: EnvironmentAuthKind;
	username: string | null;
	headerName: string | null;
	secret: string | null;
	baseUrl: string;
	/**
	 * Where the sign-in FORM lives, when it is not at `baseUrl`. Null means the
	 * form is at the base URL, which is what the runner always assumed.
	 */
	signInUrl: string | null;
	/** True when this environment is the customer's live system. */
	isProduction: boolean;
}

/**
 * Resolve an environment's credential for a run — **the only path that decrypts**.
 *
 * Never call this from anything that renders. It exists for the browser-driving
 * activity, which needs the plaintext to type into a login form, and its result
 * must not be logged, returned over the wire, or stored on a run record.
 *
 * `isProduction` rides along deliberately: a caller deciding whether to warn, to
 * refuse, or to redact harder should not have to re-query to find out it is
 * pointing at the customer's live system.
 */
export async function resolveEnvironmentAuth(input: {
	projectId: string;
	environmentId: string;
}): Promise<ResolvedEnvironmentAuth | null> {
	const env = await db.projectEnvironment.findFirst({
		where: { id: input.environmentId, projectId: input.projectId },
		select: {
			type: true,
			baseUrl: true,
			signInUrl: true,
			authKind: true,
			authUsername: true,
			authHeaderName: true,
			encryptedAuthSecret: true,
		},
	});
	if (!env) {
		return null;
	}
	return {
		authKind: env.authKind as EnvironmentAuthKind,
		username: env.authUsername,
		headerName: env.authHeaderName,
		// A stored secret that will not decrypt (rotated key, corrupt row) is
		// reported as absent rather than throwing: the caller's "no usable
		// credential" path is a better failure than a crashed run.
		secret: env.encryptedAuthSecret
			? safeDecrypt(env.encryptedAuthSecret, input.environmentId)
			: null,
		baseUrl: env.baseUrl,
		signInUrl: env.signInUrl,
		isProduction: env.type === "PRODUCTION",
	};
}

function safeDecrypt(ciphertext: string, environmentId: string): string | null {
	try {
		return decryptApiKey(ciphertext);
	} catch (err) {
		// Returning null is right — a crashed run is worse than "no usable
		// credential" — but swallowing it entirely means a customer's stored
		// credential can stop working (rotated key, corrupt row) with NOBODY
		// seeing it until a support ticket arrives. The value never goes near
		// the log; only the fact that it would not decrypt.
		logger.error("qa.environment.credential_undecryptable", {
			environmentId,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}
