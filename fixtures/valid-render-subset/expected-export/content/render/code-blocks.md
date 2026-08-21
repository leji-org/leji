<!--
   Feature family: code — indented blocks, fenced blocks with a vendored
   highlight language, a fence with no info string, and a fence whose info string
   names a language the viewer does not vendor. The last case is the one worth
   pinning: an unknown info string renders as unhighlighted code, which is
   conforming, never a finding. All inside the supported rendering subset.
-->

# Code blocks

## Indented

Four spaces open an indented code block:

    leji validate --root .
    leji export

Prose resumes after a blank line.

## Fenced, with a vendored language

```json
{
   "leji": "1.0",
   "name": "fixture"
}
```

```bash
leji export --out build/context
```

## Fenced, with no info string

```
Plain preformatted text. No language is claimed, so none is highlighted.
```

## Fenced, with an unhighlighted language

The viewer vendors a small highlight set. An info string outside it still
renders as a code block, unhighlighted:

```toml
[fixture]
name = "fixture"
```

```zsh
print 'an info string the highlight set does not carry'
```

## A longer fence

A fence may be opened with more than three backticks, which is how a fenced
block carries a fence of its own:

````markdown
```json
{ "nested": true }
```
````
