# AI Artifacts for Fabric Portal - Complete Documentation

## Overview

This directory contains comprehensive documentation for implementing AI Artifacts functionality in the Fabric Portal AI Chatbot. AI Artifacts enable the AI assistant to generate, display, and manage code snippets, documents, charts, and other interactive content within the chat interface.

## What are AI Artifacts?

AI Artifacts are rich, interactive content blocks that the AI can create and display alongside chat messages. They provide a better user experience for:

- **Code Generation**: Syntax-highlighted code with copy/download/run actions
- **Document Creation**: Formatted text and markdown documents
- **Data Visualization**: Charts, graphs, and structured data
- **Interactive Content**: Editable content with version control

## Documentation Structure

### 1. [Architecture Documentation](./AI_ARTIFACTS_ARCHITECTURE.md)

**Purpose**: Visual system architecture and design decisions

**Contents**:
- System architecture diagrams
- Data flow diagrams
- Component architecture
- State machine diagrams
- Database schema
- Design decisions and rationale

**When to use**:
- Understanding system design
- Reviewing architecture decisions
- Onboarding new developers
- Planning extensions

## Implementation Phases

### Phase 1: MVP (Week 1-2)

**Goal**: Basic artifact functionality with streaming and rendering

**Features**:
- ✅ Backend streaming with custom data parts
- ✅ Artifact state management
- ✅ Basic artifact types (code, text, markdown, JSON)
- ✅ Artifact actions (copy, download)
- ✅ Chat UI integration

**Estimated Time**: 4-6 hours

**Documents**: Quick Start Guide, Technical Spec (Sections 1-4)

### Phase 2: Advanced Features (Week 3-4)

**Goal**: Persistence, version control, and enhanced UX

**Features**:
- ⚠️ Database persistence
- ⚠️ API endpoints for CRUD operations
- ⚠️ Version control and history
- ⚠️ Code execution (Pyodide)
- ⚠️ Enhanced actions (share, fork, export)

**Estimated Time**: 8-12 hours

**Documents**: Technical Spec (Sections 5-6), Implementation Plan (Phase 2)

## Key Technologies

- **Vercel AI SDK**: Streaming and tool calling
- **SWR**: Client-side state management
- **Shiki**: Syntax highlighting
- **Prisma**: Database ORM (Phase 2)
- **Pyodide**: Python execution (Phase 2)

## Reference Implementation

The implementation is based on Vercel's `ai-chatbot` reference:

**Location**: [`vercel/ai-chatbot`](https://github.com/vercel/ai-chatbot)

**Key Files**:
- `components/create-artifact.tsx` - Base artifact component
- `artifacts/code/client.tsx` - Code artifact with execution
- `artifacts/text/client.tsx` - Text artifact with suggestions
- `hooks/use-artifact.ts` - Artifact state management

## Quick Links

- [Vercel AI SDK Documentation](https://sdk.vercel.ai/)
- [AI SDK Elements - Artifact Component](https://ai-sdk.dev/elements/components/artifact)
- [Pyodide Documentation](https://pyodide.org/)
- [SWR Documentation](https://swr.vercel.app/)

## Getting Started

1. **Read the Implementation Plan** to understand the overall approach
2. **Review the Architecture** to understand the system design
3. **Follow the Quick Start Guide** to implement the MVP
4. **Refer to the Technical Spec** for detailed implementation

## File Structure

After implementation, the codebase will have:

```
apps/web/
├── app/api/ai/chats/[chatId]/messages/stream/
│   └── route.ts                          # Updated with artifact tools
└── modules/saas/ai/
    ├── types/
    │   └── artifact.ts                   # Artifact type definitions
    ├── hooks/
    │   ├── use-artifact.ts               # Artifact state management
    │   └── use-artifact-stream.ts        # Stream processing
    └── components/
        └── artifacts/
            ├── ArtifactRenderer.tsx      # Main renderer
            ├── CodeArtifact.tsx          # Code display
            ├── TextArtifact.tsx          # Text/markdown display
            └── JsonArtifact.tsx          # JSON display

packages/ai/
└── lib/tools/
    ├── create-artifact.ts                # Create artifact tool
    └── update-artifact.ts                # Update artifact tool

packages/database/
└── prisma/
    └── schema.prisma                     # Artifact model (Phase 2)
```

## Testing

### Manual Testing

1. Start dev server: `pnpm --filter web dev`
2. Navigate to chatbot: `/app/chatbot`
3. Test prompts:
   - "Write a Python function to calculate fibonacci"
   - "Create a markdown guide for React hooks"
   - "Generate a JSON schema for a user profile"

### Automated Testing

- Unit tests for hooks and utilities
- Integration tests for streaming and state
- E2E tests with Playwright

See Technical Spec Section 6 for testing checklist.

## Common Issues

### Artifacts not appearing
- Check browser console for errors
- Verify tools are imported in streaming route
- Ensure `useArtifact` hook is called

### Copy button not working
- Requires HTTPS or localhost
- Check clipboard API permissions
- Verify toast notifications are configured

### Syntax highlighting issues
- Verify CodeBlock component import
- Check language detection
- Ensure Shiki is configured

See Quick Start Guide for more troubleshooting.

## Contributing

When extending the artifact system:

1. Add new artifact types to the type registry
2. Create corresponding renderer components
3. Update the system prompt to guide the LLM
4. Add tests for new functionality
5. Update documentation

## Support

For questions or issues:
1. Review the documentation in this directory
2. Check the reference implementation
3. Consult Vercel AI SDK docs
4. Ask in team chat

## Next Steps

After completing the MVP:

1. **Gather User Feedback**: Test with real users
2. **Implement Phase 2**: Add persistence and version control
3. **Add Code Execution**: Integrate Pyodide for Python
4. **Enhance UX**: Add more actions and features
5. **Optimize Performance**: Profile and optimize rendering
6. **Write Documentation**: Update user-facing docs

## Success Metrics

- ✅ Artifacts render correctly in chat
- ✅ Streaming updates work smoothly
- ✅ Copy/download actions work reliably
- ✅ Syntax highlighting is accurate
- ✅ User satisfaction with artifact UX
- ✅ Performance meets targets (<100ms render time)

## License

This documentation is part of the Fabric Portal project.

