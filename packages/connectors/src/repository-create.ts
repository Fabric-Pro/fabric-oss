/**
 * Creates a GitHub repository (specs/2026-10-21-ai-artifacts-hub §5.2, P4):
 * the project's separate instructions repository, created under the user or
 * an organization the token can create repositories in.
 *
 * `auto_init` gives the repository a first commit on its default branch, so
 * the instructions are then committed on top of it like any other change.
 *
 * Never throws for a provider answer; the closed outcome set lets the caller
 * say what to fix. SECURITY: the token is request-scoped, never logged and
 * never returned, and no provider body is surfaced.
 */

import {
	isRecord,
	repositoryRequestSignal,
	stringField,
} from "./repository-api";
import { readCappedRepositoryBody } from "./repository-body";

export type CreateGitHubRepositoryInput = {
	token: string;
	/** An organization login; null or the token's own login creates it under the user. */
	owner: string | null;
	name: string;
	description?: string;
	private: boolean;
	signal?: AbortSignal;
};

export type CreatedGitHubRepository = {
	owner: string;
	name: string;
	/** `https://github.com/<owner>/<name>` */
	url: string;
	defaultBranch: string;
};

export type CreateGitHubRepositoryResult =
	| { ok: true; repository: CreatedGitHubRepository }
	| {
			ok: false;
			/**
			 * `exists`: the name is taken. `forbidden`: the token may not create
			 * repositories there (a GitHub App without Administration: write, an
			 * organization that restricts creation, an owner it cannot see).
			 * `unauthorized`: the token is rejected.
			 */
			outcome:
				| "exists"
				| "forbidden"
				| "unauthorized"
				| "invalid"
				| "unreachable";
	  };

const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 1024 * 1024;

/** GitHub's own repository-name rule, plus a length cap. */
export const GITHUB_REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

function headers(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
}

async function readJson(response: Response): Promise<unknown> {
	try {
		const body = await readCappedRepositoryBody(response, MAX_BYTES, {
			refuseDeclaredLength: true,
		});
		return body.complete
			? JSON.parse(Buffer.from(body.bytes).toString("utf8"))
			: null;
	} catch {
		return null;
	}
}

/** The token's own login, or null when the token cannot say. */
async function authenticatedLogin(
	token: string,
	signal?: AbortSignal,
): Promise<{ login: string } | { outcome: "unauthorized" | "unreachable" }> {
	let response: Response;
	try {
		response = await fetch(`${API}/user`, {
			headers: headers(token),
			signal: repositoryRequestSignal(TIMEOUT_MS, signal),
		});
	} catch {
		return { outcome: "unreachable" };
	}
	if (response.status === 401) {
		await response.body?.cancel().catch(() => {});
		return { outcome: "unauthorized" };
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		return { outcome: "unreachable" };
	}
	const data = await readJson(response);
	const login = isRecord(data) ? stringField(data, "login") : null;
	return login ? { login } : { outcome: "unreachable" };
}

export async function createGitHubRepository(
	input: CreateGitHubRepositoryInput,
): Promise<CreateGitHubRepositoryResult> {
	if (!GITHUB_REPOSITORY_NAME_PATTERN.test(input.name)) {
		return { ok: false, outcome: "invalid" };
	}
	const me = await authenticatedLogin(input.token, input.signal);
	if (!("login" in me)) {
		return { ok: false, outcome: me.outcome };
	}
	const underUser =
		input.owner === null ||
		input.owner.toLowerCase() === me.login.toLowerCase();
	const endpoint = underUser
		? `${API}/user/repos`
		: `${API}/orgs/${encodeURIComponent(input.owner ?? "")}/repos`;
	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: {
				...headers(input.token),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				name: input.name,
				description: input.description ?? "",
				private: input.private,
				auto_init: true,
				has_issues: false,
				has_wiki: false,
				has_projects: false,
			}),
			signal: repositoryRequestSignal(TIMEOUT_MS, input.signal),
		});
	} catch {
		return { ok: false, outcome: "unreachable" };
	}
	if (response.status === 201) {
		const data = await readJson(response);
		if (!isRecord(data)) {
			return { ok: false, outcome: "unreachable" };
		}
		const name = stringField(data, "name");
		const url = stringField(data, "html_url");
		const defaultBranch = stringField(data, "default_branch") ?? "main";
		const ownerRecord = isRecord(data.owner) ? data.owner : null;
		const owner = ownerRecord ? stringField(ownerRecord, "login") : null;
		if (!name || !url || !owner) {
			return { ok: false, outcome: "unreachable" };
		}
		return { ok: true, repository: { owner, name, url, defaultBranch } };
	}
	if (response.status === 422) {
		const data = await readJson(response);
		const text = JSON.stringify(data ?? "").toLowerCase();
		return {
			ok: false,
			outcome: text.includes("already exists") ? "exists" : "invalid",
		};
	}
	await response.body?.cancel().catch(() => {});
	if (response.status === 401) {
		return { ok: false, outcome: "unauthorized" };
	}
	if (response.status === 403 || response.status === 404) {
		return { ok: false, outcome: "forbidden" };
	}
	return { ok: false, outcome: "unreachable" };
}
