---
source: "9550ceea3130bc921e029e51d882c675dbcc3564"
---

# Decisões

Os registros de decisão documentam, com data, o *porquê* dentro da camada de contexto: decisões de arquitetura, escolhas de fornecedor, limites de escopo e decisões conscientes de não agir. Eles evitam que tudo seja rediscutido do zero e oferecem aos agentes o raciocínio, não apenas a regra.

Os registros de decisão são o subtipo formal de **registro** (ver [content-categories.md](/pt-br/spec/content-categories/), Intenção e registros): são registros por natureza, com um schema e um ciclo de vida uniformes que os registros genéricos não têm. Suas entradas de índice geradas carregam `kind: record`; um registro de decisão não declara chave `kind` própria (o schema é fechado, então um `kind` explícito falha na validação).

## Requisitos

1. Os registros de decisão são markdown com frontmatter YAML válido segundo [`decision-record.schema.json`](../schemas/decision-record.schema.json), um registro por arquivo. O corpus de decisões é a união de duas superfícies declaradas no manifesto, e uma camada de contexto **MAY** usar uma delas ou as duas: o caminho de registros declarado (`machine.decisionRecordsPath`, padrão `<root>/decisions/`) e as entradas para as quais os arquivos de índice da categoria `decisions` resolvem. Um registro **MUST** ser alcançável por ao menos uma das duas.
2. O frontmatter **MUST** carregar: `id` (estável), `title`, `status` e `date`. `status` é um entre `proposed`, `accepted`, `superseded`, `deprecated` e `rejected`.
3. O corpo **MUST** enunciar, em prosa: o contexto (que situação forçou uma decisão), a decisão em si e suas consequências. Os títulos de seção **RECOMMENDED** são `## Context`, `## Decision` e `## Consequences`; um registro **MAY** acrescentar `## Alternatives`.
4. Os registros são **histórico somente acréscimo**: um registro **MUST NOT** ser editado até virar uma decisão diferente. Dois campos de frontmatter são **mutáveis** conforme uma decisão envelhece, `status` (seu ciclo de vida) e `supersededBy` (definido quando ela é superada); todo o resto, o `id`, o `title` e a `date` originais, o escopo declarado e o corpo em prosa, é **imutável** uma vez publicado. Uma reversão ou mudança é um novo registro cujo frontmatter define `supersedes`, e o `status` do registro antigo passa a `superseded` com `supersededBy` definido. O elo de superação **MUST** permanecer consistente nos dois sentidos: quando o registro B define `supersedes: A`, o registro A carrega `status: superseded` e `supersededBy: B`, e um registro `superseded` **MUST** nomear seu sucessor em `supersededBy`. Os dois registros permanecem. O ferramental de referência hoje impõe a consistência bidirecional da superação. Ele ainda não verifica a imutabilidade em si (que os campos congelados e o corpo de um registro publicado estejam inalterados em relação a uma revisão base); essa é uma verificação reportada no roteiro, ainda não uma verificação bloqueante. Até isso chegar, a imutabilidade se apoia na disciplina de revisão atestada por processo (ver [conformance.md](/pt-br/spec/conformance/)).
5. Um registro **MAY** declarar `affectedPaths` e `affectedCategories`, para que o ferramental possa rotear do escopo de uma tarefa até as decisões que a governam. Como o escopo de uma tarefa seleciona registros (contenção de caminho ciente de sobreposição, casamento estreito de categoria, o vínculo de `accepted` / `deprecated` e o tratamento de alcance organizacional para um registro que não declara nenhum dos dois) é o algoritmo de Roteamento de tarefas em [machine-readable-surface.md](/pt-br/spec/machine-readable-surface/).
6. Propostas rejeitadas também são registros (`status: rejected`). Uma decisão não tomada, escrita, é o seguro mais barato que existe contra rediscussão.

## Compatibilidade com ADR (não normativo)

Os registros de decisão do Leji foram projetados para serem compatíveis com Architecture Decision Records: um diretório de ADR existente atende a `decisions` depois que os campos de frontmatter são acrescentados a cada registro (ou apenas aos novos registros dali em diante) e o diretório é mapeado no manifesto. Nenhuma ferramenta de ADR é exigida ou excluída.
