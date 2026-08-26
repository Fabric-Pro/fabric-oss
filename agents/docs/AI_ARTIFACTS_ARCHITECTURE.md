# AI Artifacts Architecture

## System Overview

This document provides a visual overview of the AI Artifacts system architecture in Fabric Portal.

## High-Level Architecture

```mermaid
flowchart TB
    subgraph Client["Client (Browser)"]
        UI["Chat UI"]
        ArtifactRenderer["Artifact Renderer"]
        ArtifactState["Artifact State (SWR)"]
    end
    
    subgraph API["API Layer"]
        StreamRoute["Stream Route"]
        ArtifactTools["Artifact Tools"]
        LLM["LLM (OpenAI/Anthropic)"]
    end
    
    subgraph Database["Database (Phase 2)"]
        ArtifactDB["Artifact Table"]
        ChatDB["Chat Table"]
    end
    
    UI -->|User Message| StreamRoute
    StreamRoute -->|Prompt + Tools| LLM
    LLM -->|Tool Calls| ArtifactTools
    ArtifactTools -->|Stream Parts| StreamRoute
    StreamRoute -->|SSE Stream| UI
    UI -->|Update State| ArtifactState
    ArtifactState -->|Render| ArtifactRenderer
    ArtifactRenderer -->|Display| UI
    
    StreamRoute -.->|Save (Phase 2)| ArtifactDB
    ArtifactDB -.->|Relation| ChatDB
```

## Data Flow

```mermaid
sequenceDiagram
    participant User
    participant ChatUI
    participant StreamRoute
    participant LLM
    participant ArtifactTool
    participant ArtifactState
    participant ArtifactRenderer
    
    User->>ChatUI: "Write a Python function"
    ChatUI->>StreamRoute: POST /api/ai/chats/{id}/messages/stream
    StreamRoute->>LLM: streamText with tools
    LLM->>ArtifactTool: createArtifact(kind, title, content)
    
    ArtifactTool->>StreamRoute: artifact-start
    StreamRoute->>ChatUI: SSE: artifact-start
    ChatUI->>ArtifactState: Initialize artifact
    
    loop Stream Content
        ArtifactTool->>StreamRoute: artifact-delta
        StreamRoute->>ChatUI: SSE: artifact-delta
        ChatUI->>ArtifactState: Append content
        ArtifactState->>ArtifactRenderer: Update display
    end
    
    ArtifactTool->>StreamRoute: artifact-complete
    StreamRoute->>ChatUI: SSE: artifact-complete
    ChatUI->>ArtifactState: Mark complete
    ArtifactState->>ArtifactRenderer: Final render
    ArtifactRenderer->>User: Display artifact
```

## Component Architecture

```mermaid
flowchart LR
    subgraph Chat["Chat Components"]
        AiChat["AiChat"]
        ChatMessage["ChatMessage"]
    end
    
    subgraph Artifacts["Artifact Components"]
        ArtifactRenderer["ArtifactRenderer"]
        CodeArtifact["CodeArtifact"]
        TextArtifact["TextArtifact"]
        JsonArtifact["JsonArtifact"]
    end
    
    subgraph Hooks["Hooks"]
        useArtifact["useArtifact"]
        useArtifactStream["useArtifactStream"]
    end
    
    subgraph State["State Management"]
        SWR["SWR Cache"]
    end
    
    AiChat -->|messages| ChatMessage
    AiChat -->|chatId| useArtifactStream
    useArtifactStream -->|process stream| useArtifact
    ChatMessage -->|chatId| useArtifact
    useArtifact <-->|read/write| SWR
    ChatMessage -->|artifact| ArtifactRenderer
    ArtifactRenderer -->|kind=code| CodeArtifact
    ArtifactRenderer -->|kind=text| TextArtifact
    ArtifactRenderer -->|kind=json| JsonArtifact
```

## Artifact State Machine

```mermaid
stateDiagram-v2
    [*] --> Idle: Initialize
    Idle --> Streaming: artifact-start
    Streaming --> Streaming: artifact-delta
    Streaming --> Complete: artifact-complete
    Streaming --> Error: artifact-error
    Complete --> Idle: Reset
    Error --> Idle: Reset
    
    note right of Streaming
        isVisible = false initially
        isVisible = true when content > 300 chars
    end note
    
    note right of Complete
        isVisible = true
        status = "idle"
    end note
```

## Artifact Type Registry

```mermaid
flowchart TB
    Registry["Artifact Type Registry"]
    
    Registry -->|kind=code| CodeConfig["Code Config"]
    Registry -->|kind=text| TextConfig["Text Config"]
    Registry -->|kind=markdown| MarkdownConfig["Markdown Config"]
    Registry -->|kind=json| JsonConfig["JSON Config"]
    
    CodeConfig -->|renderer| CodeArtifact["CodeArtifact"]
    CodeConfig -->|actions| CodeActions["Copy, Download, Run"]
    
    TextConfig -->|renderer| TextArtifact["TextArtifact"]
    TextConfig -->|actions| TextActions["Copy, Download"]
    
    MarkdownConfig -->|renderer| MarkdownArtifact["MarkdownArtifact"]
    MarkdownConfig -->|actions| MarkdownActions["Copy, Download"]
    
    JsonConfig -->|renderer| JsonArtifact["JsonArtifact"]
    JsonConfig -->|actions| JsonActions["Copy, Download, Format"]
```

## Database Schema (Phase 2)

```mermaid
erDiagram
    AiChat ||--o{ Artifact : has
    Artifact ||--o{ Artifact : versions
    
    AiChat {
        string id PK
        string userId
        string title
        datetime createdAt
        datetime updatedAt
    }
    
    Artifact {
        string id PK
        string chatId FK
        string kind
        string title
        text content
        string language
        json metadata
        int version
        string parentId FK
        datetime createdAt
        datetime updatedAt
    }
```

## Stream Part Types

```mermaid
flowchart LR
    subgraph StreamParts["Stream Part Types"]
        Start["artifact-start"]
        Delta["artifact-delta"]
        Complete["artifact-complete"]
        Error["artifact-error"]
    end
    
    Start -->|"{ id, kind, title, language }"| Handler1["Initialize Artifact"]
    Delta -->|"{ id, content }"| Handler2["Append Content"]
    Complete -->|"{ id }"| Handler3["Mark Complete"]
    Error -->|"{ id, error }"| Handler4["Show Error"]
```

## Key Design Decisions

### 1. State Management: SWR

**Why SWR?**
- Real-time updates during streaming
- Automatic revalidation
- Built-in caching
- Optimistic updates
- Minimal boilerplate

**Alternative Considered**: Zustand
- Rejected: More boilerplate for this use case
- SWR is better suited for streaming data

### 2. Streaming: Custom Data Parts

**Why Custom Data Parts?**
- Fine-grained control over artifact updates
- Separate artifact data from message content
- Support for multiple artifacts per message
- Easy to extend with new part types

**Alternative Considered**: Embed in message content
- Rejected: Harder to parse and update incrementally

### 3. Component Architecture: Type Registry

**Why Type Registry?**
- Easy to add new artifact types
- Centralized configuration
- Type-safe renderer selection
- Reusable action definitions

**Alternative Considered**: Switch statement in renderer
- Rejected: Less extensible, harder to maintain

### 4. Visibility Threshold: 300 Characters

**Why 300 Characters?**
- Balances UX (show early) vs. performance (avoid flicker)
- Enough content to be meaningful
- Prevents empty artifact flash

**Alternative Considered**: Show immediately
- Rejected: Causes UI flicker during streaming

## Performance Considerations

### Streaming Optimization

```mermaid
flowchart LR
    Tool["Artifact Tool"] -->|50 char chunks| Stream["Stream"]
    Stream -->|10ms delay| Smooth["Smooth UX"]
    Stream -->|Debounce 100ms| UI["UI Update"]
```

### State Update Optimization

```mermaid
flowchart TB
    StreamPart["Stream Part"] -->|Check ID| Match{"ID Matches?"}
    Match -->|No| Skip["Skip Update"]
    Match -->|Yes| Update["Update State"]
    Update -->|Memoized| Render["Re-render"]
```

## Security Considerations

### Code Execution (Phase 2)

```mermaid
flowchart TB
    Code["User Code"] -->|Execute| Pyodide["Pyodide (WASM)"]
    Pyodide -->|Sandboxed| Browser["Browser"]
    Browser -->|No Server Access| Safe["Safe Execution"]
    
    Pyodide -->|Timeout 5s| Limit["Execution Limit"]
    Pyodide -->|Memory Limit| Limit
```

### Content Sanitization

```mermaid
flowchart LR
    Content["Artifact Content"] -->|Sanitize| Clean["Clean HTML"]
    Clean -->|Escape| Safe["Safe Display"]
    Safe -->|Render| UI["UI"]
```

## Future Enhancements

1. **Multi-Artifact Support**: Display multiple artifacts per message
2. **Artifact Collaboration**: Share and fork artifacts
3. **Artifact Templates**: Pre-defined artifact templates
4. **Artifact Search**: Search across all artifacts
5. **Artifact Export**: Export to GitHub Gist, CodePen, etc.

