/**
 * Orgs resource — /api/v1/orgs
 */

import type { FabricHttpClient } from "../client.js";
import type { FabricOrg } from "../types.js";

export class OrgsResource {
	constructor(private readonly http: FabricHttpClient) {}

	/** Lists all organizations the authenticated user belongs to. */
	list(): Promise<FabricOrg[]> {
		return this.http.get<FabricOrg[]>("/orgs");
	}
}
