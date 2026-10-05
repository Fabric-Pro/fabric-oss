"use client";

import { useTranslations } from "next-intl";
import { Fragment } from "react";

/**
 * Frontmatter keys the header already shows, as its heading, its
 * description, or a row of its own. Every other top-level key is shown as
 * written, so a Guild-shaped file's `owner`, `tags`, `status`, `since` and
 * `areas` (design 2026-09-23 §5.8) are readable in the tab.
 */
const HEADER_FIELD_KEYS = new Set([
	"name",
	"description",
	"argument-hint",
	"allowed-tools",
	"tools",
	"model",
	"paths",
	"disable-model-invocation",
]);

/** The frontmatter fields the header shows beyond its own rows, as written. */
export function extraFrontmatterFields(
	fields: Record<string, string>,
): Array<[string, string]> {
	return Object.entries(fields).filter(
		([key, value]) => !HEADER_FIELD_KEYS.has(key) && value.length > 0,
	);
}

function invocationLabel(
	fields: Record<string, string>,
	t: (key: string) => string,
): string | null {
	if (fields["disable-model-invocation"] === "true") {
		return t("invocationDisabled");
	}
	if ("disable-model-invocation" in fields) {
		return t("invocationAllowed");
	}
	return null;
}

/**
 * The header a skill or agent file's frontmatter becomes: its classified name
 * and description (`name`/`description`, set once at ingest rather than
 * re-derived from the block) over a row for each metadata key that has no
 * column of its own (`allowed-tools`, `model`, …).
 */
export function InstructionFileHeader({
	name,
	description,
	fields,
	extraFields,
}: {
	name: string | null;
	description: string | null;
	/** The parsed frontmatter, or null for a file that has none (or is not Markdown). */
	fields: Record<string, string> | null;
	extraFields: Array<[string, string]>;
}) {
	const t = useTranslations("projects.codingInstructions.fileView");
	const invocation = fields ? invocationLabel(fields, t) : null;
	return (
		<div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-4">
			{name ? <h2 className="font-semibold text-base">{name}</h2> : null}
			{description ? <p>{description}</p> : null}
			{fields ? (
				<dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
					{fields["argument-hint"] ? (
						<>
							<dt className="text-muted-foreground">
								{t("argumentHint")}
							</dt>
							<dd>{fields["argument-hint"]}</dd>
						</>
					) : null}
					{(fields["allowed-tools"] ?? fields.tools) ? (
						<>
							<dt className="text-muted-foreground">
								{t("allowedTools")}
							</dt>
							<dd>{fields["allowed-tools"] ?? fields.tools}</dd>
						</>
					) : null}
					{fields.model ? (
						<>
							<dt className="text-muted-foreground">
								{t("model")}
							</dt>
							<dd>{fields.model}</dd>
						</>
					) : null}
					{fields.paths ? (
						<>
							<dt className="text-muted-foreground">
								{t("appliesTo")}
							</dt>
							<dd className="whitespace-pre-line font-mono text-xs">
								{fields.paths}
							</dd>
						</>
					) : null}
					{invocation ? (
						<>
							<dt className="text-muted-foreground">
								{t("modelInvocation")}
							</dt>
							<dd>{invocation}</dd>
						</>
					) : null}
					{extraFields.map(([key, value]) => (
						<Fragment key={key}>
							<dt className="text-muted-foreground">{key}</dt>
							<dd className="whitespace-pre-line">{value}</dd>
						</Fragment>
					))}
				</dl>
			) : null}
		</div>
	);
}
