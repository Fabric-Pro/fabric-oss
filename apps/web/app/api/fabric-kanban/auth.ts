import { createHash } from "node:crypto";
import { verifyKanbanLaunchToken } from "@repo/api/modules/kanban/procedures/create-token";
import {
	canUpdateProjectStory,
	db,
	isOrganizationMember,
	resolveProjectAccess,
} from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";

export type KanbanAuthContext =
	| {
			type: "organization-key" | "personal-key";
			userId: string;
			organizationId: string | null;
			scopes: string[];
			scopeExempt: false;
	  }
	| {
			type: "launch-token";
			userId: string;
			organizationId: string;
			scopeExempt: true;
	  };

export type KanbanScope = "kanban:read" | "kanban:write";

export function requireKanbanScope(
	auth: KanbanAuthContext,
	requiredScope: KanbanScope,
): NextResponse | null {
	if (
		auth.scopeExempt ||
		auth.scopes.includes(requiredScope) ||
		auth.scopes.includes("*")
	) {
		return null;
	}
	const scopeSelection =
		requiredScope === "kanban:read"
			? "Kanban Read."
			: "Kanban Write. Read-only roles can select only Kanban Read.";

	return NextResponse.json(
		{
			error: `Missing required scope: ${requiredScope}. Go to your organization's Settings → API keys and create a new key with ${scopeSelection}`,
			code: "INSUFFICIENT_SCOPE",
		},
		{ status: 403 },
	);
}

export async function authenticateKanbanRequest(
	request: NextRequest,
	options: { allowLaunchToken: boolean },
): Promise<KanbanAuthContext | null> {
	const authHeader = request.headers.get("Authorization");
	if (!authHeader?.startsWith("Bearer ")) {
		return null;
	}

	const rawKey = authHeader.slice(7);
	const keyHash = createHash("sha256").update(rawKey).digest("hex");
	const validNow = {
		keyHash,
		isActive: true,
		OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
	};

	const organizationKey = await db.organizationApiKey.findFirst({
		where: validNow,
		select: {
			id: true,
			organizationId: true,
			createdByUserId: true,
			scopes: true,
		},
	});
	if (organizationKey) {
		if (
			!(await isOrganizationMember(
				organizationKey.createdByUserId,
				organizationKey.organizationId,
			))
		) {
			return null;
		}
		await db.organizationApiKey.update({
			where: { id: organizationKey.id },
			data: { lastUsedAt: new Date(), usageCount: { increment: 1 } },
		});
		return {
			type: "organization-key",
			userId: organizationKey.createdByUserId,
			organizationId: organizationKey.organizationId,
			scopes: organizationKey.scopes,
			scopeExempt: false,
		};
	}

	const personalKey = await db.userApiKey.findFirst({
		where: validNow,
		select: { id: true, userId: true, scopes: true },
	});
	if (personalKey) {
		await db.userApiKey.update({
			where: { id: personalKey.id },
			data: { lastUsedAt: new Date(), usageCount: { increment: 1 } },
		});
		return {
			type: "personal-key",
			userId: personalKey.userId,
			organizationId: null,
			scopes: personalKey.scopes,
			scopeExempt: false,
		};
	}

	if (!options.allowLaunchToken) {
		return null;
	}

	try {
		const claims = await verifyKanbanLaunchToken(rawKey);
		if (
			!claims.organizationId ||
			!(await isOrganizationMember(claims.sub, claims.organizationId))
		) {
			return null;
		}
		return {
			type: "launch-token",
			userId: claims.sub,
			organizationId: claims.organizationId,
			scopeExempt: true,
		};
	} catch {
		return null;
	}
}

function credentialNamesOrganization(
	auth: KanbanAuthContext,
	organizationId: string | null,
): organizationId is string {
	if (!organizationId) {
		return false;
	}
	return (
		auth.type === "personal-key" || auth.organizationId === organizationId
	);
}

export async function canReadKanbanProject(
	auth: KanbanAuthContext,
	project: { id: string; organizationId: string | null },
): Promise<boolean> {
	if (!credentialNamesOrganization(auth, project.organizationId)) {
		return false;
	}
	const access = await resolveProjectAccess(project.id, auth.userId);
	return (
		access?.organizationId === project.organizationId &&
		access.permissions.includes("story:read")
	);
}

export async function canUpdateKanbanProject(
	auth: KanbanAuthContext,
	project: { id: string; organizationId: string | null },
): Promise<boolean> {
	if (!credentialNamesOrganization(auth, project.organizationId)) {
		return false;
	}
	return await canUpdateProjectStory(project.id, auth.userId);
}

export function kanbanPermissionRefusal(message: string) {
	return NextResponse.json(
		{ error: message, code: "INSUFFICIENT_PERMISSION" },
		{ status: 403 },
	);
}
