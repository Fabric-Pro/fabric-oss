"use client";

import { type RefObject, useEffect, useState } from "react";
import type {
	FrameEmbedToHostMessage,
	FrameHostToEmbedMessage,
} from "../lib/frame-embed-protocol";
import { downloadHref } from "../lib/download-file";

type EmbedRequest = (
	message: FrameHostToEmbedMessage,
) => Promise<FrameEmbedToHostMessage>;

function newRequestId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The shell's "Export" and "Code" actions: a PNG of the page (asked of the
 * embed, with a local capture when it does not answer), a PDF made from that
 * PNG, and the frame's JSON.
 */
export function useFrameExport({
	title,
	kind,
	codeView,
	iframeRef,
	requestFromEmbed,
	resetKey,
}: {
	title: string;
	kind: "frame" | "slideshow";
	/** The frame's JSON, as shown in the code view; absent when it is not known. */
	codeView: string | null;
	iframeRef: RefObject<HTMLIFrameElement | null>;
	requestFromEmbed: EmbedRequest;
	/** A change of this clears the notice left by the last export. */
	resetKey: string;
}) {
	const [isExporting, setIsExporting] = useState<null | "png" | "pdf">(null);
	const [exportNotice, setExportNotice] = useState<string | null>(null);

	useEffect(() => {
		setExportNotice(null);
	}, [resetKey]);

	const captureIframeFallback = async () => {
		const doc = iframeRef.current?.contentDocument;
		if (!doc?.body) {
			throw new Error("Frame content is not ready yet.");
		}
		const { default: html2canvasLib } = await import("html2canvas");
		const canvas = await html2canvasLib(doc.body, {
			backgroundColor: "#ffffff",
			useCORS: true,
			scale: window.devicePixelRatio > 1 ? 2 : 1,
		});
		return canvas.toDataURL("image/png");
	};

	const requestPngExport = async () => {
		try {
			const result = await requestFromEmbed({
				type: "fabric-frame:request-export-png",
				requestId: newRequestId(),
			});
			if (
				result.type !== "fabric-frame:export-png-result" ||
				result.error ||
				!result.dataUrl
			) {
				throw new Error("Frame export failed");
			}
			setExportNotice(null);
			return result.dataUrl;
		} catch {
			setExportNotice(
				"Used local fallback export because the embed RPC did not respond.",
			);
			return await captureIframeFallback();
		}
	};

	const exportJson = () => {
		if (!codeView) {
			return;
		}
		const url = URL.createObjectURL(
			new Blob([codeView], { type: "application/json" }),
		);
		downloadHref(url, `${title || "frame"}.frame.json`);
		URL.revokeObjectURL(url);
	};

	const exportPng = async () => {
		setIsExporting("png");
		try {
			downloadHref(await requestPngExport(), `${title || "frame"}.png`);
		} finally {
			setIsExporting(null);
		}
	};

	const exportPdf = async () => {
		setIsExporting("pdf");
		try {
			const dataUrl = await requestPngExport();
			const image = new Image();
			await new Promise((resolve, reject) => {
				image.onload = resolve;
				image.onerror = reject;
				image.src = dataUrl;
			});
			const { default: JsPDF } = await import("jspdf");
			const pdf = new JsPDF({
				orientation: kind === "slideshow" ? "landscape" : "portrait",
				unit: "px",
				format: [image.width, image.height],
			});
			pdf.addImage(dataUrl, "PNG", 0, 0, image.width, image.height);
			pdf.save(`${title || "frame"}.pdf`);
		} finally {
			setIsExporting(null);
		}
	};

	return { isExporting, exportNotice, exportPng, exportPdf, exportJson };
}
