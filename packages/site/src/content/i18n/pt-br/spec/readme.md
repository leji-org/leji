---
source: "8c1cff15b9d31409781d1bf0334bfd1cd9097101"
---

# A Especificação Leji

**Leji é uma especificação aberta para a camada de contexto compartilhada de equipes nativas de IA.** Ela define como uma equipe armazena, governa, carrega e mantém o contexto pertencente ao repositório, consultado por pessoas e agentes de IA a cada tarefa.

| | |
|---|---|
| **Versão da especificação** | 1.0.0 |
| **Status** | GA, congelada na versão publicada v1.3.0 do ferramental de referência. Mudanças incompatíveis exigem uma nova versão maior. |
| **Editor** | Vuong Nguyen |
| **Página única** | [A especificação completa em uma única página](/pt-br/spec/full/) |

## Princípios (não normativo)

1. **Intenção acima de instruções.** Leji registra a intenção duradoura (o que as coisas significam, o que precisa valer e por que é assim) em vez de instruções imperativas específicas de cada fornecedor. Pessoas e agentes definem suas ações com base na intenção declarada e no contexto da tarefa.
2. **Um círculo, não um degrau.** Humano para humano, humano para IA e humano para IA para humano são fluxos de primeira classe em torno de uma única camada de contexto compartilhada. Acesso igual, não autoridade igual: todo mundo com acesso a uma camada de contexto lê tudo, qualquer um propõe, pessoas aprovam. A participação é definida pelo papel, não pela ferramenta: quem nunca toca no git diretamente é participante de primeira classe no círculo. Conceder o acesso em si cabe ao sistema de controle de versão, não ao Leji; o círculo tem como escopo o público de uma camada de contexto.
3. **Mecanismo acima de boa vontade.** Por padrão, o contexto compartilhado se deteriora: a realidade muda, os documentos não, e nada obriga um wiki a permanecer atualizado. Os mecanismos de imposição do Leji são mecânicos, não dependem de boa vontade: as mudanças passam pelo mesmo processo de revisão e aprovação que o código, as ferramentas falham diante de desvios mecânicos, os horizontes de atualidade sinalizam o que envelheceu, e o contexto desatualizado nunca é tratado silenciosamente como atual (normativamente, [governance.md](/pt-br/spec/governance/) → Atualidade).

O restante desta especificação é a consequência normativa desses três princípios.

## Linguagem de conformidade

As palavras-chave **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY** e **OPTIONAL** nesta especificação devem ser interpretadas conforme descrito na [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## Como citar esta especificação (não normativo)

Cite uma seção pelo título e pela versão da especificação, com um link permanente para a âncora da seção. No site da especificação, cada título revela sua âncora ao passar o cursor.

- **Formato:** Leji 1.0, §_Seção_: `https://leji.org/spec/<document>/#<anchor>`
- **Exemplo:** Leji 1.0, §The circle, normatively: `https://leji.org/spec/governance/#the-circle-normatively`

Cite sempre a versão (`Leji 1.0`): mudanças incompatíveis são publicadas como uma nova versão maior, então uma citação presa a uma versão continua exata depois que a especificação evolui.

## Vocabulário

Estes termos são usados de forma consistente em todos os documentos normativos:

| Termo | Significado |
|---|---|
| **camada de contexto** (context layer) | O artefato que esta especificação governa: um conjunto versionado de documentos legíveis por humanos e artefatos legíveis por máquina, pertencente ao repositório, que codifica o contexto operacional duradouro de uma equipe. "Camada de contexto Leji" é a forma completa e desambiguadora. Escreva sempre "camada de contexto"; o termo isolado "camada" fica reservado para nomear uma instância contável de federação (uma camada de contexto irmã, hospedeira, montada, restrita, complementar ou inacessível). |
| **agente** (agent) | Um sistema de IA que age: carrega o contexto do repositório, executa ou apoia o trabalho e pode propor mudanças. É o substantivo normativo para o ator. |
| **pessoa** / **pessoas** | Participantes humanos. As pessoas detêm a autoridade de aprovação. |
| **participante** | Uma pessoa ou um agente. |
| **público** (audience) | As pessoas e os agentes admitidos a ler uma camada de contexto pelas permissões do repositório e por quaisquer permissões de sistema de arquivos ou de disco compartilhado que exponham o checkout. "Todo mundo lê" tem como escopo o público de uma camada de contexto; públicos diferentes são atendidos por camadas de contexto separadas, nunca por restrição de conteúdo dentro de uma delas. |
| **host de agente** (agent host) | O produto ou runtime através do qual um agente opera (por exemplo Claude Code, Codex, Cursor). Os adaptadores de fornecedor configuram hosts de agente. |
| **ferramenta** (tool) | Uma capacidade invocável que um agente usa (shell, busca, um servidor MCP). Nunca um nome de produto. |
| **adaptador de fornecedor** (vendor adapter) | Um arquivo de entrada de um host de agente que redireciona para o perfil de boot e nunca guarda conteúdo canônico. Alguns são portáveis entre hosts (`AGENTS.md`); outros servem a um único host (`CLAUDE.md`, `.cursor/rules`). A regra é a mesma para ambos; a diferença muda apenas o que o ferramental gera por padrão. |
| **perfil de boot** (boot profile) | O ponto de entrada agnóstico de agente da camada de contexto, tanto para pessoas quanto para agentes. |
| **perfil de agente** (agent profile) | Um documento de carregamento e postura específico de um papel, dirigido a agentes. |
| **IA** (AI) | Usado como adjetivo (nativo de IA) e nos nomes de fluxo **humano para humano**, **humano para IA**, **humano para IA para humano**. Nos nomes de fluxo, "IA" se refere a agentes operando através de um host de agente. |
| **modelo** (model) | O motor preditivo sobre o qual um agente roda. Modelos não leem a camada de contexto; agentes leem. Aparece apenas onde o motor precisa ser distinguido do ator (por exemplo, a escolha de modelo como mecânica específica do host). |

A hierarquia, em uma linha: um **modelo** move um **agente**; um **agente** opera através de um **host de agente** e chama **ferramentas**; a camada de contexto se dirige a agentes e hosts, nunca diretamente a modelos. A especificação é agnóstica em todos os níveis dessa pilha: qualquer modelo, movendo qualquer agente, operando através de qualquer host, lendo a mesma camada de contexto. "LLM" foi deliberadamente deixado fora deste vocabulário: nomeia uma classe de modelo, e a especificação é agnóstica de modelo pelo mesmo princípio.

**Limite de escopo.** Leji 1.0 governa agentes e os hosts de agente que carregam contexto de repositório. IA não agêntica (autocompletar, sugestões em linha, chat sem contexto do repositório) está fora do escopo normativo, exceto quando opera como parte de um host de agente que carrega a camada de contexto.

## Documentos normativos

Em ordem de leitura:

| Documento | Define |
|---|---|
| [context-layer.md](/pt-br/spec/context-layer/) | A camada de contexto, o manifesto, a raiz, a regra do adaptador de fornecedor |
| [content-categories.md](/pt-br/spec/content-categories/) | As cinco categorias lógicas de conteúdo e como os arquivos de índice mapeiam conteúdo para elas |
| [boot-profile.md](/pt-br/spec/boot-profile/) | O ponto de entrada agnóstico de agente que todo host de agente carrega |
| [machine-readable-surface.md](/pt-br/spec/machine-readable-surface/) | Manifesto, índice, changelog, perfis, registros de decisão |
| [decisions.md](/pt-br/spec/decisions/) | Registros de decisão |
| [governance.md](/pt-br/spec/governance/) | Propor/aprovar, propriedade, inclusão e remoção, atualidade |
| [distribution.md](/pt-br/spec/distribution/) | Monorepo, submódulo multirrepo, federação |
| [conformance.md](/pt-br/spec/conformance/) | Os quatro níveis de conformidade e o checklist |
| [versioning.md](/pt-br/spec/versioning/) | Versionamento da especificação e dos schemas |

Os JSON Schemas em [`../schemas/`](../schemas/) são normativos para os artefatos legíveis por máquina. Os documentos em [`../rationale/`](/pt-br/rationale/) e [`../adoption/`](/pt-br/adoption/) não são normativos.

## Escopo da 1.0

**No escopo:** fornecer contexto, estabelecer restrições, registrar decisões, revisar mudanças e capturar padrões reutilizáveis; ligação agnóstica de agente e adaptadores de fornecedor (de forma leve); semântica de propriedade e continuidade (de forma leve).

**Limite de extensão.** Leji 1.0 especifica a camada de contexto compartilhada canônica: como o contexto de uma equipe é escrito, possuído, versionado, proposto, aprovado, indexado e lido. Ela deliberadamente **não** especifica os protocolos de execução que operam *ao redor* dessa camada de contexto: envelopes de tarefa, um protocolo generalizado de evidência, repasse entre agentes, protocolos de permissão de ferramentas e orquestração. Esses são **protocolos de extensão, não pré-requisitos**: uma camada de contexto conforme com a 1.0 **MUST** continuar útil sem eles, e uma implementação **MUST NOT** exigi-los para ler, propor, revisar, aprovar ou validar a camada de contexto. Eles completam a linguagem à medida que a prática real os comprova; não são inventados no abstrato.

Leji **não** é uma linguagem de programação, uma DSL, um runtime ou um SaaS. É um conjunto de convenções em markdown, pequenos JSON Schemas e semântica de governança.
