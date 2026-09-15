---
source: "4075c6eda5df10f30c81842b2f6e2ebb82d2fd78"
---

# Conformidad

La adopción parcial es intencionada. Hay cuatro niveles, cada uno incluido en el siguiente, y el equipo declara el suyo en el manifiesto (`conformance.claimedLevel`). La conformidad es exclusivamente autodeclarada: no existe ningún programa de certificación.

La conformidad se evalúa contra **la capa de contexto tal como está materializada allí donde se ejecuta la comprobación**, no contra una capa canónica que una copia pudiera representar. Una copia alcanzada sin su repositorio se lee en el modo degradado de [context-layer.md](/es/spec/context-layer/), y la lectura degradada nunca es una vía hacia la autoridad canónica: una copia así no verifica, y el utillaje lo dice en vez de dejar la cuestión abierta.

La mayoría de los puntos de la lista están **verificados por máquina**: el utillaje de referencia los comprueba frente a la capa y hace fallar cualquier declaración que no se sostenga. Se informan cuatro resultados que, deliberadamente, no son intercambiables:

- **`fail`**: se reunió la evidencia y el requisito no se cumple.
- **(atestiguado por proceso)**, informado como **`manual`**: el punto describe una práctica del equipo (un proceso de revisión y aprobación, un trabajo de integración continua, un consumidor externo) que ninguna herramienta puede confirmar solo desde el repositorio, así que el equipo responde por ella. Solo los puntos etiquetados abajo como **(atestiguado por proceso)** se informan alguna vez de este modo.
- **`unknown`**: un punto de máquina cuya evidencia no se pudo obtener en esta ejecución, como la comprobación federada de alcanzabilidad de la fijación sin acceso al origen, o la disciplina de solo anexión sin una base git con la que comparar. `unknown` nunca otorga un nivel, y nunca refuta una declaración que una ejecución con evidencia podría confirmar.
- **`not applicable`**: un punto de máquina condicional que no aplica a esta capa, como los puntos federados de montajes en una capa que no declara ninguno. No se puntúa, y no es evidencia en ninguna dirección.

El `verifiedLevel` que informa el utillaje es el nivel más alto cuyos puntos aplicables **verificados por máquina** pasan todos, y **nunca por encima del nivel que la capa declara**; tanto `fail` como `unknown` impiden la concesión, y los puntos atestiguados por proceso o no aplicables no se puntúan. El tope sobre la declaración es deliberado: la verificación responde a si la declaración se sostiene, no a qué podría declarar la capa, de modo que una capa que declara `core` y cuya evidencia la llevaría a `governed` sigue informando `core`, y la forma de elevar el nivel informado es elevar la declaración. `verifiedLevel` nunca afirma los puntos atestiguados por proceso, así que un `verifiedLevel` que pasa es necesario pero no suficiente para un nivel que los lleva. Cada punto de abajo está verificado por máquina salvo que esté etiquetado como **(atestiguado por proceso)**.

Dos puntos verificados por máquina se comportan de forma distinta en una copia degradada, y la diferencia se sigue de la evidencia que tiene cada uno. La **presencia de git** queda respondida: una copia que no está en un repositorio git no cumple el requisito de `core` de que la capa de contexto viva en uno, así que el punto es `fail`. La **disciplina de solo anexión del registro de cambios** no queda respondida: el archivo puede estar perfectamente bien formado mientras el estado previo confirmado con el que compararlo es inalcanzable, así que el punto es `unknown` y la capa sencillamente no verifica en `indexed` desde esa copia. Ninguno se informa como `manual`, que queda reservado a los puntos etiquetados como atestiguados por proceso. Aparte de eso, la regla de vigencia del lector (exponer el contexto cargado desactualizado, y detenerse o preguntar ante un elemento **requerido** caducado, según [governance.md](/es/spec/governance/)) regula el comportamiento del lector; no es una comprobación que determine la conformidad: el `leji route` de referencia estampa cada documento enrutado con su horizonte de revisión y su caducidad para que un agente pueda aplicarla.

Tres puntos se verifican hoy con menos profundidad de la que declara su intención, y la brecha se nombra aquí en vez de dejar que un lector la descubra. El punto del perfil de arranque se verifica como presencia en la ruta declarada y como presencia de los encabezados de identidad, carga y postura (toda ejecución de `validate` informa de un encabezado ausente como un aviso `boot-profile-sections` que no impide continuar), y si la sección de Identidad dice algo sustancial pasa por el lint voluntario `--content`, que además señala el texto de marcador de posición en cualquier parte del perfil. El punto de la decisión real se verifica como frontmatter válido según el esquema en al menos un registro resuelto; la sustancia del cuerpo (una decisión de verdad, no un esbozo) también pasa por `--content`. El punto del registro de cambios es el tercero: la disciplina de solo anexión se comprueba contra el estado del archivo en `HEAD`, lo que detecta una reescritura que todavía esté en el árbol de trabajo, el caso para el que existe un hook de pre-commit. En una copia de integración continua el árbol de trabajo **es** `HEAD`, así que una reescritura que llega ya confirmada no le resulta visible a la comprobación, y es la revisión del conjunto de cambios la que lo cubre. El punto verifica, por tanto, el árbol de trabajo, no el historial. La intención enunciada en cada uno de los tres puntos sigue siendo normativa respecto a lo que lleva una capa de contexto conforme; profundizar las comprobaciones de máquina, y comparar el registro de cambios contra una revisión base explícita, están en la hoja de ruta del utillaje de referencia. La verificación de `federated` exige además al menos una entrada declarada en `federation.mounts`: una capa de contexto que solo provee (una que otros repositorios consumen pero que no declara montajes propios) verifica en `governed`, y su condición de federada descansa en los puntos de consumo atestiguados por proceso.

## Nivel 1: `core`

Existe una capa de contexto y tanto las personas como los agentes pueden trabajar a partir de ella.

- [ ] La capa de contexto vive en un repositorio git, versionada junto con el trabajo que describe (según [context-layer.md](/es/spec/context-layer/), Requisitos).
- [ ] `leji.json` en la raíz del repositorio, válido frente al esquema del manifiesto.
- [ ] Un perfil de arranque en la ruta declarada, que cubra identidad, carga y postura.
- [ ] Al menos `domain` o `system` asignada (mediante sus archivos de índice) y poblada con al menos un documento de **intención** resuelto (los registros por sí solos no aportan contexto operativo), más `decisions` con al menos un registro de decisión **real**: un registro con un `status` concreto y una decisión de verdad en su cuerpo, no un esbozo vacío ni un marcador de posición.
- [ ] Un responsable principal con nombre.
- [ ] Los archivos de entrada de proveedor, si existen, redirigen al perfil de arranque.

## Nivel 2: `indexed`

La capa de contexto es legible para el utillaje.

- [ ] Todo lo de `core`.
- [ ] Un índice de contexto generado, al día con el árbol.
- [ ] Un registro de cambios legible por máquinas; los cambios de la capa de contexto anexan entradas.

## Nivel 3: `governed`

Los mecanismos de forzado son mecánicos, no de buena voluntad.

- [ ] Todo lo de `indexed`.
- [ ] Los cambios de la capa de contexto requieren la revisión y aprobación del repositorio; las personas los aprueban. **(atestiguado por proceso)**
- [ ] Perfiles de agente (al menos uno con `role: core`) válidos frente al esquema de perfiles.
- [ ] La integración continua valida la superficie: manifiesto, índice que coincide con el árbol, disciplina del registro de cambios, frontmatter de perfiles, rutas declaradas que resuelven. **(atestiguado por proceso)**
- [ ] Los horizontes de vigencia están declarados y comprobados (basta con que la comprobación solo informe).

## Nivel 4: `federated`

La capa de contexto abarca una organización multirepo.

- [ ] Todo lo de `governed`.
- [ ] La capa de contexto es consumida por al menos otro repositorio como montaje fijado, y las actualizaciones de fijación llegan como conjuntos de cambios revisables. **(atestiguado por proceso)**
- [ ] Hay informe de fijaciones desactualizadas en funcionamiento: los consumidores pueden ver cuánto se han quedado atrás sus fijaciones respecto a la referencia testigo. El informe consciente de la ascendencia del SDK de referencia cubre los montajes de federación declarados; el informe del lado del consumo más allá de eso corre a cargo del equipo. **(atestiguado por proceso)**
- [ ] Cualesquiera capas de contexto hermanas se declaran como montajes fijados completos según [distribution.md](/es/spec/distribution/): un `source` normalizado y una `pin` de commit completa, con la responsabilidad intacta. El estado de materialización en una máquina concreta no es una entrada de conformidad.
- [ ] La fijación de cada montaje declarado es alcanzable desde una referencia anunciada de su `source` (el `trackingRef` declarado, o la rama por defecto del origen). Esta comprobación necesita acceso al origen: sin él el resultado es `unknown`, y `unknown` nunca otorga el nivel. Una fijación resoluble solo a través de una pista local a la máquina es disponibilidad, no conformidad.
- [ ] Cada montaje declarado lleva metadatos de enrutamiento: al menos `categories`, más `topics` o `requiredWhen`, para que un agente pueda decidir la relevancia sin leer la hermana.
- [ ] El perfil de arranque expone todas las hermanas montadas, y el índice generado lleva el array de enrutamiento `mounts`, de modo que un agente descubre y carga hermanas sin leer el manifiesto (según [boot-profile.md](/es/spec/boot-profile/) y [machine-readable-surface.md](/es/spec/machine-readable-surface/)).

## Notas (no normativo)

`core` es el mínimo que hace real una capa de contexto, `indexed` añade la superficie generada que lee el utillaje, `governed` es donde la capa de contexto deja de depender de la disciplina de nadie, y `federated` es para organizaciones donde más de un equipo ya posee una capa de contexto que merece la pena mantener entera. La mayoría de los equipos deberían llegar a `governed` y quedarse ahí; `federated` existe para esas organizaciones, no como insignia de madurez.
