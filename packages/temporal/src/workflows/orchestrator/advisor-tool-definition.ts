/** Pure provider normalization shared by native and discovered definitions. */
export interface NormalizedToolDefinition {
	description: string;
	inputSchema: Record<string, unknown>;
}
export function normalizeAdvisorToolDefinition(
	toolName: string,
	toolDef: { description?: string; inputSchema?: Record<string, unknown> },
): NormalizedToolDefinition {
	const rawSchema = toolDef.inputSchema || {};
	// Unwrap MCP protocol's jsonSchema wrapper if present
	const unwrapped =
		rawSchema.jsonSchema && typeof rawSchema.jsonSchema === "object"
			? (rawSchema.jsonSchema as Record<string, unknown>)
			: rawSchema;

	// Ensure OpenAI-compatible object schema: must have type="object" and properties
	// (OpenAI rejects schemas that are {} or { type: "object" } without properties)
	const schemaToUse: Record<string, unknown> = {
		type: "object",
		properties: {},
		...unwrapped,
	};
	if (!schemaToUse.properties) {
		schemaToUse.properties = {};
	}

	// Patch create_view: the MCP server schema may be missing entirely (when
	// discovered via vector search with no cached inputSchema) or may declare
	// elements as { type: "string" } which the AI SDK strips when the LLM
	// generates an array — resulting in args: {} reaching executeMcpTool.
	// Inject elements as a required array; normalizeExcalidrawCreateViewArgs()
	// in execute-mcp-tool.ts converts it to a JSON string before the MCP call.
	if (toolName === "create_view") {
		const props = schemaToUse.properties as Record<
			string,
			Record<string, unknown>
		>;
		props.elements = {
			type: "array",
			items: { type: "object" },
			description:
				"Array of Excalidraw element objects. Each element MUST have: type, id (unique string), x, y, width, height. " +
				"To add text inside a shape: label: {text: 'My Label', fontSize: 16} — works on rectangle, ellipse, diamond, arrow. " +
				"Types: 'rectangle', 'ellipse', 'diamond', 'arrow' (needs points:[[0,0],[dx,dy]]), 'text' (needs text field, NOT label). " +
				"Optional: backgroundColor, strokeColor, strokeWidth, roughness (0=clean 1=hand-drawn), roundness:{type:3} for rounded corners. " +
				"Colors: '#dbe4ff'=blue '#d3f9d8'=green '#f3d9fa'=purple '#fff3bf'=yellow '#e7f5ff'=light-blue '#ebfbee'=light-green. " +
				"Always start with: {type:'cameraUpdate', width:800, height:600, x:0, y:0}.",
		};
		const req = schemaToUse.required as string[] | undefined;
		if (!req) {
			schemaToUse.required = ["elements"];
		} else if (!req.includes("elements")) {
			req.push("elements");
		}
	}

	const isCreateView = toolName === "create_view";
	const baseDescription = toolDef.description || toolName;
	const toolDescription = isCreateView
		? `${baseDescription}

CRITICAL QUALITY RULES:
1. Create 15-30+ elements. Never 3-5 bare unlabeled boxes.
2. NODE rectangles/ellipses/diamonds MUST use label:{text:"...",fontSize:16} for text inside them.
3. CONTAINER zones (large background rects) use a separate text element for their title at top-left — NOT label, because label centers and overlaps nodes inside the container.
4. Structure: CONTAINER rect (w:820 h:200, strokeWidth:1), TEXT title at top-left of container, NODE rects (w:160 h:60) with labels, ARROWs between tiers.
5. Colors: Tier1 container=#e7f5ff nodes=#dbe4ff stroke=#4263eb | Tier2 container=#f3f0ff nodes=#f3d9fa stroke=#ae3ec9 | Tier3 container=#ebfbee nodes=#d3f9d8 stroke=#2f9e44

EXAMPLE (container title as text, nodes use label):
{type:"cameraUpdate", width:1200, height:900, x:0, y:0}
{type:"rectangle", id:"c1", x:50, y:50, width:820, height:200, backgroundColor:"#e7f5ff", strokeColor:"#4263eb", strokeWidth:1, opacity:80}
{type:"text", id:"ct1", x:70, y:62, text:"Presentation Tier (Client)", fontSize:16, strokeColor:"#4263eb"}
{type:"rectangle", id:"n1", x:100, y:110, width:160, height:60, backgroundColor:"#dbe4ff", strokeColor:"#4263eb", label:{text:"Web Browser",fontSize:16}}
{type:"rectangle", id:"n2", x:310, y:110, width:160, height:60, backgroundColor:"#dbe4ff", strokeColor:"#4263eb", label:{text:"Mobile App",fontSize:16}}
{type:"rectangle", id:"n3", x:520, y:110, width:160, height:60, backgroundColor:"#dbe4ff", strokeColor:"#4263eb", label:{text:"Desktop App",fontSize:16}}
{type:"arrow", id:"a1", x:460, y:250, width:0, height:80, points:[[0,0],[0,80]], label:{text:"HTTP / REST",fontSize:14}}
— repeat for each tier below (y increments ~280px per tier)`
		: baseDescription;

	return { description: toolDescription, inputSchema: schemaToUse };
}
