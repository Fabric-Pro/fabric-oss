# /write-spec

Create a detailed technical specification from gathered requirements.

## Purpose

Transform shaped requirements into a comprehensive specification that guides implementation.

## When to Use

- After `/shape-spec` completes
- When requirements are documented
- Before creating tasks

## Pre-Check

1. Verify spec folder exists: `fabric/specs/YYYY-MM-DD-feature/`
2. Verify requirements exist: `planning/requirements.md`
3. Load project standards from `fabric/standards/`

## Process

### Step 1: Read Context

Load and review:
- `planning/requirements.md`
- `planning/decisions.md`
- `planning/visuals/` (any assets)
- `fabric/standards/` (all standards)

### Step 2: Write Specification

Create `spec.md` with these sections:

```markdown
# Feature Specification: [Feature Name]

## 1. Overview
### 1.1 Description
[What this feature does]

### 1.2 Goals
- [Goal 1]
- [Goal 2]

### 1.3 Success Metrics
- [Metric 1]
- [Metric 2]

## 2. User Stories
- As a [user], I want to [action] so that [benefit]

## 3. Architecture

### 3.1 System Overview
[High-level architecture description]

### 3.2 Components
- [Component 1]: [Purpose]
- [Component 2]: [Purpose]

### 3.3 Data Flow
[How data moves through the system]

## 4. Data Models

### 4.1 Database Schema
```sql
CREATE TABLE [table_name] (
  id UUID PRIMARY KEY,
  -- fields
);
```

### 4.2 Entity Relationships
[Describe relationships]

## 5. API Specification

### 5.1 Endpoints

#### POST /api/[resource]
- **Description**: [What it does]
- **Authentication**: Required/Optional
- **Request**:
```json
{
  "field": "value"
}
```
- **Response**:
```json
{
  "data": { }
}
```
- **Errors**: [Error codes and meanings]

## 6. User Interface

### 6.1 Pages/Screens
- [Page 1]: [Description]

### 6.2 Components
- [Component 1]: [Purpose and behavior]

### 6.3 State Management
[How state is managed]

## 7. Security

### 7.1 Authentication
[Auth requirements]

### 7.2 Authorization
[Permission model]

### 7.3 Data Validation
[Validation rules]

## 8. Testing Strategy

### 8.1 Unit Tests
[What to unit test]

### 8.2 Integration Tests
[What to integration test]

### 8.3 E2E Tests
[Critical user flows to test]

## 9. Implementation Notes

### 9.1 Dependencies
[Required packages/services]

### 9.2 Migration Path
[How to deploy safely]

### 9.3 Rollback Plan
[How to revert if needed]
```

## Completion

After writing, inform the user:

```
✅ Specification complete!

📄 Created: fabric/specs/YYYY-MM-DD-feature/spec.md

Sections included:
✓ Overview & Goals
✓ Architecture
✓ Data Models
✓ API Specification
✓ User Interface
✓ Security
✓ Testing Strategy
✓ Implementation Notes

NEXT STEP 👉 Run `/create-tasks` to break down into implementable tasks.
```

