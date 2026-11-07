"use client";
import {
	frameAuthoringDocumentSchema,
	frameTemplateVariableSchema,
} from "@repo/utils/frame-authoring";
import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import {
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { z } from "zod";
import { FrameRenderer } from "./FrameRenderer";

export function FrameAuthoringPanel({
	onBack,
	onCreated,
	onTemplateCreated,
}: {
	onBack: () => void;
	onCreated: (id: string) => void;
	onTemplateCreated: () => void;
}) {
	const t = useTranslations("frameAuthoring");
	const organizationId = useOrganizationId();
	const [title, setTitle] = useState("");
	const [content, setContent] = useState("");
	const [type, setType] = useState<"markdown" | "html" | "json" | "mermaid">(
		"markdown",
	);
	const [template, setTemplate] = useState(false);
	const [category, setCategory] = useState("General");
	const [variables, setVariables] = useState("{}");
	const [audience, setAudience] = useState(false);
	const [preview, setPreview] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [validation, setValidation] = useState<string | null>(null);
	const request = useRef<{ key: string; id: string } | null>(null);
	const document = {
		title,
		kind: "frame" as const,
		presentation: "DOCUMENT" as const,
		blocks: [{ id: "main", type, content }],
	};
	const check = async () => {
		if (!organizationId) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const result = await orpcClient.frames.validateDocument({
				organizationId,
				document,
			});
			setValidation(t(result.canSave ? "valid" : "invalid"));
		} catch {
			setValidation(t("invalid"));
		} finally {
			setBusy(false);
		}
	};
	const save = async () => {
		if (!organizationId) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const authored = frameAuthoringDocumentSchema.parse(document);
			const fields = z
				.record(z.string(), frameTemplateVariableSchema)
				.parse(JSON.parse(variables));
			const body = template
				? {
						name: title,
						category,
						content: authored,
						variables: fields,
						confirmOrganizationAudience: audience,
					}
				: { ...authored };
			const key = JSON.stringify([organizationId, template, body]);
			if (request.current?.key !== key) {
				request.current = { key, id: crypto.randomUUID() };
			}
			if (template) {
				if (!audience) {
					throw new Error(t("confirmAudience"));
				}
				await orpcClient.frames.createTemplate({
					organizationId,
					requestId: request.current.id,
					name: title,
					category,
					content: authored,
					variables: fields,
					confirmOrganizationAudience: true,
				});
				onTemplateCreated();
			} else {
				const frame = await orpcClient.frames.create({
					organizationId,
					requestId: request.current.id,
					...authored,
				});
				onCreated(frame.id);
			}
		} catch (e) {
			setError(
				e instanceof z.ZodError || e instanceof SyntaxError
					? t("invalid")
					: t("failed"),
			);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex max-h-[85dvh] flex-col">
			<DialogHeader className="px-6 pt-6">
				<DialogTitle>{t("heading")}</DialogTitle>
				<DialogDescription>{t("intro")}</DialogDescription>
			</DialogHeader>
			<div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
				<div className="space-y-2">
					<Label htmlFor="frame-author-title">{t("title")}</Label>
					<Input
						id="frame-author-title"
						value={title}
						onChange={(e) => {
							setTitle(e.target.value);
							setValidation(null);
						}}
						maxLength={200}
						disabled={busy}
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="frame-author-format">{t("format")}</Label>
					<Select
						value={type}
						onValueChange={(v) => {
							setType(v as typeof type);
							setPreview(false);
							setValidation(null);
						}}
						disabled={busy}
					>
						<SelectTrigger id="frame-author-format">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{["markdown", "html", "json", "mermaid"].map(
								(v) => (
									<SelectItem key={v} value={v}>
										{v === "markdown"
											? "Markdown"
											: v === "html"
												? "HTML"
												: v === "json"
													? "JSON"
													: "Mermaid"}
									</SelectItem>
								),
							)}
						</SelectContent>
					</Select>
				</div>
				<div className="space-y-2">
					<Label htmlFor="frame-author-content">{t("content")}</Label>
					<Textarea
						id="frame-author-content"
						className="min-h-48 font-mono text-sm"
						value={content}
						onChange={(e) => {
							setContent(e.target.value);
							setValidation(null);
						}}
						disabled={busy}
						maxLength={900000}
					/>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button
						variant="outline"
						onClick={() => setPreview((v) => !v)}
						disabled={!title.trim() || busy}
					>
						{t(preview ? "hidePreview" : "preview")}
					</Button>
					<Button
						variant="outline"
						disabled={busy || !title.trim() || !content}
						onClick={check}
					>
						{t("validate")}
					</Button>
				</div>
				{preview && (
					<div className="rounded-md border border-border p-3">
						<p className="mb-3 text-xs text-muted-foreground">
							{t("static")}
						</p>
						<FrameRenderer
							frame={{ version: 1, ...document }}
							allowScripts={false}
						/>
					</div>
				)}
				{validation && (
					<p role="status" className="text-sm">
						{validation}
					</p>
				)}
				<label className="flex items-start gap-2 text-sm">
					<input
						type="checkbox"
						checked={template}
						onChange={(e) => {
							setTemplate(e.target.checked);
							setAudience(false);
						}}
						disabled={busy}
						className="mt-1 accent-primary"
					/>
					{t("reusable")}
				</label>
				{template && (
					<div className="space-y-4 border-t border-border pt-4">
						<p className="text-sm text-muted-foreground">
							{t("audience")}
						</p>
						<div className="space-y-2">
							<Label htmlFor="frame-author-category">
								{t("category")}
							</Label>
							<Input
								id="frame-author-category"
								value={category}
								onChange={(e) => setCategory(e.target.value)}
								disabled={busy}
							/>
						</div>
						<details>
							<summary className="cursor-pointer text-sm font-medium">
								{t("inputs")}
							</summary>
							<p className="my-2 text-sm text-muted-foreground">
								{t("inputHelp")}
							</p>
							<Label
								htmlFor="frame-author-variables"
								className="sr-only"
							>
								{t("inputs")}
							</Label>
							<Textarea
								id="frame-author-variables"
								className="min-h-32 font-mono text-sm"
								value={variables}
								onChange={(e) => setVariables(e.target.value)}
								disabled={busy}
							/>
						</details>
						<label className="flex items-start gap-2 text-sm">
							<input
								type="checkbox"
								checked={audience}
								onChange={(e) => setAudience(e.target.checked)}
								disabled={busy}
								className="mt-1 accent-primary"
							/>
							{t("confirmAudience")}
						</label>
					</div>
				)}
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
			</div>
			<div className="flex shrink-0 flex-wrap justify-between gap-2 border-t border-border p-4">
				<Button variant="outline" disabled={busy} onClick={onBack}>
					{t("back")}
				</Button>
				<Button
					disabled={
						busy ||
						!organizationId ||
						!title.trim() ||
						!content ||
						(template && (!audience || !category.trim()))
					}
					onClick={save}
				>
					{t(busy ? "saving" : template ? "saveTemplate" : "create")}
				</Button>
			</div>
		</div>
	);
}
