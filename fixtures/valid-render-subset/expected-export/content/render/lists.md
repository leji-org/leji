<!--
   Feature family: lists — unordered, ordered, nested to three levels, loose and
   tight, with a fenced block inside a list item, plus the GFM task list. All
   inside the supported rendering subset; no lint finding comes from this file.
-->

# Lists

## Unordered, tight

- First item
- Second item
- Third item

## Ordered, tight

1. First step
2. Second step
3. Third step

An ordered list may start at another number, and the start is significant:

7. The seventh step
8. The eighth step

## Nested

- Top level
  - Second level
    - Third level
  - Back to the second level
- Another top-level item
  1. An ordered child
  2. A second ordered child

## Loose

- A loose item, because a blank line separates the items.

- A second loose item, whose text is wrapped in a paragraph rather than left
  bare.

## A block inside an item

1. A step whose detail is a fenced block:

   ```bash
   leji export --out build/context
   ```

2. The step after it, still part of the same list.

## Task list (GFM)

- [x] A completed task
- [ ] An open task
- [ ] An open task with **strong** text and `inline code`
  - [x] A completed nested task
