/**
 * v1 coding-instructions checkout resolver (Fizzy #2878)
 *
 *   POST /instructions/checkouts/resolve    which projects a repository belongs to
 *
 * `fabric instructions init | check | sync` runs in a git checkout and has to
 * find the Fabric project it belongs to without being told. It sends the
 * canonical HTTPS spellings of the checkout's fetch remote and gets back the
 * repository-sourced projects those URLs are connected to that the caller may
 * read. The route sits at the top level because no project is named yet; it
 * cannot collide with `/projects/:projectId/...`.
 *
 * ## An empty answer is the normal answer
 *
 * `matches: []` covers every way this can fail to find something: nothing is
 * connected to the URL, the project is in another organization, the caller
 * cannot read it, the project keeps its instructions as uploads. The caller
 * cannot tell those apart, so the route is not an oracle for which
 * repositories other tenants have connected. A project is named only after it
 * passes `resolveInstructionProject`, the gate every other route here runs: an
 * organization-bound credential reaches its own organization's projects, and
 * the creator needs a live `INSTRUCTION_READ` on the project.
 *
 * Nothing in the response is a secret: no integration id, no token, no
 * userinfo. The clone URL is the canonical credential-free one; a developer's
 * own git supplies the credentials.
 */
import {
	findAllByRepoUrl,
	getProjectInstructionSettings,
	listInstructionSyncsByIntegrationIds,
	parseRepoUrl,
	repositoryIdentity,
} from "@repo/database";
import type { Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import {
	credentialMayReachProject,
	type ExternalApiVariables,
	isOrganizationBoundKey,
} from "../external-api/types";
import { badRequest, ok } from "./helpers";
import { resolveInstructionProject } from "./instruction-project-gate";

/** A checkout has at most a handful of remotes, and each is sent once. */
const CHECKOUT_CANDIDATES_MAX = 10;

/** Longer than any repository URL a provider issues. */
const CHECKOUT_CANDIDATE_MAX_LENGTH = 512;

/**
 * The most projects one request puts through the read gate. A public
 * repository connected by many organizations must not turn one request into
 * hundreds of permission lookups; a legitimate repository is connected to a
 * few projects.
 */
const CHECKOUT_PROJECTS_MAX = 20;

/**
 * Whether a candidate carries userinfo (`user@host`, `user:token@host`, or
 * scp-style `git@host:path`). Refused rather than stripped: this surface
 * takes URLs a client already canonicalised, so a credential in one is a
 * client mistake, and the refusal keeps it out of every log line and cache
 * key downstream of the parse.
 */
function carriesUserInfo(candidate: string): boolean {
	const afterScheme = candidate.trim().replace(/^[a-z][a-z\d+.-]*:\/\//i, "");
	return (afterScheme.split(/[/?#]/, 1)[0] ?? "").includes("@");
}

/**
 * The canonical repository URLs in the request, or why it is refused.
 * Messages name the position, never the value: a candidate that is not a URL
 * may be something else a client had in its hand.
 */
function readResolveBody(raw: unknown): { urls: string[] } | { error: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { error: "Body must be a JSON object." };
	}
	const { candidates } = raw as { candidates?: unknown };
	if (
		!Array.isArray(candidates) ||
		candidates.length === 0 ||
		candidates.length > CHECKOUT_CANDIDATES_MAX
	) {
		return {
			error: `candidates must be an array of 1 to ${CHECKOUT_CANDIDATES_MAX} repository URLs.`,
		};
	}
	const urls = new Set<string>();
	for (const [index, candidate] of candidates.entries()) {
		if (
			typeof candidate !== "string" ||
			candidate.length === 0 ||
			candidate.length > CHECKOUT_CANDIDATE_MAX_LENGTH
		) {
			return {
				error: `candidates[${index}] must be a string of 1 to ${CHECKOUT_CANDIDATE_MAX_LENGTH} characters.`,
			};
		}
		if (carriesUserInfo(candidate)) {
			return {
				error: `candidates[${index}] must not carry credentials; send the URL without user information.`,
			};
		}
		const parsed = parseRepoUrl(candidate);
		if (!parsed) {
			return {
				error: `candidates[${index}] is not an HTTPS repository URL on a supported provider, without a port, query or fragment.`,
			};
		}
		urls.add(parsed.url);
	}
	return { urls: [...urls] };
}

export function registerInstructionCheckoutRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	/**
	 * POST /instructions/checkouts/resolve
	 *
	 * Body `{ candidates: string[] }`, 1 to 10 URLs of at most 512 characters,
	 * each re-parsed here with `parseRepoUrl` whatever the client did: the
	 * stored form is what the lookup compares with, ignoring letter case
	 * (`findAllByRepoUrl`). Response
	 * `{ matches: [{ projectId, projectName, organizationSlug, provider, host,
	 * path, ref, rootPath, cloneUrl }] }`, `host` and `path` being the pair
	 * the published response names the repository by.
	 *
	 * TWO gates, each with its own refusal (AGENTS.md: an API key never grants
	 * more than the UI): the key's declared scope, `instructions:read`, from
	 * the middleware, and per project the creator's live `INSTRUCTION_READ`
	 * and the organization binding, `resolveInstructionProject`. A project
	 * that fails the second is absent from the answer, not refused: see the
	 * header on why.
	 *
	 * `?org=<slug>` narrows the answer to one organization, with the same
	 * meaning it has on every other route here; `?personal=1` names a context
	 * this surface has no projects in and is not read.
	 */
	app.post(
		"/instructions/checkouts/resolve",
		requireScope("instructions:read"),
		async (c) => {
			let rawBody: unknown;
			try {
				rawBody = await c.req.json();
			} catch {
				return c.json(badRequest("Invalid JSON body"), 400);
			}
			const body = readResolveBody(rawBody);
			if ("error" in body) {
				return c.json(badRequest(body.error), 400);
			}

			const apiCtx = c.get("externalApiContext");
			// The cheap half of the gate, to keep an organization-bound
			// credential from paying a permission lookup for every other
			// tenant that connected the same repository, and an agent that
			// signed in for one project from paying one for any other. The
			// per-project gate below is still the authority.
			const integrations = (await findAllByRepoUrl(body.urls)).filter(
				(integration) =>
					integration.project.organizationId !== null &&
					(!isOrganizationBoundKey(apiCtx) ||
						integration.project.organizationId ===
							apiCtx.organizationId) &&
					credentialMayReachProject(apiCtx, integration.project.id),
			);
			const integrationById = new Map(
				integrations.map((integration) => [
					integration.id,
					integration,
				]),
			);
			const syncs = await listInstructionSyncsByIntegrationIds(
				integrations.map((integration) => integration.id),
				CHECKOUT_PROJECTS_MAX,
			);

			const org = c.req.query("org");
			const matches = await Promise.all(
				syncs.map(async (sync) => {
					const gate = await resolveInstructionProject(
						sync.projectId,
						apiCtx,
						{ org, personal: false },
					);
					if (
						"error" in gate ||
						gate.organizationId !== sync.organizationId
					) {
						return null;
					}
					const settings = await getProjectInstructionSettings(
						sync.projectId,
						gate.organizationId,
					);
					const integration = integrationById.get(
						sync.repositoryIntegrationId,
					);
					const identity =
						integration && repositoryIdentity(integration);
					if (
						settings.sourceOfTruth !== "REPOSITORY" ||
						!integration ||
						!identity
					) {
						return null;
					}
					return {
						projectId: sync.projectId,
						projectName: sync.project.name,
						organizationSlug: sync.organization.slug,
						provider: integration.provider,
						host: identity.host,
						path: identity.path,
						ref: sync.ref,
						rootPath: sync.rootPath,
						// The stored value is a canonical URL (`parseRepoUrl`
						// wrote it), so it serves whenever the identity has none.
						cloneUrl:
							identity.cloneUrl ?? integration.repositoryUrl,
					};
				}),
			);

			return c.json(
				ok({ matches: matches.filter((match) => match !== null) }),
			);
		},
	);
}
