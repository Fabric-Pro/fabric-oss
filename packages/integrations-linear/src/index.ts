// Portions of this file are derived from Corsair (https://github.com/corsairdotdev/corsair)
// Original work © Corsair contributors. Licensed under Apache-2.0.
// Modifications © TechFabric LLC. Licensed under MIT (see the containing package's LICENSE).
// See THIRD_PARTY_NOTICES.md at the repository root for full attribution.

/**
 * @fabricorg/integrations-linear
 *   import "@fabricorg/integrations-linear";              // SDK consumers (types)
 *   import { linearPlugin } from "@fabricorg/integrations-linear";  // portal (runtime)
 *
 * Linear's API is GraphQL only; the runtime exposes endpoint *operations*
 * (e.g. `issues.create`) and translates each into a focused GraphQL mutation
 * so callers don't write GraphQL by hand.
 */

import { defineIntegration, endpoint } from "@fabricorg/integrations-runtime";
// Force resolution of @fabricorg/sdk for module augmentation below.
import type {} from "@fabricorg/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// Typed surface
// ─────────────────────────────────────────────────────────────────────────────

export interface LinearIntegrationClient {
	issues: {
		list(args?: {
			first?: number;
			filter?: { team?: { id?: { eq?: string } } };
		}): Promise<{ issues: LinearIssue[] }>;
		get(args: { id: string }): Promise<LinearIssue>;
		create(args: {
			teamId: string;
			title: string;
			description?: string;
			assigneeId?: string;
			priority?: 0 | 1 | 2 | 3 | 4;
		}): Promise<{ issue: LinearIssue }>;
		update(args: {
			id: string;
			title?: string;
			description?: string;
			stateId?: string;
		}): Promise<{ issue: LinearIssue }>;
		delete(args: { id: string }): Promise<{ success: boolean }>;
	};
	teams: {
		list(): Promise<{ teams: LinearTeam[] }>;
	};
	users: {
		viewer(): Promise<LinearUser>;
	};
}

export interface LinearIssue {
	id: string;
	identifier: string;
	title: string;
	description?: string;
	url: string;
	state?: { id: string; name: string; type: string };
	team?: { id: string; key: string; name: string };
	priority?: number;
	createdAt: string;
}
export interface LinearTeam {
	id: string;
	key: string;
	name: string;
}
export interface LinearUser {
	id: string;
	name: string;
	email: string;
	displayName: string;
}

declare module "@fabricorg/sdk" {
	interface FabricIntegrations {
		linear: LinearIntegrationClient;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime
// ─────────────────────────────────────────────────────────────────────────────

const LINEAR_API = "https://api.linear.app/graphql";

function token(creds: Record<string, unknown>): string {
	const t = creds.access_token ?? creds.token ?? creds.api_key;
	if (typeof t !== "string") {
		throw new Error("linear: missing access_token in credentials");
	}
	return t;
}

async function gql<T>(
	tok: string,
	query: string,
	variables?: Record<string, unknown>,
): Promise<T> {
	const res = await fetch(LINEAR_API, {
		method: "POST",
		headers: {
			Authorization: tok.startsWith("lin_") ? `Bearer ${tok}` : tok,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ query, variables }),
	});
	const json = (await res.json()) as { data?: T; errors?: unknown };
	if (json.errors) {
		throw new Error(`linear: ${JSON.stringify(json.errors).slice(0, 200)}`);
	}
	return json.data as T;
}

const ISSUE_FIELDS = `id identifier title description url priority createdAt
  state { id name type } team { id key name }`;

export const linearPlugin = defineIntegration({
	slug: "linear",
	name: "Linear",
	endpoints: {
		"issues.list": endpoint(
			(ctx, args?: { first?: number; filter?: unknown }) =>
				gql<{ issues: { nodes: LinearIssue[] } }>(
					token(ctx.credentials),
					`query Issues($first: Int, $filter: IssueFilter) {
            issues(first: $first, filter: $filter) { nodes { ${ISSUE_FIELDS} } }
          }`,
					{ first: args?.first ?? 25, filter: args?.filter },
				).then((d) => ({ issues: d.issues.nodes })),
			{ riskLevel: "read", description: "List issues" },
		),
		"issues.get": endpoint(
			(ctx, args: { id: string }) =>
				gql<{ issue: LinearIssue }>(
					token(ctx.credentials),
					`query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
					{ id: args.id },
				).then((d) => d.issue),
			{ riskLevel: "read", description: "Get a single issue" },
		),
		"issues.create": endpoint(
			(
				ctx,
				args: {
					teamId: string;
					title: string;
					description?: string;
					assigneeId?: string;
					priority?: number;
				},
			) =>
				gql<{ issueCreate: { success: boolean; issue: LinearIssue } }>(
					token(ctx.credentials),
					`mutation IssueCreate($input: IssueCreateInput!) {
            issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
          }`,
					{ input: args },
				).then((d) => ({ issue: d.issueCreate.issue })),
			{ riskLevel: "write", description: "Create an issue" },
		),
		"issues.update": endpoint(
			(
				ctx,
				args: {
					id: string;
					title?: string;
					description?: string;
					stateId?: string;
				},
			) => {
				const { id, ...input } = args;
				return gql<{
					issueUpdate: { success: boolean; issue: LinearIssue };
				}>(
					token(ctx.credentials),
					`mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
          }`,
					{ id, input },
				).then((d) => ({ issue: d.issueUpdate.issue }));
			},
			{ riskLevel: "write", description: "Update an issue" },
		),
		"issues.delete": endpoint(
			(ctx, args: { id: string }) =>
				gql<{ issueDelete: { success: boolean } }>(
					token(ctx.credentials),
					"mutation IssueDelete($id: String!) { issueDelete(id: $id) { success } }",
					{ id: args.id },
				).then((d) => ({ success: d.issueDelete.success })),
			{
				riskLevel: "destructive",
				irreversible: true,
				description: "Delete an issue",
			},
		),
		"teams.list": endpoint(
			(ctx) =>
				gql<{ teams: { nodes: LinearTeam[] } }>(
					token(ctx.credentials),
					"query Teams { teams { nodes { id key name } } }",
				).then((d) => ({ teams: d.teams.nodes })),
			{ riskLevel: "read", description: "List teams" },
		),
		"users.viewer": endpoint(
			(ctx) =>
				gql<{ viewer: LinearUser }>(
					token(ctx.credentials),
					"query Viewer { viewer { id name email displayName } }",
				).then((d) => d.viewer),
			{ riskLevel: "read", description: "Get the authenticated user" },
		),
	},
	permissions: { mode: "cautious" },
	oauth: {
		type: "oauth2",
		authorizationUrl: "https://linear.app/oauth/authorize",
		tokenUrl: "https://api.linear.app/oauth/token",
		scopes: ["read", "write", "issues:create"],
	},
	verifyWebhookSignature: ({ headers }) =>
		"linear-signature" in headers ? "unknown" : "invalid",
});
