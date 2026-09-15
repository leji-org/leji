---
source: "1262b1582c84a85bd21e37942936012c3a4048b4"
---

# O Perfil de Boot

O **perfil de boot** é o ponto de entrada da camada de contexto, independentemente do agente: um único documento legível por humanos que serve de ponto de partida para qualquer pessoa ou host de agente. Ele responde às perguntas "o que é esta camada de contexto, o que devo carregar e como devo me comportar aqui?".

## Requisitos

1. A camada de contexto **MUST** ter exatamente um perfil de boot, localizado no caminho declarado por `bootProfilePath` no manifesto. O padrão **RECOMMENDED** é `docs/boot-profile.md`.
2. O perfil de boot **MUST** ser markdown puro, legível por uma pessoa sem ferramental nenhum. Ele **MUST NOT** depender da sintaxe de configuração de nenhum fornecedor.
3. O perfil de boot **MUST** cobrir:
   - **Identidade**: o que é este repositório ou produto, em um parágrafo.
   - **Carregamento**: que contexto ler para cada tipo de tarefa. Isso **MUST** apresentar um conjunto incondicional (o que ler antes de qualquer tarefa) e, em seguida, seletores por tipo de tarefa que roteiam por caminho, por categoria ou pelo índice de contexto, além de um fallback definido para uma tarefa que não case com seletor nenhum. Enunciado em linguagem de tarefa, isso é a expressão, no nível do perfil de boot, do algoritmo de Roteamento de tarefas ([machine-readable-surface.md](/pt-br/spec/machine-readable-surface/)); segui-lo não exige conhecer esse algoritmo.
   - **Postura**: as expectativas operacionais do agente (quando seguir em frente, quando perguntar, o que nunca fazer). Isso **MAY** ser trazido por referência a conteúdo de governança ou a um perfil de agente central.
4. O perfil de boot **SHOULD** apontar para o manifesto, o índice (se houver) e os perfis de agente (se houver), para que um agente que entre por qualquer host consiga descobrir toda a superfície legível por máquina.
5. O perfil de boot **MUST** falar em linguagem de tarefa: ele nomeia caminhos literais e uma ordem de carregamento concreta, e segui-lo não exige conhecer esta especificação. O manifesto e os schemas existem para o ferramental, não para os agentes; um perfil de boot que exija conhecimento da especificação para ser seguido é um mau sinal de conformidade.
6. O perfil de boot **SHOULD** enunciar os deveres de manutenção da camada de contexto: onde as mudanças dela são registradas (o changelog declarado) e como as decisões são capturadas (o local declarado dos registros de decisão). Os validadores avisam quando o perfil de boot não referencia nenhum dos dois.
7. Os arquivos de entrada de fornecedor redirecionam para o perfil de boot conforme a regra do adaptador de fornecedor em [context-layer.md](/pt-br/spec/context-layer/).
8. O conjunto de carregamento incondicional do perfil de boot (o que ele manda ler antes de qualquer tarefa) **SHOULD** se limitar ao que toda tarefa precisa. Contexto de que apenas algumas tarefas precisam **SHOULD** ser roteado por tarefa, categoria ou pelo índice, em vez de pré-carregado; e os registros de decisão **SHOULD** ser roteados pelos `affectedPaths` / `affectedCategories` que declaram, em vez de carregados como um diretório inteiro, já que se acumulam sem limite. Tudo o que está no conjunto incondicional é pago em toda tarefa.
9. **Irmãs federadas.** Uma camada de contexto que declara `federation.mounts` (conforme [distribution.md](/pt-br/spec/distribution/)) **MUST** expor essas irmãs no perfil de boot em uma forma verificável por máquina: um ou mais blocos cercados cuja info string seja `leji-mounts`, colocados em qualquer ponto do documento, cujas entradas se concatenam na ordem do documento e carregam exatamente uma entrada por mount declarado. Uma entrada nomeia a irmã, seu dono, o que ela carrega e quando lê-la, os dois últimos na linguagem de tarefa de quem escreve. O exemplo completo está abaixo dos requisitos.

   A gramática é fixa para que toda implementação a leia de forma idêntica. Um bloco **abre** com uma linha de três ou mais crases seguida da info string e **fecha** com a linha seguinte de três ou mais crases; a quantidade de crases da cerca de fechamento não precisa coincidir com a de abertura. A info string é `leji-mounts` sozinha; uma cerca que carregue qualquer token depois dela é um erro, nunca uma cerca ignorada. As linhas de cerca **MAY** carregar recuo e preenchimento de espaço ou tabulação, e os registros entre elas **MUST NOT**: um registro começa na coluna 1 com `- mount: `, e seus campos são recuados com exatamente dois espaços ASCII. Dentro de um registro, `owner`, `carries` e `read-when` aparecem exatamente uma vez cada, em qualquer ordem; campos desconhecidos, campos duplicados e campos ausentes são erros. Um valor é o restante não vazio da sua linha depois do prefixo `key: `, sem espaço ou tabulação no início ou no fim e sem caractere de controle ou separador de linha. Espaço em branco nesta gramática é o espaço ASCII (U+0020) e a tabulação (U+0009) e mais nada, tanto no recuo e no preenchimento da linha de cerca quanto em uma linha de conteúdo; as implementações **MUST NOT** usar uma classe de espaço em branco do runtime aqui, já que elas discordam sobre caracteres como U+0085 e U+00A0 e discordariam sobre a existência de um bloco. Uma marca de ordem de bytes UTF-8 inicial é removida antes do parsing. As linhas são separadas por LF, com um CR final tolerado, linhas em branco e linhas inteiras iniciadas por `#` são ignoradas (como nos blocos de índice de categoria de [content-categories.md](/pt-br/spec/content-categories/)), e o arquivo é UTF-8. A varredura é feita por linha e não consulta a estrutura do markdown: uma linha que carregue três ou mais crases e a marca, depois de recuo opcional de espaço ou tabulação, abre um bloco real onde quer que esteja no documento, inclusive dentro de um exemplo cercado mais longo ou dentro de um item de lista. Um exemplo destinado a ilustrar em vez de declarar é, portanto, cercado com uma **marca diferente**, nunca com um token extra depois de `leji-mounts`: a marca é aquilo que o scanner reconhece, então `leji-mounts example` abre um bloco real e reporta um erro de parsing, enquanto uma cerca marcada como `text` não abre nada. `mount` **MUST** coincidir com o `name` de um mount declarado e `owner` **MUST** coincidir com o `owner.name` declarado desse mount, comparados como strings decodificadas; uma entrada para um mount não declarado, uma segunda entrada para um mesmo mount e um mount declarado sem entrada são todos erros. Uma camada que não declara mounts **MUST NOT** carregar um bloco `leji-mounts`.

   A localização da irmã deliberadamente não é um elemento: um mount é materializado em uma projeção local à máquina e endereçada por conteúdo, então um leitor a resolve com `leji mounts locate <name>` em vez de inferir um caminho (conforme [distribution.md](/pt-br/spec/distribution/)). A prosa em torno do bloco **SHOULD** explicar o roteamento com naturalidade; o bloco é o núcleo verificável, nunca um substituto dessa prosa nem da declaração em `leji.json`. As irmãs montadas são fontes distintas e nomeadas, nunca fundidas às categorias da hospedeira; o perfil de boot roteia o agente para dentro de uma irmã apenas quando a tarefa casa com o roteamento dela ou quando o perfil o exige. O que fica sem verificação é deliberado: `carries` e `read-when` são texto livre, e a fidelidade deles aos metadados de roteamento do mount é atestada pela equipe em vez de verificada pelo ferramental, que checa enumeração, identidade e presença. Expor as irmãs aqui mantém a descoberta de mounts no ponto de entrada em linguagem de tarefa do agente, de modo que seguir o requisito 5 continua não exigindo a leitura do manifesto.

### Um exemplo completo de bloco `leji-mounts`

Uma entrada, para uma hospedeira que declara um único mount chamado `acme-product-context`. O bloco fica na coluna 1 do perfil de boot, exatamente como se lê aqui; a cerca externa de quatro crases é o invólucro deste documento e não faz parte dele.

````markdown
```leji-mounts
- mount: acme-product-context
  owner: Product team
  carries: product-side domain language and the decisions behind the customer-facing surface
  read-when: a task touches product behavior, product terminology, or billing
```
````

## Perfis de agente

Uma camada de contexto **MAY** definir perfis específicos por papel (por exemplo um perfil de revisor, um perfil de release, um perfil de QA) sob um diretório declarado por `machine.agentProfilesPath`. Cada perfil:

1. **MUST** ser markdown com frontmatter YAML válido segundo [`agent-profile.schema.json`](../schemas/agent-profile.schema.json).
2. **MUST**, uma vez resolvida a herança, carregar o que o papel lê primeiro (`requiredRead`) e quando ele precisa parar e perguntar (`mustAskWhen`). Um perfil que declara `inherits` **MAY** omitir qualquer um dos dois onde sua base o fornece; um perfil que não declara **MUST** declarar os dois por conta própria.
3. **MAY** declarar `inherits`, que é operante na linha 1.0: ele nomeia exatamente um outro perfil do conjunto de perfis da camada, cujo `role` **MUST** ser `core`, e cuja postura e corpo este perfil estende. O conjunto de perfis da camada é todo documento sob o `machine.agentProfilesPath` declarado, junto com todo documento nomeado no mapa `agents` do manifesto, onde quer que esse documento esteja. A resolução é de um único nível, então um perfil cujo `role` é `core` **MUST NOT** declarar `inherits`, e o alvo nomeado **MUST** existir, **MUST** ser único por `id` e **MUST NOT** declarar `inherits` ele próprio. A resolução compõe:
   - **Arrays de postura** (`requiredRead`, `defaultContext`, `mustAskWhen`, `mustRefuseWhen`): as entradas da base na ordem em que foram escritas, depois as entradas do perfil derivado na ordem delas, descartando qualquer uma que a base já carregue. A ordem em que foram escritas é intenção de carregamento, então nada é ordenado.
   - **Todos os demais campos** (`id`, `name`, `role`, `purpose`, `version`, `host`, `invocation`, `escalation`, `owners`, `freshness`): os do próprio perfil derivado, nunca herdados. `inherits` é uma diretiva de resolução e não faz parte, ele mesmo, do perfil resolvido.
   - **Corpo**: os dois corpos são normativos, primeiro o da base, depois o do perfil derivado.

   Um consumidor que não consiga resolver um perfil herdado **MUST NOT** aplicar o arquivo derivado sozinho; o arquivo derivado é metade de um perfil, então o consumidor o reporta como não suportado. Onde uma condição de perguntar e uma condição de recusar se aplicam à mesma situação, a recusa prevalece.

   A resolução garante composição, não estreitamento semântico: prosa derivada que contradiga ou enfraqueça a base é não conforme, e nenhum ferramental detecta uma contradição em linguagem natural.

Os perfis ajustam *o que um papel carrega e como ele se comporta*; eles não duplicam conteúdo da camada de contexto.

O `host` e o `invocation` opcionais de um perfil são o atalho de ator único: eles dizem como engajar o único participante que preenche este papel. O `command` deles é um modelo que segue a mesma regra dos modelos de comando de ator, incluindo o marcador `<prompt>` e seu posicionamento (ver [context-layer.md](/pt-br/spec/context-layer/), Requisitos). Onde um papel tem mais de um participante elegível, ou onde o mesmo participante precisa de uma invocação diferente conforme o papel que preenche, o registro opcional `actors` do manifesto carrega isso em vez deles (mesma seção). Um papel usa um mecanismo ou o outro, nunca os dois.

## Notas (não normativo)

O perfil de boot é deliberadamente simples: um mapa e uma postura, não uma base de conhecimento. Se ele ocupar mais do que algumas telas, há no ponto de entrada conteúdo que deveria pertencer a uma categoria.

O problema que esse desenho procura evitar é a indireção: cada salto entre o primeiro contexto de um agente e a restrição real consome atenção. Uma camada de contexto bem implementada não precisa de nenhum ponto de entrada de fornecedor (a invocação pode apontar diretamente para o perfil de boot), e o perfil de boot leva diretamente ao conteúdo. A profundidade deve estar nos documentos da camada de contexto, nunca no caminho até eles.

Todo documento que o perfil de boot manda ler antes de qualquer tarefa é pago em toda tarefa, então o conjunto incondicional é o espaço mais caro da camada de contexto. Mantenha nele só o que é genuinamente universal, e roteie o resto por cargas tipadas por tarefa, pelas categorias, pelo índice e pelo escopo que cada registro de decisão declara. O índice existe para que um agente possa carregar a fatia de que uma tarefa precisa, em vez da árvore inteira; as decisões se acumulam sem limite, então elas são roteadas, nunca pré-carregadas como um diretório.
