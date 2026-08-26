/**
 * Text renderings of an OpenAPI description, for embedding and prompting.
 *
 * Each rendering must stand alone. Retrieval returns one chunk without its
 * neighbours, so an operation that renders as "returns Pet" is useless — the
 * reader has no idea which API, which path, or what a Pet is. Every rendering
 * therefore repeats the API's name and version, and operations name the models
 * they reference so the reader knows what to ask for next.
 *
 * Markdown, because that is what the rest of the prompt is written in.
 */

import type {
	ModelDescription,
	OpenApiDescription,
	OperationDescription,
	ParameterDescription,
} from "../describe-types";

/** How the API identifies itself at the top of every chunk. */
function apiHeading(spec: OpenApiDescription): string {
	return `API: ${spec.title} (version ${spec.version}, OpenAPI ${spec.specVersion})`;
}

function renderParameter(parameter: ParameterDescription): string {
	const required = parameter.required ? "required" : "optional";
	const parts = [
		`- \`${parameter.name}\` (${parameter.in}, ${required}): ${parameter.type}`,
	];
	if (parameter.enumValues && parameter.enumValues.length > 0) {
		parts.push(`  - allowed: ${parameter.enumValues.join(", ")}`);
	}
	if (parameter.description) {
		parts.push(`  - ${parameter.description}`);
	}
	return parts.join("\n");
}

/**
 * One operation, in full.
 *
 * This is the chunk an integration question retrieves, so it carries everything
 * needed to call the endpoint correctly: inputs with their types and whether
 * they are required, the request body, and every response status — including the
 * error codes, which are usually the part an integrator actually needs.
 */
export function renderOperation(
	spec: OpenApiDescription,
	operation: OperationDescription,
): string {
	const lines: string[] = [
		apiHeading(spec),
		"",
		`## ${operation.method} ${operation.path}`,
	];

	if (operation.summary) {
		lines.push("", operation.summary);
	}
	if (operation.description && operation.description !== operation.summary) {
		lines.push("", operation.description);
	}

	const facts: string[] = [`Operation ID: \`${operation.operationId}\``];
	if (operation.tags.length > 0) {
		facts.push(`Tags: ${operation.tags.join(", ")}`);
	}
	if (operation.security.length > 0) {
		facts.push(`Requires auth: ${operation.security.join(", ")}`);
	}
	if (operation.deprecated) {
		facts.push("**Deprecated.**");
	}
	lines.push("", ...facts);

	if (operation.parameters.length > 0) {
		lines.push("", "### Parameters");
		for (const parameter of operation.parameters) {
			lines.push(renderParameter(parameter));
		}
	} else {
		lines.push("", "### Parameters", "- none");
	}

	if (operation.requestBody) {
		const body = operation.requestBody;
		lines.push("", "### Request body");
		lines.push(
			`- ${body.required ? "required" : "optional"}${
				body.contentTypes.length > 0
					? ` (${body.contentTypes.join(", ")})`
					: ""
			}`,
		);
		if (body.schemaRef) {
			lines.push(`- Model: \`${body.schemaRef}\``);
		} else if (body.schemaSummary) {
			lines.push(`- Shape: \`${body.schemaSummary}\``);
		}
		if (body.description) {
			lines.push(`- ${body.description}`);
		}
	}

	lines.push("", "### Responses");
	if (operation.responses.length === 0) {
		lines.push("- none documented");
	} else {
		for (const response of operation.responses) {
			const shape = response.schemaRef
				? ` → \`${response.schemaRef}\``
				: response.schemaSummary
					? ` → \`${response.schemaSummary}\``
					: "";
			const description = response.description
				? ` — ${response.description}`
				: "";
			lines.push(`- **${response.statusCode}**${shape}${description}`);
		}
	}

	return lines.join("\n");
}

/** One named model, with its properties. */
export function renderModel(
	spec: OpenApiDescription,
	model: ModelDescription,
): string {
	const lines: string[] = [apiHeading(spec), "", `## Model: ${model.name}`];

	if (model.description) {
		lines.push("", model.description);
	}

	lines.push("", "### Properties");
	if (model.properties.length === 0) {
		lines.push("- none documented");
	} else {
		for (const property of model.properties) {
			if (!property.type) {
				// The "… N more properties" sentinel from the describer.
				lines.push(`- ${property.name}`);
				continue;
			}
			const required = property.required ? "required" : "optional";
			const description = property.description
				? ` — ${property.description}`
				: "";
			lines.push(
				`- \`${property.name}\` (${required}): ${property.type}${description}`,
			);
			// The allowed values are the contract for this field; without them the
			// reader sees `string` for something the API rejects unless it is one
			// of a fixed set.
			if (property.enumValues && property.enumValues.length > 0) {
				lines.push(`  - allowed: ${property.enumValues.join(", ")}`);
			}
		}
	}

	return lines.join("\n");
}

/**
 * The whole API at a glance: identity, auth, and every endpoint on one line each.
 *
 * Per-operation chunks answer "how do I call X" well and "what can this API do"
 * badly, because no single operation chunk knows the others exist. This is the
 * chunk that answers the second question, and it is why an inventory line is
 * emitted for every operation even when the detail is elsewhere.
 */
export function renderSpecSummary(spec: OpenApiDescription): string {
	const lines: string[] = [apiHeading(spec), "", "## API overview"];

	if (spec.description) {
		lines.push("", spec.description);
	}

	if (spec.servers.length > 0) {
		lines.push("", `Base URL(s): ${spec.servers.join(", ")}`);
	}

	if (spec.securitySchemes.length > 0) {
		lines.push("", "### Authentication");
		for (const scheme of spec.securitySchemes) {
			const detail = [scheme.scheme, scheme.in]
				.filter(Boolean)
				.join(", ");
			lines.push(
				`- \`${scheme.name}\`: ${scheme.type}${detail ? ` (${detail})` : ""}`,
			);
		}
	}

	const tags = [...new Set(spec.operations.flatMap((o) => o.tags))];
	if (tags.length > 0) {
		lines.push("", `Tags: ${tags.join(", ")}`);
	}

	lines.push("", `### Endpoints (${spec.operations.length})`);
	for (const operation of spec.operations) {
		const summary = operation.summary ? ` — ${operation.summary}` : "";
		const deprecated = operation.deprecated ? " [deprecated]" : "";
		lines.push(
			`- \`${operation.method} ${operation.path}\`${summary}${deprecated}`,
		);
	}

	if (spec.models.length > 0) {
		lines.push(
			"",
			`### Models (${spec.models.length})`,
			spec.models.map((model) => model.name).join(", "),
		);
	}

	// Say what is missing. A multi-file spec that references its paths out to
	// other files would otherwise present a confident, incomplete inventory —
	// and a reader with no way to know it was incomplete.
	if (spec.unresolvedPaths.length > 0) {
		lines.push(
			"",
			`### Paths defined in other files (${spec.unresolvedPaths.length})`,
			"These are referenced by this document but defined elsewhere, so their operations are not described here:",
			spec.unresolvedPaths.map((path) => `- \`${path}\``).join("\n"),
		);
	}

	return lines.join("\n");
}
