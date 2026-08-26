# Prompt Enhancer Agent

LangGraph agent for AI-powered prompt enhancement with real-time streaming and format-aware improvements.

## Overview

This agent provides:
- **Format-Aware Enhancement**: Understands and preserves template syntax (Handlebars, Mustache, Liquid, Jinja2)
- **Category-Specific Improvements**: Applies best practices based on prompt category (document generation, code generation, agent instructions, etc.)
- **Multiple Enhancement Types**: Rewrite, expand, restructure, add variables, apply best practices, optimize
- **Real-Time Streaming**: Predictive state updates for live content preview
- **CopilotKit Integration**: Seamless integration with CopilotKit for UI updates

## Quick Start

### 1. Install Dependencies
```bash
cd agents/langchain/prompt-enhancer
pnpm install
```

### 2. Configure Environment
Create a `.env` file with your API keys:
```bash
# Required: At least one LLM API key
OPENAI_API_KEY="sk-..."
# or
ANTHROPIC_API_KEY="sk-ant-..."

# Optional: AI Gateway
AI_GATEWAY_API_KEY="vck_..."
```

### 3. Run Development Server
```bash
# Using the unified server (supports both A2A and AG-UI)
pnpm dev

# Equivalent direct invocation
npx tsx --env-file=.env unified-server.ts
```

The agent will be available at `http://localhost:8134` (default port).

### 4. Test the Agent
```bash
curl -X POST http://localhost:8134/runs/stream \
  -H "Content-Type: application/json" \
  -d '{
    "assistant_id": "prompt_enhancer",
    "input": {
      "promptId": "test-123",
      "promptName": "Test Prompt",
      "format": "HANDLEBARS",
      "category": "document-generation",
      "tags": ["prd", "technical"],
      "currentContent": "Generate a document for {{projectName}}",
      "enhancementType": "expand",
      "userInstructions": "Add more detail and examples"
    },
    "stream_mode": "updates"
  }'
```

## Enhancement Types

### 1. Rewrite
Rewrites the prompt for maximum clarity and professionalism.
- Improves language and structure
- Removes ambiguity
- Makes instructions more explicit

### 2. Expand
Adds more detail and context to the prompt.
- Includes concrete examples
- Expands on key concepts
- Provides additional guidance

### 3. Restructure
Reorganizes content for better logical flow.
- Groups related concepts
- Improves section structure
- Enhances readability

### 4. Add Variables
Identifies opportunities for template variables.
- Adds variables in correct format syntax
- Documents variable purpose
- Ensures meaningful naming

### 5. Apply Best Practices
Applies category-specific best practices.
- Ensures proper structure
- Adds missing elements
- Optimizes for use case

### 6. Optimize
Optimizes the prompt for effectiveness.
- Removes redundancy
- Sharpens focus
- Improves token efficiency

## Supported Formats

- **PLAIN_TEXT**: Simple text with {variable} placeholders
- **MARKDOWN**: Markdown with {variable} placeholders
- **HANDLEBARS**: {{variable}}, {{#each}}, {{#if}}
- **MUSTACHE**: {{variable}}, {{#section}}, {{^inverted}}
- **LIQUID**: {{ variable }}, {% if %}, {% for %}
- **JINJA2**: {{ variable }}, {% if %}, {% for %}, {{ variable | filter }}

## Supported Categories

- **document-generation**: PRDs, proposals, architecture docs
- **code-generation**: Code snippets, functions, classes
- **agent-instructions**: AI agent system prompts
- **workflow**: Process definitions, automation scripts
- **general**: General-purpose prompts

## Integration with Fabric

The agent is automatically registered with CopilotKit in `apps/web/app/api/copilotkit/route.ts`.

### Frontend Usage
```typescript
import { useCopilotAction } from "@copilotkit/react-core";

useCopilotAction({
  name: "enhance_prompt",
  parameters: [
    { name: "enhancementType", type: "string" },
    { name: "instructions", type: "string" }
  ],
  handler: async ({ enhancementType, instructions }) => {
    // Calls the LangGraph agent
    // Receives predictive state updates via SSE
  }
});
```

## Architecture

### State Management
The agent uses LangGraph's Annotation system for type-safe state management:
- Prompt context (ID, name, format, category, tags)
- Enhancement parameters (type, user instructions)
- Output (enhanced content, explanation)
- Streaming state (for predictive updates)

### Workflow
1. **Input**: Receives prompt context and enhancement request
2. **System Prompt Generation**: Creates format and category-specific system prompt
3. **Enhancement**: Streams enhanced content using LLM
4. **Output**: Returns enhanced content with explanation

### Predictive Updates
The agent supports predictive state updates for real-time UI updates:
- `streamingContent`: Current enhanced content being generated
- `focusAnchor`: Optional focus position for UI highlighting

## Configuration

### Environment Variables
- `OPENAI_API_KEY`: OpenAI API key (optional if using Anthropic or AI Gateway)
- `ANTHROPIC_API_KEY`: Anthropic API key (optional if using OpenAI or AI Gateway)
- `AI_GATEWAY_API_KEY`: Vercel AI Gateway key (optional, routes through gateway if set)

### Model Configuration
Default model: `gpt-4o` (OpenAI) or `claude-3-5-sonnet-20241022` (Anthropic)
Temperature: `0.7`
Streaming: Enabled

## Development

### Run Tests
```bash
pnpm test
```

### Type Check
```bash
pnpm type-check
```

### Build
```bash
pnpm build
```

## License

Private - Part of Fabric Portal

