/**
 * Collaboration Verification API Endpoint
 *
 * Verifies JWT tokens from PartyKit connections and checks project access.
 * Called by the PartyKit document server to authenticate WebSocket connections.
 */

import {
	canEditProject,
	getDocumentById,
	hasProjectAccess,
} from "@repo/database";
import { jwtVerify } from "jose";
import { z } from "zod";
import { getLiveTokenSecretKey } from "../../lib/live-tokens";

const VerifySchema = z.object({
	documentId: z.string().min(1),
});

// Color palette for user cursors
const CURSOR_COLORS = [
	"#FF6B6B", // Red
	"#4ECDC4", // Teal
	"#45B7D1", // Sky Blue
	"#96CEB4", // Sage
	"#FFEAA7", // Yellow
	"#DDA0DD", // Plum
	"#98D8C8", // Mint
	"#F7DC6F", // Gold
	"#BB8FCE", // Lavender
	"#85C1E9", // Light Blue
];

/**
 * Generate a consistent color for a user based on their ID
 */
function generateUserColor(userId: string): string {
	const hash = userId.split("").reduce((a, b) => a + b.charCodeAt(0), 0);
	return CURSOR_COLORS[hash % CURSOR_COLORS.length] as string;
}

export async function POST(req: Request) {
	try {
		// Get the authorization header (JWT token from PartyKit)
		const authHeader = req.headers.get("authorization");
		const token = authHeader?.replace("Bearer ", "");

		if (!token) {
			return Response.json(
				{ error: "No token provided" },
				{ status: 401 },
			);
		}

		// Parse and validate request body
		const body = await req.json();
		const validation = VerifySchema.safeParse(body);

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

		// An unset secret must be a loud configuration error, not an implicit
		// deny: encoding undefined yields a zero-length key, and whether that
		// throws is a WebCrypto implementation detail this route must not
		// depend on.
		const secretKey = getLiveTokenSecretKey();
		if (!secretKey) {
			console.error("[Collab Verify] COLLAB_JWT_SECRET not configured");
			return Response.json(
				{ error: "Server configuration error" },
				{ status: 500 },
			);
		}

		try {
			// Pin the algorithm. This route deliberately does NOT pin an
			// audience — collab tokens live for an hour, so adding one would
			// 401 in-flight tokens during a rolling deploy. Cross-surface
			// confusion is instead prevented by claim shape: no other token
			// route may mint a `documentId` claim, and the orchestrator /
			// task-agent tokens carry their own `aud`.
			const { payload } = await jwtVerify(token, secretKey, {
				algorithms: ["HS256"],
			});

			// Validate token payload
			if (
				typeof payload.userId !== "string" ||
				typeof payload.documentId !== "string"
			) {
				return Response.json(
					{ error: "Invalid token payload" },
					{ status: 401 },
				);
			}

			// Ensure the token is for the correct document
			if (payload.documentId !== documentId) {
				return Response.json(
					{ error: "Token document mismatch" },
					{ status: 403 },
				);
			}

			const userId = payload.userId;
			const userName =
				typeof payload.userName === "string"
					? payload.userName
					: "Anonymous";
			const userImage =
				typeof payload.userImage === "string"
					? payload.userImage
					: undefined;

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
				userId,
			);
			if (!hasAccess) {
				return Response.json({ error: "Forbidden" }, { status: 403 });
			}

			// Check if user can edit
			const canEdit = await canEditProject(document.projectId, userId);

			// Generate a consistent color for this user
			const userColor = generateUserColor(userId);

			return Response.json({
				valid: true,
				userId,
				userName,
				userImage,
				userColor,
				canEdit,
				projectId: document.projectId,
			});
		} catch (jwtError) {
			console.error("[Collab Verify] JWT verification failed:", jwtError);
			return Response.json({ error: "Invalid token" }, { status: 401 });
		}
	} catch (error: unknown) {
		console.error("[Collab Verify] Error:", error);
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
