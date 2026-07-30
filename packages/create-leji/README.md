# create-leji

Bootstrap a [Leji](https://leji.org) context layer interactively. Leji is the open
specification for the shared context layer of AI-native teams.

```bash
npm create leji            # or: pnpm create leji / yarn create leji
```

Equivalent to installing the [`@leji-org/leji`](https://www.npmjs.com/package/@leji-org/leji) SDK
and running `leji init`. All `leji init` flags pass through:

```bash
npm create leji -- --yes --level indexed --name acme-context
```

- Specification: https://leji.org
- License: Apache-2.0
