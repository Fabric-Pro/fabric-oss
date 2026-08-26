/**
 * Auth resource — /api/v1/auth/*
 */

import type { FabricHttpClient } from "../client.js";
import type {
	FabricApiKey,
	FabricApiKeyCreated,
	WhoamiResult,
} from "../types.js";

export interface CreateKeyOptions {
	name: string;
	scopes?: string[];
	/** Days until expiry (1–365). Omit for no expiry. */
	expiresInDays?: number;
}

export class AuthResource {
	constructor(private readonly http: FabricHttpClient) {}

	/** Returns the authenticated identity, key metadata, and org memberships. */
	whoami(): Promise<WhoamiResult> {
		return this.http.get<WhoamiResult>("/auth/whoami");
	}

	/** Lists API keys owned by the authenticated user (no raw keys). */
	listKeys(): Promise<FabricApiKey[]> {
		return this.http.get<FabricApiKey[]>("/auth/keys");
	}

	/**
	 * Creates a new API key. Returns the raw key exactly once —
	 * store it immediately; it cannot be retrieved again.
	 */
	createKey(options: CreateKeyOptions): Promise<FabricApiKeyCreated> {
		return this.http.post<FabricApiKeyCreated>("/auth/keys", options);
	}

	/** Permanently revokes an API key by ID. */
	revokeKey(id: string): Promise<{ id: string; deleted: boolean }> {
		return this.http.delete<{ id: string; deleted: boolean }>(
			`/auth/keys/${id}`,
		);
	}
}
