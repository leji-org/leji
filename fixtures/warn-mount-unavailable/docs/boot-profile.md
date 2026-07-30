# Boot Profile

## Identity

A fixture context layer.

## Loading

Read `docs/domain/` before any task.

## Federated siblings

```leji-mounts
- mount: product-context
  owner: Product Owner
  carries: product-side context
  read-when: a task touches the product surface
```

## Posture

- Stop and ask before destructive changes.

## Maintenance

Decisions are recorded in `docs/decisions/`.
