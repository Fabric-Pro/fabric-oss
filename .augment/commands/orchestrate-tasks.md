# /orchestrate-tasks

Plan the implementation strategy and order for tasks.

## Purpose

Create an optimal execution plan for implementing tasks, considering dependencies, parallelization, and team resources.

## When to Use

- After `/create-tasks` completes
- When planning implementation sprint
- When coordinating team work

## Pre-Check

1. Verify tasks exist: `fabric/specs/YYYY-MM-DD-feature/tasks.md`
2. Review spec: `fabric/specs/YYYY-MM-DD-feature/spec.md`

## Process

### Step 1: Analyze Dependencies

Review tasks and identify:
- **Hard dependencies**: Task B requires Task A complete
- **Soft dependencies**: Task B is easier after Task A
- **Independent tasks**: Can be done in parallel

### Step 2: Create Execution Plan

Create `orchestration.yml` (or update README):

```yaml
# Implementation Orchestration Plan

feature: [Feature Name]
created: YYYY-MM-DD
estimated_duration: [X days/weeks]

phases:
  - name: "Phase 1: Foundation"
    duration: "Day 1-2"
    parallel: false
    tasks:
      - id: "1.1"
        name: "Create database schema"
        assignee: "[optional]"
        
      - id: "1.2"
        name: "Add database indexes"
        depends_on: ["1.1"]
        
  - name: "Phase 2: Backend + Frontend"
    duration: "Day 3-5"
    parallel: true
    streams:
      - name: "Backend Stream"
        tasks:
          - id: "2.1"
            name: "Create API routes"
          - id: "2.2"
            name: "Implement endpoints"
            depends_on: ["2.1"]
            
      - name: "Frontend Stream"
        tasks:
          - id: "3.1"
            name: "Create page layout"
          - id: "3.2"
            name: "Build components"
            depends_on: ["3.1"]
            
  - name: "Phase 3: Integration"
    duration: "Day 6"
    parallel: false
    tasks:
      - id: "3.3"
        name: "Connect frontend to API"
        depends_on: ["2.2", "3.2"]
        
  - name: "Phase 4: Testing & Polish"
    duration: "Day 7-8"
    parallel: true
    tasks:
      - id: "4.1"
        name: "Write unit tests"
      - id: "4.2"
        name: "Write integration tests"
      - id: "4.3"
        name: "Write E2E tests"
        depends_on: ["3.3"]

milestones:
  - name: "API Complete"
    when: "End of Phase 2"
    criteria:
      - "All endpoints implemented"
      - "Basic tests passing"
      
  - name: "Feature Complete"
    when: "End of Phase 3"
    criteria:
      - "Frontend connected to API"
      - "Happy path works"
      
  - name: "Ready for Review"
    when: "End of Phase 4"
    criteria:
      - "All tests passing"
      - "Code reviewed"
      - "Documentation updated"

risks:
  - risk: "[Potential issue]"
    mitigation: "[How to address]"
    
notes:
  - "[Any implementation notes]"
```

### Step 3: Create Implementation Prompts (Optional)

For complex features, create phase-specific prompts:

```
fabric/specs/YYYY-MM-DD-feature/
└── implementation/
    └── prompts/
        ├── phase-1-foundation.md
        ├── phase-2-backend.md
        ├── phase-2-frontend.md
        └── phase-3-integration.md
```

Each prompt guides implementation for that phase.

## Orchestration Strategies

### Sequential (Simple)
```
Database → Backend → Frontend → Testing
```
Best for: Solo developers, simple features

### Parallel Streams (Team)
```
Database → [Backend Stream] → Integration → Testing
        → [Frontend Stream] ↗
```
Best for: Teams, larger features

### Vertical Slices
```
Feature A (DB + API + UI + Tests) → Feature B → Feature C
```
Best for: MVPs, quick iteration

## Completion

After orchestrating, inform the user:

```
✅ Orchestration complete!

📄 Created: fabric/specs/YYYY-MM-DD-feature/orchestration.yml

📊 Plan:
- Phases: X
- Estimated Duration: Y days
- Parallelizable: Yes/No

🎯 First Milestone: [Name] by [Date]

NEXT STEP 👉 Run `/implement-tasks` to start building!
```

