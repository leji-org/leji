---
source: "a3eeaf11354342889990125636ea6bac78512d34"
---

# Categorias de Conteúdo

Leji define cinco categorias **lógicas** de conteúdo. Elas classificam *a finalidade* de um documento, não o local onde ele fica: os nomes das categorias são identificadores estáveis usados pelo manifesto, pelo índice e pelas ferramentas. Os nomes dos diretórios ficam a critério da equipe.

## As cinco categorias

| Categoria | O que pertence a ela |
|---|---|
| `domain` | Linguagem de negócio e semântica de produto, nas palavras da própria equipe: o que significam os substantivos centrais, como eles se relacionam, os termos com sentido local. Registros de estado de negócio (o status de um engajamento, um retrato de mercado) também se classificam aqui, como registros. |
| `system` | Arquitetura e seus invariantes: fronteiras de serviço, propriedade de dados, contratos de integração, modelos de consistência, contratos de falha, as restrições com as quais toda mudança convive. Avaliações técnicas e panoramas de sistema se classificam aqui, como registros. |
| `practice` | Convenções e padrões aplicados automaticamente: convenções de código, padrões de teste e os padrões de prompt e de fluxo de trabalho que já se provaram (ver o critério de inclusão abaixo). Registros da aplicação de um método (uma retrospectiva, o log de execução de um runbook) se classificam aqui, como registros. |
| `governance` | Travas de proteção de agentes e regras operacionais: o que os agentes podem fazer sem serem solicitados, o que exige aprovação humana, regras de tratamento de dados, gatilhos de escalonamento, controles de conformidade regulatória. Evidência de governança (um log de auditoria, um relatório de revisão) se classifica aqui, como registros. |
| `decisions` | Registros datados do porquê de as coisas serem como são, conforme [decisions.md](/pt-br/spec/decisions/). |

## Intenção e registros

Todo documento governado é ou **intenção** ou um **registro**, independentemente de sua categoria:

- **Intenção** é verdade presente mantida: glossários, invariantes, convenções, travas de proteção. Os leitores contam com ela como atual, então, quando a realidade muda, o documento é corrigido. A intenção é a razão de existirem os horizontes de revisão e o mecanismo de atualidade (ver [governance.md](/pt-br/spec/governance/)).
- Um **registro** preserva afirmações dentro de um limite temporal ou de evento explícito: status, avaliações, livros-razão, panoramas, resultados de reunião, arquivos. O estado posterior **supera** um registro em vez de corrigi-lo; o original continua sendo um relato válido do seu tempo. A superfície de atualidade de um registro é sua **data**, nunca um horizonte de revisão.

Para classificar, basta fazer uma pergunta: *se uma informação posterior contradisser este documento, será preciso corrigi-lo porque os leitores contam com ele como atual, ou a nova informação o substituirá enquanto o original permanece um relato válido de seu tempo?* Se precisa ser corrigido, é intenção; se for substituído, é registro.

Um registro é governado exatamente como a intenção: indexado, revisado, com dono e roteado. O que difere é o que um leitor pode fazer com ele: um leitor **MUST NOT** tratar um registro como intenção atual; ele é evidência datada (ver [context-layer.md](/pt-br/spec/context-layer/), Lendo um registro). Os registros de decisão são o subtipo formal de registro: são registros por natureza, com schema e ciclo de vida próprios conforme [decisions.md](/pt-br/spec/decisions/).

Algumas perguntas sobre registros ficaram deliberadamente fora da 1.0 e são reconhecidas em vez de escondidas: não existe noção de máquina para uma *série* de registros (então o ferramental nunca certifica qual registro é "o mais recente"), não existe mecanismo de recência de fluxo (se o próximo registro esperado está atrasado) e não existem tipos por seção para documentos que misturem materialmente conteúdo de intenção e de registro. Um documento misto **SHOULD** ser dividido; onde dividir for desproporcional, classifique pelo contrato do qual os leitores a jusante principalmente dependem. Conteúdo que honestamente não cabe em nenhuma categoria permanece como referência; a classificação não promete ser livre de julgamento.

## Requisitos

1. O manifesto **MUST** mapear cada categoria que declara para um ou mais **arquivos de índice** relativos à raiz do repositório (`categories.<id>.indexes`); cada arquivo de índice **SHOULD** ficar sob a raiz do contexto declarada, conforme [context-layer.md](/pt-br/spec/context-layer/). Um arquivo de índice declara inclusão, ele não realoca: o conteúdo permanece onde a equipe já o guarda (por exemplo `business/`, `technology/`, `architecture/`), e um mesmo diretório pode contribuir com documentos para mais de uma categoria sem renomear nada.
2. Um arquivo de índice é markdown curado que carrega um ou mais blocos de código cercados com a marca `leji-index`. Um bloco **abre** com uma linha de três ou mais crases seguida da info string do bloco e **fecha** com a linha seguinte de três ou mais crases; a quantidade de crases da cerca de fechamento não precisa coincidir com a de abertura. Exatamente três info strings são válidas: `leji-index` (um bloco de intenção), `leji-index intent` (o mesmo, de forma explícita) e `leji-index record` (um bloco de registros, cujas entradas resolvem como registros). Qualquer outro token depois de `leji-index` é um erro de parsing, nunca ignorado em silêncio: a gramática é finita por projeto. Cada bloco lista conteúdo, uma entrada por linha, como `- path: <repository-root-relative-path>`, onde um caminho é um diretório (seu markdown é incluído recursivamente) ou um único arquivo markdown. Um caminho **MUST** ser POSIX relativo à raiz do repositório: uma `/` inicial, um segmento `..` ou uma barra invertida é inválido e rejeitado. Linhas em branco e comentários `#` de linha inteira são ignorados, e uma entrada **MAY** trazer ao final um `# comment` precedido de espaço em branco. Espaço em branco nesta gramática é o espaço ASCII (U+0020) e a tabulação (U+0009) e mais nada, em todo lugar em que a gramática o consulta: em torno das crases da cerca e da info string, como preenchimento inicial e final em uma linha de entrada, e antes do `#` que abre um comentário final. Uma marca de ordem de bytes UTF-8 inicial é removida antes do parsing. As linhas são separadas por LF, com um CR final tolerado, e o arquivo é UTF-8. As implementações **MUST NOT** usar uma classe de espaço em branco do runtime aqui: qualquer outro caractere que um runtime por acaso classifique como espaço em branco, entre eles U+0085 e U+00A0, é conteúdo comum de caminho, de modo que uma entrada cujo caminho carregue um deles é reportada como ausente em vez de ser silenciosamente aparada. Os blocos `leji-mounts` de [boot-profile.md](/pt-br/spec/boot-profile/) estão congelados sobre o mesmo alfabeto, de modo que um único scanner lê as duas gramáticas e três implementações não podem discordar sobre se uma cerca sequer existe. Vários blocos em um mesmo arquivo são concatenados na ordem do documento. Prosa e títulos ao redor dos blocos são permitidos, então um arquivo de índice serve também como mapa legível por humanos da categoria. A varredura é feita por linha e não consulta a estrutura do markdown: uma linha que carregue três ou mais crases e a marca, depois de recuo opcional de espaço ou tabulação, abre um bloco real onde quer que esteja no documento, inclusive dentro de um exemplo cercado mais longo ou dentro de um item de lista. Um exemplo destinado a ilustrar em vez de declarar é, portanto, cercado com uma **marca diferente**, nunca com um token extra depois de `leji-index`: a marca é aquilo que o scanner reconhece, então `leji-index example` abre um bloco real e reporta um erro de parsing, enquanto uma cerca marcada como `text` não abre nada. O local **RECOMMENDED** é `context/<id>.md` sob a raiz do contexto; o local é configurável e o ferramental nunca o fixa no código.
3. Uma camada de contexto **MUST** mapear ao menos `domain` ou `system`, mais `decisions`, para declarar qualquer nível de conformidade (ver [conformance.md](/pt-br/spec/conformance/)), e o mínimo populado de `domain`/`system` **MUST** incluir ao menos um documento de **intenção**: uma camada de contexto feita só de registros preserva histórico, mas não carrega contexto operacional. As demais categorias vão se acumulando conforme a equipe esbarra em perguntas reais; uma categoria vazia (aquela cujos arquivos de índice não resolvem para documento nenhum) **MUST NOT** ser mapeada para satisfazer um checklist.
4. Um documento resolve para exatamente uma categoria e um tipo. As entradas de índice são **seletores**, e a resolução segue a **especificidade do seletor**: um seletor de arquivo direto vence qualquer seletor de diretório, e um seletor de diretório mais profundo vence um seletor de diretório ancestral. O seletor mais específico que cobre um documento determina sua categoria e o tipo do seu bloco; um documento que um seletor mais amplo cobre, mas que um seletor mais específico vence, simplesmente não é conteúdo daquele seletor mais amplo (que é como se expressa um arquivo mantido atual dentro de um diretório de registros, ou o log de decisões de uma equipe dentro de uma árvore mapeada mais ampla, sem mover nada). Seletores de especificidade **igual** que discordem quanto à categoria ou ao tipo são um erro, nunca resolvido pela ordem do índice; atribuições idênticas de igual especificidade resolvem uma única vez, enquanto uma entrada literalmente duplicada dentro de um mesmo arquivo de índice é rejeitada. O ferramental **SHOULD** expor um seletor cujos documentos cobertos foram todos vencidos por seletores mais específicos (um seletor *sombreado*): peso morto no mapa curado, nunca um erro. Fora isso, a resolução é determinística: uma entrada de diretório se expande para o markdown dela em ordem lexicográfica POSIX (por ponto de código Unicode; **RECOMMENDED** que os caminhos permaneçam em ASCII para que a ordem não seja ambígua entre implementações), e qualquer caminho cuja localização real (depois de resolver links simbólicos) escape da **raiz do repositório** é excluído em vez de seguido. As entradas de índice (ver [machine-readable-surface.md](/pt-br/spec/machine-readable-surface/)) carregam o identificador da categoria e o tipo.
5. Um documento **MAY** declarar seu tipo no frontmatter (`kind: intent` ou `kind: record`); o frontmatter sobrepõe o tipo de bloco do seletor vencedor e **nunca** a categoria. Qualquer outro valor de `kind` é um erro. Registros de decisão não aceitam a chave `kind` (o schema deles é fechado e eles são registros por natureza). Um registro **MAY** trazer uma `date` no frontmatter (`YYYY-MM-DD`); o ferramental lê a data de um registro **somente** desse campo, nunca da prosa, de convenções de cabeçalho ou de nomes de arquivo. Um registro **MUST NOT** carregar `freshness.reviewAfter` (um horizonte de revisão é um mecanismo de intenção; em um registro, ele promete uma atualidade que o documento não pode ter, e isso é um erro).
6. Conteúdo de prática que descreve padrões de prompt ou de fluxo de trabalho **SHOULD** ser capturado somente depois que o padrão tiver funcionado ao menos duas vezes (o critério de comprovação em duas tarefas). A captura prematura é como os diretórios de prática se enchem de aspiração.

## Notas (não normativo)

Nem toda categoria está presente no primeiro dia. A camada de contexto mínima viável é aquilo de que o primeiro mês de trabalho realmente depende. As categorias existem para que uma pessoa ou um agente possa perguntar "que tipo de verdade é esta?" e carregar a fatia que importa para a tarefa em mãos, em vez da árvore inteira.

Os dois tipos existem porque a documentação de um repositório real é formada por dois corpora entrelaçados com modelos de verdade diferentes, e forçar a metade operacional sob a semântica de intenção falha dos dois lados: promessas de atualidade que não podem ser honradas, ou a maior parte do repositório exilada fora da governança. Um exemplo completo do formato, com uma exceção de intenção dentro de um diretório de registros:

````markdown
# Contexto de domínio

```leji-index
- path: docs/glossary.md
```

O estado operacional é governado como registros; a política de escalonamento permanece intenção.

```leji-index record
- path: docs/operations/
```

```leji-index intent
- path: docs/operations/escalation-policy.md
```
````
