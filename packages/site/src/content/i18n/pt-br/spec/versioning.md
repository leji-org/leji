---
source: "954281dd7ebde528ca176407d310556ec7749057"
---

# Versionamento

Três elementos têm versionamento independente: a especificação, os schemas e quaisquer ferramentas que a implementem.

## A especificação

1. A especificação carrega uma versão SemVer (atualmente **1.0.0**). Mudanças incompatíveis exigem uma versão maior; toda mudança é registrada no changelog do repositório.
2. Uma camada de contexto declara em `leji.json` a linha de especificação que tem como alvo, por meio da chave autonomeadora `leji` (por exemplo `"leji": "1.0"`), seguindo a convenção do OpenAPI. O valor é a **linha** da especificação (`major.minor`), nunca a versão de correção dela: um lançamento de correção (`1.0.0` para `1.0.1`) refina redação ou ferramental sem mover a linha, então o manifesto continua `"1.0"` em toda correção. O ferramental **MUST** validar uma camada de contexto contra a linha declarada, não contra a mais nova.

## Linhas de prévia

Uma linha de especificação **MAY** ser designada como **prévia**. Uma linha de prévia é revisável no lugar: ela **MAY** mudar de maneiras que de outro modo seriam incompatíveis, em vez de ser promovida a uma nova versão, até ser congelada na disponibilidade geral (GA). A regra "mudanças incompatíveis exigem uma versão maior" (item 1) e a regra "o `$id` se move em uma mudança incompatível de formato" (item 3) valem a partir do congelamento no GA, não enquanto uma linha está em prévia. No GA, a linha é congelada e as duas regras passam a valer.

Uma linha publicada antes da disponibilidade geral **MUST** declarar isso em seu lançamento inicial.

A linha 1.0 está **congelada na versão publicada v1.3.0 do ferramental de referência**. Dentro da linha, as mudanças de schema são apenas aditivas e o `$id` permanece em `v1.0`; qualquer mudança incompatível é publicada como uma nova linha, nunca no lugar.

## Os schemas

3. Cada schema carrega um `$id` estável no formato `https://leji.org/schemas/v<major>.<minor>/<name>.schema.json`. A linha do `$id` só se move quando o formato do schema muda de forma incompatível.
4. Dentro de uma linha publicada, as mudanças de schema **MUST** ser aditivas (novos campos opcionais). Remoções de campo ou mudanças semânticas exigem uma nova linha.
5. Os artefatos legíveis por máquina que não sejam o manifesto declaram a linha de schema contra a qual foram escritos por meio de `schemaVersion`; o manifesto declara a linha de especificação que tem como alvo por meio da chave autonomeadora `leji` (item 2).

## Conjunto de estabilidade

Os itens a seguir são congelados dentro de uma linha de especificação; o ferramental (inclusive futuras implementações comerciais) é construído sobre eles sem nenhum schema paralelo:

- o formato do manifesto e seu nome de arquivo fixo `leji.json`,
- os identificadores de categoria (`domain`, `system`, `practice`, `governance`, `decisions`),
- os identificadores de nível de conformidade (`core`, `indexed`, `governed`, `federated`),
- as regras de normalização de identificadores e caminhos conforme [machine-readable-surface.md](/pt-br/spec/machine-readable-surface/),
- os formatos da entrada de índice, da entrada de changelog, do perfil de agente e do registro de decisão.

## Ferramental de implementação (não normativo)

Os SDKs e as CLIs seguem seu próprio SemVer e declaram com quais linhas da especificação são compatíveis. Neste repositório, os SDKs de referência são o pacote npm `@leji-org/leji` (packages/sdk), o pacote PyPI `leji` (packages/sdk-py) e o módulo Go `leji` (packages/sdk-go, um único binário estático); todos têm o mesmo comportamento e são testados com um único conjunto compartilhado de fixtures.
