"use client";

/**
 * DocumentAssetFrame
 *
 * Renders a single ProjectDocumentAsset inline:
 *   - For text/html: sandboxed iframe via srcDoc (no JS; CSP meta prepended).
 *   - For image/*: plain <img>.
 *   - For everything else: a download button.
 *
 * Used by the document viewer to show artifacts produced by Anthropic Agent
 * Skills (e.g. the architecture-diagram skill emits a self-contained HTML file
 * via the write_document_asset tool).
 */

import { Button } from "@ui/components/button";
import { Download, ExternalLink } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export interface DocumentAsset {
	id: string;
	filename: string;
	contentType: string;
	sizeBytes: number;
	sha256: string;
	downloadUrl: string;
}

interface Props {
	asset: DocumentAsset;
}

/**
 * Inline CSP for rendered HTML artifacts. Allows inline styles + Google Fonts
 * (the Cocoon-AI architecture-diagram template's only external need) and
 * nothing else — no scripts, no iframes, no network beyond fonts.
 */
const ASSET_CSP =
	"default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; form-action 'none'";

function DocumentAssetFrame({ asset }: Props) {
	const [htmlSrcDoc, setHtmlSrcDoc] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	const isHtml = asset.contentType.toLowerCase().startsWith("text/html");
	const isImage = asset.contentType.toLowerCase().startsWith("image/");

	// Signed `downloadUrl` is re-generated on every listAssets poll, so we
	// gate the fetch on (id + sha256) to avoid re-downloading identical bytes
	// whenever the URL rotates. The URL itself is read via ref at fetch time.
	const downloadUrlRef = useRef(asset.downloadUrl);
	downloadUrlRef.current = asset.downloadUrl;

	useEffect(() => {
		if (!isHtml) {
			return;
		}
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(downloadUrlRef.current);
				if (!res.ok) {
					throw new Error(`HTTP ${res.status}`);
				}
				const body = await res.text();
				if (cancelled) {
					return;
				}
				setHtmlSrcDoc(injectCsp(body));
			} catch (err) {
				if (!cancelled) {
					setLoadError(
						err instanceof Error ? err.message : "Unknown error",
					);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [asset.id, asset.sha256, isHtml]);

	const sizeLabel = useMemo(
		() => formatSize(asset.sizeBytes),
		[asset.sizeBytes],
	);

	return (
		<section className="mt-8 rounded-md border border-border bg-card">
			<header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
				<div className="flex min-w-0 flex-col">
					<span className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
						Generated Artifact
					</span>
					<span className="truncate text-sm font-medium text-foreground">
						{asset.filename}
					</span>
				</div>
				<div className="flex items-center gap-2 text-xs text-muted-foreground">
					<span className="hidden sm:inline">{sizeLabel}</span>
					<Button
						asChild
						variant="ghost"
						size="sm"
						className="h-8 px-2"
					>
						<a
							href={asset.downloadUrl}
							target="_blank"
							rel="noopener noreferrer"
						>
							<ExternalLink className="h-3.5 w-3.5" />
							<span className="sr-only">Open in new tab</span>
						</a>
					</Button>
					<Button
						asChild
						variant="ghost"
						size="sm"
						className="h-8 px-2"
					>
						<a href={asset.downloadUrl} download={asset.filename}>
							<Download className="h-3.5 w-3.5" />
							<span className="sr-only">Download</span>
						</a>
					</Button>
				</div>
			</header>

			<div className="p-4">
				{isHtml && htmlSrcDoc && (
					<iframe
						// sandbox WITHOUT allow-scripts for defence-in-depth.
						// The Cocoon-AI architecture-diagram template is pure HTML + CSS.
						sandbox="allow-same-origin"
						srcDoc={htmlSrcDoc}
						title={`Asset: ${asset.filename}`}
						className="h-[640px] w-full rounded border border-border bg-background"
					/>
				)}
				{isHtml && !htmlSrcDoc && !loadError && (
					<div className="flex h-[640px] items-center justify-center text-sm text-muted-foreground">
						Loading artifact…
					</div>
				)}
				{isHtml && loadError && (
					<div className="flex h-[120px] items-center justify-center text-sm text-destructive">
						Failed to load artifact: {loadError}
					</div>
				)}

				{isImage && (
					<img
						src={asset.downloadUrl}
						alt={asset.filename}
						className="max-h-[640px] w-auto rounded border border-border"
					/>
				)}

				{!isHtml && !isImage && (
					<div className="flex items-center justify-between rounded border border-dashed border-border p-4 text-sm text-muted-foreground">
						<span>
							{asset.contentType} artifact — preview unavailable.
						</span>
					</div>
				)}
			</div>
		</section>
	);
}

/**
 * Renders the full list of ProjectDocumentAssets for a document. Expects the
 * caller to have queried `orpc.projects.documents.listAssets`.
 */
export function DocumentAssetsPanel({ assets }: { assets: DocumentAsset[] }) {
	if (assets.length === 0) {
		return null;
	}
	return (
		<div className="mt-6 space-y-6">
			{assets.map((asset) => (
				<DocumentAssetFrame key={asset.id} asset={asset} />
			))}
		</div>
	);
}

function injectCsp(html: string): string {
	const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${ASSET_CSP}">`;
	// Insert right after <head>, or prepend a synthetic head if missing.
	if (/<head[^>]*>/i.test(html)) {
		return html.replace(/<head([^>]*)>/i, `<head$1>\n${cspMeta}`);
	}
	if (/<html[^>]*>/i.test(html)) {
		return html.replace(
			/<html([^>]*)>/i,
			`<html$1><head>${cspMeta}</head>`,
		);
	}
	return `<!doctype html><html><head>${cspMeta}</head><body>${html}</body></html>`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
