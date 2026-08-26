const VALID_FILE_TYPES = new Set([
	"DOCUMENT",
	"CODE",
	"DATA",
	"OUTPUT",
	"ARTIFACT",
] as const);

const VALID_FRAME_FORMATS = new Set(["html", "json", "mermaid"] as const);

type FabricFileType = "DOCUMENT" | "CODE" | "DATA" | "OUTPUT" | "ARTIFACT";
type FabricFrameFormat = "html" | "json" | "mermaid";

type FileValidationResult =
	| {
			ok: true;
			value: {
				name: string;
				content: string;
				fileType: FabricFileType;
			};
	  }
	| { ok: false; error: string };

type FrameComponent = {
	type: string;
	label: string;
	position?: {
		x?: number;
		y?: number;
		w?: number;
		h?: number;
	};
};

type FrameValidationResult =
	| {
			ok: true;
			value: {
				title: string;
				description: string;
				components: FrameComponent[];
				format: FabricFrameFormat;
			};
	  }
	| { ok: false; error: string };

function getStringArg(
	args: Record<string, unknown> | undefined,
	keys: string[],
): string | undefined {
	if (!args) {
		return undefined;
	}

	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (trimmed.length > 0) {
				return trimmed;
			}
		}
	}

	return undefined;
}

function getRawStringArg(
	args: Record<string, unknown> | undefined,
	keys: string[],
): string | undefined {
	if (!args) {
		return undefined;
	}

	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}

	return undefined;
}

function normalizeFrameComponents(value: unknown): FrameComponent[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.flatMap((item) => {
		if (!item || typeof item !== "object") {
			return [];
		}

		const record = item as Record<string, unknown>;
		const type =
			typeof record.type === "string" && record.type.trim().length > 0
				? record.type.trim()
				: "component";
		const label =
			typeof record.label === "string" && record.label.trim().length > 0
				? record.label.trim()
				: typeof record.name === "string" &&
						record.name.trim().length > 0
					? record.name.trim()
					: type;
		const position =
			record.position && typeof record.position === "object"
				? (record.position as FrameComponent["position"])
				: undefined;

		return [{ type, label, position }];
	});
}

export function validateFabricCreateFileInput(
	args: Record<string, unknown> | undefined,
	options?: { fallbackContent?: string },
): FileValidationResult {
	const name = getStringArg(args, ["name", "fileName", "filename"]);
	const content =
		getRawStringArg(args, ["content", "body", "text"]) ||
		options?.fallbackContent ||
		"";
	const rawFileType = getStringArg(args, ["fileType"]);
	const fileType = VALID_FILE_TYPES.has((rawFileType || "") as FabricFileType)
		? ((rawFileType as FabricFileType) ?? "DOCUMENT")
		: "DOCUMENT";

	if (!name) {
		return {
			ok: false,
			error: "File name is required. Provide `name` (for example, 'report.md').",
		};
	}

	if (!content) {
		return {
			ok: false,
			error: "File content is required. Provide `content` with the text to save.",
		};
	}

	return {
		ok: true,
		value: {
			name,
			content,
			fileType,
		},
	};
}

export function validateFabricCreateFrameInput(
	args: Record<string, unknown> | undefined,
): FrameValidationResult {
	const title = getStringArg(args, ["title", "frameTitle", "name"]);
	const description =
		getRawStringArg(args, ["description", "prompt", "summary"]) || "";
	const components = normalizeFrameComponents(args?.components);
	const rawFormat = getStringArg(args, ["format"]);
	const format = VALID_FRAME_FORMATS.has(
		(rawFormat || "") as FabricFrameFormat,
	)
		? ((rawFormat as FabricFrameFormat) ?? "html")
		: "html";

	if (!title) {
		return {
			ok: false,
			error: "Frame title is required. Provide `title` describing the frame to create.",
		};
	}

	return {
		ok: true,
		value: {
			title,
			description,
			components,
			format,
		},
	};
}

export function buildFabricFramePrompt(input: {
	title: string;
	description: string;
	components: FrameComponent[];
	format: FabricFrameFormat;
}): string {
	const { title, description, components, format } = input;
	const componentsDescription =
		components.length > 0
			? `\n\nComponents to include:\n${components.map((component) => `- ${component.type}: ${component.label}`).join("\n")}`
			: "";

	return (
		`Create a ${format === "html" ? "self-contained HTML wireframe" : format === "json" ? "JSON wireframe specification" : "Mermaid diagram"} ` +
		`for: "${title}"\n\n${description}${componentsDescription}\n\n` +
		(format === "html"
			? "Output ONLY the complete HTML document, no explanation. Use simple, clean wireframe styles with gray borders and placeholder content."
			: format === "json"
				? "Output ONLY valid JSON, no explanation. Use a structure with title, description, and components array."
				: "Output ONLY the Mermaid diagram code, no explanation.")
	);
}

export function buildFallbackFrameContent(input: {
	title: string;
	description: string;
	components: FrameComponent[];
	format: FabricFrameFormat;
}): string {
	const { title, description, components, format } = input;

	if (format === "json") {
		return JSON.stringify(
			{
				title,
				description,
				components,
			},
			null,
			2,
		);
	}

	if (format === "mermaid") {
		const nodes = components.length
			? components
					.map(
						(component, index) =>
							`    A --> N${index}[${component.type}: ${component.label}]`,
					)
					.join("\n")
			: "    A --> B[Wireframe placeholder]";
		return `graph TD\n    A[${title}]\n${nodes}`;
	}

	return (
		`<!DOCTYPE html><html><head><title>${title}</title>` +
		"<style>body{font-family:sans-serif;max-width:800px;margin:0 auto;padding:20px}" +
		".component{border:2px dashed #ccc;padding:16px;margin:8px;border-radius:4px;color:#666}</style></head>" +
		`<body><h1>${title}</h1><p>${description}</p>` +
		`${components.map((component) => `<div class="component">[${component.type}] ${component.label}</div>`).join("")}` +
		"</body></html>"
	);
}

export function detectFabricFileMimeType(fileName: string): string {
	if (fileName.endsWith(".md")) {
		return "text/markdown";
	}
	if (fileName.endsWith(".html")) {
		return "text/html";
	}
	if (fileName.endsWith(".json")) {
		return "application/json";
	}
	return "text/plain";
}

export async function createFabricWorkspaceFile(input: {
	name: string;
	content: string;
	fileType: FabricFileType;
	userId: string;
	organizationId?: string;
	logWarning?: (message: string, error: unknown) => void;
}): Promise<{
	fileId: string;
	name: string;
	path: string;
	mimeType: string;
	response: string;
}> {
	const { uploadFile, buildTenantStoragePath } = await import(
		"@repo/storage"
	);
	const { db } = await import("@repo/database");

	const fileBuffer = Buffer.from(input.content, "utf-8");
	const mimeType = detectFabricFileMimeType(input.name);
	// Tenant-isolated path (F-099): org files land under the organizationId
	// prefix and personal files under the userId prefix (XOR), instead of
	// always keying by userId — which leaked org workspace files under a user
	// prefix. Existing files keep their stored path; only new files move.
	const storagePath = buildTenantStoragePath({
		organizationId: input.organizationId,
		userId: input.userId,
		sub: `workspace-files/${Date.now()}-${input.name}`,
	});

	await uploadFile(storagePath, fileBuffer, {
		bucket:
			process.env.NEXT_PUBLIC_CHAT_DOCUMENTS_BUCKET_NAME ||
			"chat-documents",
		contentType: mimeType,
	});

	try {
		const fileExtension = input.name.includes(".")
			? input.name.split(".").pop()
			: undefined;
		await db.agentWorkspaceFile.create({
			data: {
				name: input.name,
				path: storagePath,
				extension: fileExtension,
				mimeType,
				content: input.content,
				size: fileBuffer.length,
				fileType: input.fileType,
				userId: input.userId,
				organizationId: input.organizationId ?? null,
			},
		});
	} catch (error) {
		input.logWarning?.("Could not create AgentWorkspaceFile record", error);
	}

	return {
		fileId: `file_${Date.now()}`,
		name: input.name,
		path: storagePath,
		mimeType,
		response: `File "${input.name}" created successfully.`,
	};
}

export async function createFabricFrame(input: {
	title: string;
	description: string;
	components: FrameComponent[];
	format: FabricFrameFormat;
	userId: string;
	organizationId?: string;
}): Promise<{
	frameId: string;
	content: string;
	format: FabricFrameFormat;
	path: string;
	previewUrl?: string;
	response: string;
}> {
	const { getAIModelWithMetadata } = await import("@repo/ai");
	const { computeMaxOutputTokenBudget } = await import(
		"@repo/ai/lib/output-token-budget"
	);
	const { generateText } = await import("ai");
	const { uploadFile } = await import("@repo/storage");

	const prompt = buildFabricFramePrompt(input);
	let content = "";

	try {
		const { model, metadata } = await getAIModelWithMetadata(
			{ taskType: "COMPLEX" },
			{
				userId: input.userId,
				organizationId: input.organizationId,
			},
		);

		const systemContent =
			input.format === "html"
				? "You are a wireframe generator. Output ONLY complete, self-contained HTML documents. No explanation, no markdown, no code fences. Use simple wireframe styles: gray borders, placeholder content, clean layout."
				: input.format === "json"
					? "You are a wireframe specification generator. Output ONLY valid JSON. No explanation, no code fences."
					: "You are a Mermaid diagram generator. Output ONLY valid Mermaid diagram code. No explanation, no code fences.";

		// Whole HTML/JSON/Mermaid document from a short prompt — maximal mode.
		const maxOutputTokens = computeMaxOutputTokenBudget(metadata, {
			promptChars: systemContent.length + prompt.length,
		});

		const result = await generateText({
			model,
			messages: [
				{ role: "system", content: systemContent },
				{ role: "user", content: prompt },
			],
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		});
		content = result.text?.trim() || "";
	} catch {
		content = "";
	}

	if (!content) {
		content = buildFallbackFrameContent(input);
	}

	const frameId = `frame_${Date.now()}`;
	const extension =
		input.format === "html"
			? "html"
			: input.format === "json"
				? "json"
				: "md";
	const mimeType =
		input.format === "html"
			? "text/html"
			: input.format === "json"
				? "application/json"
				: "text/plain";
	const path = `frames/${input.userId}/${frameId}.${extension}`;

	await uploadFile(path, Buffer.from(content, "utf-8"), {
		bucket:
			process.env.NEXT_PUBLIC_CHAT_DOCUMENTS_BUCKET_NAME ||
			"chat-documents",
		contentType: mimeType,
	});

	const orgParam = input.organizationId
		? `&orgId=${encodeURIComponent(input.organizationId)}`
		: "";
	const previewUrl =
		input.format === "html"
			? `/api/storage/image?path=${encodeURIComponent(path)}${orgParam}`
			: undefined;

	return {
		frameId,
		content,
		format: input.format,
		path,
		previewUrl,
		response: `Frame "${input.title}" created successfully.`,
	};
}

export function getFabricToolDefinitionMap<
	T extends {
		name: string;
	},
>(toolDefinitions: T[]): Map<string, T> {
	return new Map(toolDefinitions.map((toolDef) => [toolDef.name, toolDef]));
}
