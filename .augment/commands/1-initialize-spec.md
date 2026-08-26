# Step 1: Initialize Spec

> **Usage**: Reference with `.augment/commands/1-initialize-spec.md` or copy into chat

---

## Workflow Instructions

The FIRST STEP is to initialize the spec folder by creating the following structure:

```
fabric/specs/YYYY-MM-DD-feature-name/
├── README.md
├── planning/
│   ├── requirements.md
│   ├── decisions.md
│   └── visuals/
├── spec.md
└── tasks.md
```

### Initialize the Folder

1. Create the spec folder with today's date and a descriptive name
2. Create `README.md` with a brief description of the feature
3. Create the `planning/` subfolder structure
4. Initialize empty `spec.md` and `tasks.md` files

---

## Display Confirmation and Next Step

Once you've initialized the spec folder, output the following message (replace `[this-spec]` with the folder name for this spec):

```
✅ I have initialized the spec folder at `fabric/specs/[this-spec]/`.

NEXT STEP 👉 Run .augment/commands/2-shape-spec.md to gather requirements
```

