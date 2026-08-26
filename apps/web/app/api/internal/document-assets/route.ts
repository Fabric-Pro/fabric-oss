/**
 * Internal Document Assets Endpoint
 *
 * Called by the project-document-generator LangGraph agent's tool_node when
 * the `write_document_asset` tool is invoked. Persists a non-markdown artifact
 * (HTML, SVG, binary) produced by an active Anthropic Agent Skill as a
 * ProjectDocumentAsset row, with the bytes in S3.
 *
 * Auth: Uses X-AI-Token JWT (same pattern as /api/internal/teams-search).
 * Body-based userId is not accepted — we take it from token claims.
 * Tenancy: the document's userId/organizationId must match the token's claims.
 */

import { createHash } from "node:crypto";
import { AI_TOKEN_HEADER, verifyAIToken } from "@repo/ai-token";
import { config } from "@repo/config";
import { db } from "@repo/database";
import { ensureBuckets, uploadFile } from "@repo/storage";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_ASSET_BYTES = 5 * 1024 * 1024; // 5 MB cap — plenty for HTML/SVG diagrams

// Basic allowlist to prevent arbitrary binary uploads. Extend as real skills need more.
const ALLOWED_CONTENT_TYPE_PREFIXES = [
	"text/",
	"application/json",
	"application/xml",
	"application/xhtml+xml",
	"application/svg+xml",
	"image/svg+xml",
	"image/png",
	"image/jpeg",
	"image/webp",
];

function isAllowedContentType(ct: string): boolean {
	const normalized = ct.toLowerCase();
	return ALLOWED_CONTENT_TYPE_PREFIXES.some((p) => normalized.startsWith(p));
}

function sanitizeFilename(name: string): string {
	// Strip any directory separators and control chars; keep a simple safe subset.
	const base = name.replace(/[/\\]/g, "_").trim();
	return base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200) || "asset";
}

export async function POST(req: Request) {
	try {
		const aiToken = req.headers.get(AI_TOKEN_HEADER);
		if (!aiToken) {
			return NextResponse.json(
				{ error: "Authentication required: X-AI-Token header missing" },
				{ status: 401 },
			);
		}

		const payload = await verifyAIToken(aiToken);
		if (!payload || !payload.valid) {
			return NextResponse.json(
				{ error: "Invalid AI token" },
				{ status: 401 },
			);
		}

		const tokenUserId = payload.claims.sub;
		const tokenOrgId = payload.claims.org;

		const body = (await req.json()) as {
			documentId?: string;
			filename?: string;
			contentType?: string;
			content?: string;
			encoding?: "utf-8" | "base64";
		};

		const {
			documentId,
			filename: rawFilename,
			contentType,
			content,
			encoding = "utf-8",
		} = body;

		if (!documentId || !rawFilename || !contentType || !content) {
			return NextResponse.json(
				{
					error: "Missing required fields: documentId, filename, contentType, content",
				},
				{ status: 400 },
			);
		}

		if (!isAllowedContentType(contentType)) {
			return NextResponse.json(
				{ error: `Content type "${contentType}" is not allowed` },
				{ status: 400 },
			);
		}

		// Verify the document exists AND is owned by the same tenant as the token.
		const doc = await db.projectDocument.findUnique({
			where: { id: documentId },
			select: {
				id: true,
				userId: true,
				organizationId: true,
			},
		});

		if (!doc) {
			return NextResponse.json(
				{ error: "Document not found" },
				{ status: 404 },
			);
		}

		// Strict XOR: an org token must target an org-scoped document, and a
		// personal token must target a personal-scoped document (organizationId
		// === null). Org project documents commonly carry both userId and
		// organizationId, so checking userId alone on the personal branch would
		// let a personal AI token attach assets to that user's org documents.
		const tokenOwnsDoc = tokenOrgId
			? doc.organizationId === tokenOrgId
			: doc.organizationId === null && doc.userId === tokenUserId;

		if (!tokenOwnsDoc) {
			return NextResponse.json(
				{ error: "Document does not belong to this tenant" },
				{ status: 403 },
			);
		}

		// Decode the payload into a buffer and enforce size cap.
		const buffer =
			encoding === "base64"
				? Buffer.from(content, "base64")
				: Buffer.from(content, "utf-8");

		if (buffer.byteLength > MAX_ASSET_BYTES) {
			return NextResponse.json(
				{
					error: `Asset too large: ${buffer.byteLength} bytes (max ${MAX_ASSET_BYTES})`,
				},
				{ status: 413 },
			);
		}

		const sha256 = createHash("sha256").update(buffer).digest("hex");
		const filename = sanitizeFilename(rawFilename);
		const bucket = config.storage.bucketNames.projectDocumentAssets;

		// Create the row first so we have a stable id for the S3 key,
		// then patch storageKey after upload.
		const asset = await db.projectDocumentAsset.create({
			data: {
				projectDocumentId: doc.id,
				filename,
				contentType,
				storageKey: "pending",
				sizeBytes: buffer.byteLength,
				sha256,
				userId: doc.userId,
				organizationId: doc.organizationId,
			},
		});

		const storageKey = `projectDocuments/${doc.id}/${asset.id}/${filename}`;

		try {
			await ensureBuckets([bucket]);
			await uploadFile(storageKey, buffer, { bucket, contentType });
		} catch (uploadErr) {
			// Roll back the row so we don't leave dangling metadata.
			await db.projectDocumentAsset
				.delete({ where: { id: asset.id } })
				.catch(() => {
					/* best-effort rollback */
				});
			throw uploadErr;
		}

		await db.projectDocumentAsset.update({
			where: { id: asset.id },
			data: { storageKey },
		});

		return NextResponse.json({
			assetId: asset.id,
			filename,
			sizeBytes: buffer.byteLength,
			contentType,
			sha256,
		});
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error("[Internal Document Assets] Error:", errorMessage);
		return NextResponse.json({ error: errorMessage }, { status: 500 });
	}
}
