---
source: "4075c6eda5df10f30c81842b2f6e2ebb82d2fd78"
---

# Conformidade

A adoção parcial é intencional. Há quatro níveis, cada um incluindo o anterior, e a equipe declara o seu no manifesto (`conformance.claimedLevel`). A declaração é sempre própria: não existe programa de certificação.

A conformidade é avaliada com base **na camada de contexto materializada no local em que a verificação é executada**, não em uma camada canônica que uma cópia talvez represente. Uma cópia acessada sem o repositório correspondente é lida no modo degradado de [context-layer.md](/pt-br/spec/context-layer/), e a leitura degradada nunca leva à autoridade canônica: essa cópia não pode ser verificada, e as ferramentas deixam isso explícito em vez de manter a questão em aberto.

A maior parte dos itens do checklist é **verificada por máquina**: o ferramental de referência os checa contra a camada e reprova uma declaração que eles não sustentem. Quatro resultados são reportados, e eles deliberadamente não são intercambiáveis:

- **`fail`**: a evidência foi reunida e o requisito não é atendido.
- **(atestado por processo)**, reportado como **`manual`**: o item descreve uma prática da equipe (um processo de revisão e aprovação, um job de CI, um consumidor externo) que nenhuma ferramenta consegue confirmar apenas a partir do repositório, então a equipe responde por ele. Só os itens marcados com **(atestado por processo)** abaixo são reportados dessa forma.
- **`unknown`**: um item de máquina cuja evidência foi impossível de obter nesta execução, como a verificação federada de alcançabilidade do pin sem acesso à origem, ou a disciplina de somente acréscimo sem uma linha de base git para comparar. `unknown` nunca concede um nível, e nunca refuta uma declaração que uma execução com evidência poderia confirmar.
- **`not applicable`**: um item de máquina condicional que não se aplica a esta camada, como os itens federados de mount em uma camada que não declara mounts. Ele não é pontuado, e não é evidência em nenhuma direção.

O `verifiedLevel` que o ferramental reporta é o nível mais alto cujos itens aplicáveis **verificados por máquina** passam todos, **nunca acima do nível que a camada declara**; `fail` e `unknown` ambos impedem a concessão, e itens atestados por processo ou não aplicáveis não são pontuados. O teto sobre a declaração é deliberado: a verificação responde se a declaração se sustenta, não o que a camada poderia declarar, então uma camada que declara `core` cuja evidência a levaria a `governed` ainda reporta `core`, e o jeito de elevar o nível reportado é elevar a declaração. O `verifiedLevel` nunca afirma os itens atestados por processo, então um `verifiedLevel` aprovado é necessário, mas não suficiente, para um nível que os carregue. Cada item abaixo é verificado por máquina, a menos que esteja marcado com **(atestado por processo)**.

Dois itens verificados por máquina se comportam de forma diferente em uma cópia degradada, e a diferença decorre da evidência que cada um tem. A **presença do git** é respondida: uma cópia que não está em um repositório git não atende ao requisito de `core` de que a camada de contexto viva em um, então o item é `fail`. A **disciplina de somente acréscimo do changelog** não é respondida: o arquivo pode estar inteiramente bem formado enquanto o estado commitado anterior necessário para a comparação está inalcançável, então o item é `unknown` e a camada simplesmente não se verifica em `indexed` a partir daquela cópia. Nenhum dos dois é reportado como `manual`, que fica reservado aos itens marcados como atestados por processo. À parte disso, a regra de atualidade para o leitor (expor contexto carregado desatualizado, e parar ou perguntar diante de um item **obrigatório** vencido, conforme [governance.md](/pt-br/spec/governance/)) descreve o comportamento do leitor, não uma verificação que condiciona a conformidade: o `leji route` de referência carimba cada documento roteado com seu horizonte de revisão e seu vencimento, para que um agente possa aplicá-la.

Três itens são hoje verificados com menos profundidade do que sua intenção declarada, e a lacuna é nomeada aqui em vez de ser deixada para o leitor descobrir. O item do perfil de boot é verificado como presença no caminho declarado e como presença dos cabeçalhos de identidade, carregamento e postura (toda execução de `validate` reporta um cabeçalho ausente como um aviso `boot-profile-sections`, sem bloquear a validação), e se a seção de identidade diz algo substantivo depende do lint opcional `--content`, que também sinaliza texto de espaço reservado em qualquer ponto do perfil. O item da decisão real é verificado como frontmatter válido segundo o schema em ao menos um registro resolvido; a substância do corpo (uma decisão de verdade, não um esboço) também depende de `--content`. O item do changelog é o terceiro: a disciplina de somente acréscimo é verificada contra o estado do arquivo em `HEAD`, o que pega uma reescrita ainda na árvore de trabalho, que é o caso para o qual existe um hook de pre-commit. Em um checkout de integração contínua, a árvore de trabalho **é** o `HEAD`, então uma reescrita que chega já commitada não é visível para a verificação, e quem a cobre é a revisão do conjunto de mudanças. O item, portanto, verifica a árvore de trabalho, não o histórico. A intenção declarada em cada um dos três itens permanece normativa quanto ao que uma camada de contexto conforme carrega; aprofundar as verificações de máquina, e comparar o changelog contra uma revisão base explícita, estão no roteiro do ferramental de referência. A verificação de `federated` exige adicionalmente ao menos uma entrada declarada em `federation.mounts`: uma camada de contexto apenas provedora (consumida por outros repositórios, mas que não declara mounts próprios) se verifica em `governed`, e sua posição federada se apoia nos itens de consumo atestados por processo.

## Nível 1: `core`

Existe uma camada de contexto e tanto pessoas quanto agentes conseguem trabalhar a partir dela.

- [ ] A camada de contexto vive em um repositório git, versionada junto com o trabalho que descreve (conforme [context-layer.md](/pt-br/spec/context-layer/), Requisitos).
- [ ] `leji.json` na raiz do repositório, válido segundo o schema do manifesto.
- [ ] Um perfil de boot no caminho declarado, cobrindo identidade, carregamento e postura.
- [ ] Ao menos `domain` ou `system` mapeada (por seus arquivos de índice) e populada com ao menos um documento de **intenção** resolvido (só registros não carregam contexto operacional), mais `decisions` com ao menos um registro de decisão **real**: um registro que carregue um `status` concreto e uma decisão de verdade no corpo, não um esboço vazio ou um texto de espaço reservado.
- [ ] Um dono primário nomeado.
- [ ] Os arquivos de entrada de fornecedor, se presentes, redirecionam para o perfil de boot.

## Nível 2: `indexed`

A camada de contexto é legível para o ferramental.

- [ ] Tudo de `core`.
- [ ] Um índice de contexto gerado, atualizado com a árvore.
- [ ] Um changelog legível por máquina; as mudanças na camada de contexto acrescentam entradas.

## Nível 3: `governed`

Os mecanismos de imposição são mecânicos, não de boa vontade.

- [ ] Tudo de `indexed`.
- [ ] As mudanças na camada de contexto passam pelo processo de revisão e aprovação do repositório; pessoas aprovam. **(atestado por processo)**
- [ ] Perfis de agente (ao menos um com `role: core`) válidos segundo o schema de perfil.
- [ ] O CI valida a superfície: manifesto, índice condizente com a árvore, disciplina de changelog, frontmatter de perfil, caminhos declarados que resolvem. **(atestado por processo)**
- [ ] Os horizontes de atualidade são declarados e verificados (uma verificação que apenas relata o resultado é aceitável).

## Nível 4: `federated`

A camada de contexto abrange uma organização multirrepo.

- [ ] Tudo de `governed`.
- [ ] A camada de contexto é consumida por ao menos um outro repositório como um mount fixado, com as atualizações de pin chegando como conjuntos de mudanças revisáveis. **(atestado por processo)**
- [ ] O relato de pin desatualizado está em funcionamento: os consumidores conseguem ver o quanto seus pins ficam atrás da ref testemunha. O relatório ciente de ancestralidade do SDK de referência cobre os mounts de federação declarados; o relato do lado do consumo além disso é da equipe. **(atestado por processo)**
- [ ] Quaisquer camadas de contexto irmãs são declaradas como mounts fixados completos conforme [distribution.md](/pt-br/spec/distribution/): um `source` normalizado e um `pin` de commit completo, com a propriedade intacta. O estado de materialização em qualquer máquina não é entrada de conformidade.
- [ ] O pin de cada mount declarado é alcançável a partir de uma ref anunciada de seu `source` (o `trackingRef` declarado, ou o branch padrão da origem). Esta verificação precisa de acesso à origem: sem ele o resultado é `unknown`, e `unknown` nunca concede o nível. Um pin resolvível apenas por uma dica local à máquina é disponibilidade, não conformidade.
- [ ] Cada mount declarado carrega metadados de roteamento: ao menos `categories`, mais `topics` ou `requiredWhen`, para que um agente possa decidir a relevância sem ler a irmã.
- [ ] O perfil de boot expõe toda irmã montada, e o índice gerado carrega o array de roteamento `mounts`, para que um agente descubra e carregue as irmãs sem ler o manifesto (conforme [boot-profile.md](/pt-br/spec/boot-profile/), [machine-readable-surface.md](/pt-br/spec/machine-readable-surface/)).

## Notas (não normativo)

`core` é o mínimo que torna uma camada de contexto real, `indexed` acrescenta a superfície gerada que o ferramental lê, `governed` é onde a camada de contexto deixa de depender da disciplina de alguém, e `federated` é para organizações em que mais de uma equipe já é dona de uma camada de contexto que vale manter inteira. A maioria das equipes deveria chegar a `governed` e parar por aí; `federated` existe para aquelas organizações, não como um selo de maturidade.
