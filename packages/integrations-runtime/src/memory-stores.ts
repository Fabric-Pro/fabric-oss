import type {
	ApprovalStore,
	CredentialStore,
	PendingApproval,
} from "./types.js";

/**
 * In-memory implementation of `CredentialStore` for tests and Phase 3 plugin
 * development. Production deployments wire the portal's connector store.
 */
export class MemoryCredentialStore implements CredentialStore {
	private readonly store = new Map<string, Record<string, unknown>>();

	private key(tenantId: string, pluginSlug: string): string {
		return `${tenantId}::${pluginSlug}`;
	}

	set(
		tenantId: string,
		pluginSlug: string,
		credentials: Record<string, unknown>,
	): void {
		this.store.set(this.key(tenantId, pluginSlug), credentials);
	}

	async get(
		tenantId: string,
		pluginSlug: string,
	): Promise<Record<string, unknown> | undefined> {
		return this.store.get(this.key(tenantId, pluginSlug));
	}

	delete(tenantId: string, pluginSlug: string): void {
		this.store.delete(this.key(tenantId, pluginSlug));
	}
}

/**
 * In-memory `ApprovalStore` for tests. The portal swaps in a Prisma-backed
 * implementation that surfaces records in the existing approvals inbox.
 */
export class MemoryApprovalStore implements ApprovalStore {
	private readonly records = new Map<string, PendingApproval>();
	private counter = 0;

	async create(
		input: Omit<PendingApproval, "id" | "createdAt" | "status"> & {
			id?: string;
			createdAt?: string;
		},
	): Promise<PendingApproval> {
		this.counter += 1;
		const id =
			input.id ?? `appr_${Date.now().toString(36)}_${this.counter}`;
		const record: PendingApproval = {
			id,
			tenantId: input.tenantId,
			pluginSlug: input.pluginSlug,
			endpoint: input.endpoint,
			args: input.args,
			riskLevel: input.riskLevel,
			policy: input.policy,
			createdAt: input.createdAt ?? new Date().toISOString(),
			expiresAt: input.expiresAt,
			status: "pending",
		};
		this.records.set(id, record);
		return record;
	}

	async get(id: string): Promise<PendingApproval | undefined> {
		const record = this.records.get(id);
		if (!record) {
			return undefined;
		}
		if (
			record.status === "pending" &&
			Date.parse(record.expiresAt) < Date.now()
		) {
			record.status = "expired";
		}
		return record;
	}

	async resolve(
		id: string,
		decision: "approved" | "denied",
	): Promise<PendingApproval | undefined> {
		const record = this.records.get(id);
		if (!record) {
			return undefined;
		}
		if (record.status !== "pending") {
			return record;
		}
		record.status = decision;
		return record;
	}

	all(): PendingApproval[] {
		return [...this.records.values()];
	}
}
