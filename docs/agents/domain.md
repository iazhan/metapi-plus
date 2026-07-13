# Domain Docs

Before exploring the codebase, read `CONTEXT.md` and relevant ADRs under
`docs/adr/` when they exist. Missing domain files are not an error; proceed
silently until `/domain-modeling` creates them from resolved terminology or
decisions.

## Layout

This is a single-context repository:

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

Use terminology defined in `CONTEXT.md` in issues, plans, tests, and code.
If work contradicts an existing ADR, surface the conflict explicitly instead
of silently overriding it.
