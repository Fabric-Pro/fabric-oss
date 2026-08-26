/**
 * IntegrationsResource — single-namespace surface for calling any integration
 * the workspace has connected.
 *
 * Two access patterns, identical runtime behavior:
 *
 *   // Always works (generic). The `.call(operation, args)` form is the catch-all.
 *   await fabric.integrations.slack.call("messages.send",
 *     { channel: "#alerts", text: "hi" });
 *
 *   // After installing @fabricorg/integrations-slack:
 *   //   import "@fabricorg/integrations-slack";   // type augmentation only
 *   // the typed dot-path is also available — same runtime route.
 *   await fabric.integrations.slack.messages.send({
 *     channel: "#alerts",
 *     text: "hi",
 *   });
 *
 * Both compile down to the same backend call:
 *   POST /api/v1/integrations/slack/messages.send
 *
 * Typed plugin packages augment `interface FabricIntegrations` to add their
 * slug as a typed property. The runtime is a single Proxy and is unaware of
 * which slugs have typed packages installed.
 */

import type { FabricHttpClient } from "../client.js";

/** Metadata for a single integration the workspace has connected. */
export interface IntegrationConnection {
	slug: string;
	name: string;
	status: "connected" | "disconnected" | "error";
	mode: "open" | "cautious" | "strict" | "readonly";
	source: "plugin" | "mcp-server" | "connector";
}

/**
 * Augmentable map of slug → typed client. Plugin packages
 * (`@fabricorg/integrations-{slug}`) extend this via `declare module` so that
 * `fabric.integrations.<slug>` autocompletes vendor-specific endpoints.
 *
 * The runtime always provides a Proxy for any slug; the augmentation only
 * sharpens types.
 */
// biome-ignore lint/suspicious/noEmptyInterface: must be `interface` (not `type`) so plugin packages can augment via `declare module "@fabricorg/sdk"`. Empty by default.
export interface FabricIntegrations {
	// Plugins augment here, e.g.:
	//   declare module "@fabricorg/sdk" {
	//     interface FabricIntegrations { slack: SlackIntegrationClient; }
	//   }
}

/** The base shape every integration client carries (catch-all). */
export interface GenericIntegrationClient {
	/**
	 * Call any operation on this integration by dot-notation path. Always
	 * available, regardless of whether a typed plugin is installed.
	 */
	call<T = unknown>(operation: string, args?: unknown): Promise<T>;
}

const RESOURCE_BUILTINS = new Set(["list", "constructor", "then"]);

function makeDotPath(
	http: FabricHttpClient,
	slug: string,
	path: string[],
): unknown {
	// A function that, when called, posts to `/integrations/<slug>/<dotpath>`.
	// Wrapped in a Proxy so further property access continues building the path.
	const fn = (args?: unknown) =>
		http.post(`/integrations/${slug}/${path.join(".")}`, args ?? {});

	return new Proxy(fn, {
		get(target, prop) {
			if (prop in target || typeof prop !== "string") {
				return Reflect.get(target, prop);
			}
			return makeDotPath(http, slug, [...path, prop]);
		},
	});
}

function makeIntegrationClient(
	http: FabricHttpClient,
	slug: string,
): GenericIntegrationClient {
	const base: GenericIntegrationClient = {
		call: <T = unknown>(operation: string, args?: unknown) =>
			http.post<T>(`/integrations/${slug}/${operation}`, args ?? {}),
	};
	return new Proxy(base, {
		get(target, prop) {
			if (prop in target || typeof prop !== "string") {
				return Reflect.get(target, prop);
			}
			return makeDotPath(http, slug, [prop]);
		},
	}) as GenericIntegrationClient;
}

class IntegrationsResourceBase {
	constructor(protected readonly http: FabricHttpClient) {}

	/** List integrations the workspace has connected. */
	list(): Promise<IntegrationConnection[]> {
		return this.http.get<IntegrationConnection[]>("/integrations");
	}
}

/**
 * Public type for `fabric.integrations`. Combines the base resource methods
 * with all augmented vendor clients. Plugin packages augment
 * `FabricIntegrations` to add typed slugs.
 */
export type IntegrationsResource = IntegrationsResourceBase & {
	[K in keyof FabricIntegrations]: FabricIntegrations[K] &
		GenericIntegrationClient;
} & {
	/** Catch-all: any slug not explicitly augmented falls back to the generic client. */
	[slug: string]: GenericIntegrationClient | unknown;
};

/** Internal factory — invoked by FabricClient. Not for direct consumer use. */
export function createIntegrationsResource(
	http: FabricHttpClient,
): IntegrationsResource {
	const base = new IntegrationsResourceBase(http);
	return new Proxy(base, {
		get(target, prop) {
			// Built-in resource methods take precedence.
			if (
				prop in target ||
				typeof prop !== "string" ||
				RESOURCE_BUILTINS.has(prop)
			) {
				return Reflect.get(target, prop);
			}
			return makeIntegrationClient(http, prop);
		},
	}) as IntegrationsResource;
}
