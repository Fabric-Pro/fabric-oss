/**
 * Collaboration Token API Endpoint
 *
 * Generates a short-lived JWT token for PartyKit WebSocket connections.
 * The token includes user info and the document ID for verification.
 */

import { auth } from "@repo/auth";
import {
	canEditProject,
	getDocumentById,
	hasProjectAccess,
} from "@repo/database";
import { SignJWT } from "jose";
import { headers } from "next/headers";
import { z } from "zod";

const TokenRequestSchema = z.object({
	documentId: z.string().min(1),
});

export async function POST(req: Request) {
	try {
		// Get user session
		const headersList = await headers();
		const session = await auth.api.getSession({
			headers: headersList,
		});

		if (!session?.user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		// Parse and validate request body
		const body = await req.json();
		const validation = TokenRequestSchema.safeParse(body);

		if (!validation.success) {
			return Response.json(
				{
					error: "Invalid request",
					details: validation.error.issues,
				},
				{ status: 400 },
			);
		}

		const { documentId } = validation.data;

		// Get the document to find its project
		const document = await getDocumentById(documentId);
		if (!document) {
			return Response.json(
				{ error: "Document not found" },
				{ status: 404 },
			);
		}

		// Verify project access
		const hasAccess = await hasProjectAccess(
			document.projectId,
			session.user.id,
		);
		if (!hasAccess) {
			return Response.json({ error: "Forbidden" }, { status: 403 });
		}

		// Check if user can edit (for token payload)
		const canEdit = await canEditProject(
			document.projectId,
			session.user.id,
		);

		// Get the JWT secret
		const secret = process.env.COLLAB_JWT_SECRET;
		if (!secret) {
			console.error("[Collab Token] COLLAB_JWT_SECRET not configured");
			return Response.json(
				{ error: "Server configuration error" },
				{ status: 500 },
			);
		}

		// Create short-lived token for PartyKit connection
		const secretKey = new TextEncoder().encode(secret);
		const token = await new SignJWT({
			userId: session.user.id,
			userName: session.user.name || "Anonymous",
			userImage: session.user.image || undefined,
			documentId,
			projectId: document.projectId,
			canEdit,
		})
			.setProtectedHeader({ alg: "HS256" })
			.setIssuedAt()
			.setExpirationTime("1h") // Token expires in 1 hour
			.sign(secretKey);

		return Response.json({
			token,
			expiresIn: 3600, // 1 hour in seconds
		});
	} catch (error: unknown) {
		console.error("[Collab Token] Error:", error);
		return Response.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Internal server error",
			},
			{ status: 500 },
		);
	}
}

export const runtime = "nodejs";
