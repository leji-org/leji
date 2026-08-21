# Boot Profile

## Identity

A fixture context layer.

## Loading

Read `docs/domain/` before any task.

Sibling layers this repository mounts:

```leji-mounts
- mount: product-context
  owner: Product Owner
  carries: product-side domain language and the decisions behind it
  read-when: a task touches product behavior or product terminology
```

## Posture

- Stop and ask before destructive changes.

## Maintenance

Decisions are recorded in `docs/decisions/`.
