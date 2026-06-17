---
id: adopt-leji
title: Adopt the Leji context layer
status: accepted
date: 2026-06-10
deciders:
  - Jo Lee
affectedCategories:
  - governance
---

# Adopt the Leji context layer

## Context

Engineering knowledge lived in heads, chat threads, and three diverging tool config files. Agents produced code that didn't match our invariants because the invariants weren't written anywhere a tool could read.

## Decision

Adopt Leji at the `indexed` level: manifest, boot profile, domain and system content, decision records, generated index, machine changelog.

## Consequences

Vendor config files become one-line redirects. Context fixes ride the same PRs as the work that surfaces them. Jo owns the context layer.
