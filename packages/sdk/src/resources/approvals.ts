/**
 * ApprovalsResource — pending integration-approval inbox surface.
 *
 *   const pending = await fabric.approvals.list();
 *   await fabric.approvals.approve(pending[0].id);   // → runs the call
 *   await fabric.approvals.deny(otherId);
 *
 * Backed by the v1 routes added in Slice 2b
 * (GET /integrations/approvals, POST /integrations/approvals/:id/{approve,deny}).
 *
 * The IntegrationApproval row is created by the runtime when a call's
 * permission policy resolves to `require_approval` (cautious + destructive,
 * strict + write, etc.). Approving here both flips the row to "approved"
 * and immediately invokes the originally-requested operation through the
 * IntegrationExecutor, returning the upstream result envelope.
 */

import type { FabricHttpClient } from "../client.js";

/** Wire shape of an IntegrationApproval row from the v1 API. */
export interface PendingApproval {
	id: string;
	tenantId: string;
	pluginSlug: string;
	endpoint: string;
	args: unknown;
	riskLevel: "read" | "write" | "destructive";
	policy: "require_approval";
	createdAt: string;
	expiresAt: string;
	status: "pending" | "approved" | "denied" | "expired";
}

/** Result of executing a previously-approved record. */
export type ApprovalRunResult<T = unknown> =
	| { status: "ok"; data: T }
	| { status: "denied"; reason: string }
	| {
			status: "pending_approval";
			approvalId: string;
			expiresAt: string;
			riskLevel: "read" | "write" | "destructive";
	  };

export interface ListApprovalsOptions {
	status?: "pending" | "approved" | "denied" | "expired";
	limit?: number;
	org?: string;
	personal?: boolean;
}

export class ApprovalsResource {
	constructor(private readonly http: FabricHttpClient) {}

	/** List approvals (default `status=pending`) for the active tenant. */
	list(options: ListApprovalsOptions = {}): Promise<PendingApproval[]> {
		const params = new URLSearchParams();
		if (options.status) {
			params.set("status", options.status);
		}
		if (options.limit !== undefined) {
			params.set("limit", String(options.limit));
		}
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.get<PendingApproval[]>(
			`/integrations/approvals${qs ? `?${qs}` : ""}`,
		);
	}

	/**
	 * Approve a pending request. Flips the row to "approved" and immediately
	 * executes the originally-requested integration call, returning the
	 * upstream response envelope.
	 */
	approve<T = unknown>(id: string): Promise<ApprovalRunResult<T>> {
		return this.http.post<ApprovalRunResult<T>>(
			`/integrations/approvals/${encodeURIComponent(id)}/approve`,
			{},
		);
	}

	/** Deny a pending request. The integration call is discarded. */
	deny(id: string): Promise<PendingApproval> {
		return this.http.post<PendingApproval>(
			`/integrations/approvals/${encodeURIComponent(id)}/deny`,
			{},
		);
	}
}
