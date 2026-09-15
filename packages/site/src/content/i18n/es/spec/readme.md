---
source: "8c1cff15b9d31409781d1bf0334bfd1cd9097101"
---

# La especificación Leji

**Leji es una especificación abierta para la capa de contexto compartida de los equipos nativos de IA.** Define cómo almacena, gobierna, carga y mantiene un equipo el contexto que pertenece al repositorio y que tanto las personas como los agentes de IA consultan en cada tarea.

| | |
|---|---|
| **Versión de la especificación** | 1.0.0 |
| **Estado** | GA, congelada en la versión v1.3.0 del utillaje de referencia. Los cambios incompatibles exigen una nueva versión mayor. |
| **Editor** | Vuong Nguyen |
| **Una sola página** | [La especificación completa en una sola página](https://leji.org/es/spec/full/) |

## Principios (no normativo)

1. **Intención antes que instrucciones.** Leji recoge intención duradera (qué significan las cosas, qué debe cumplirse, por qué es así) en lugar de instrucciones imperativas atadas a cada proveedor. Las personas y los agentes derivan sus acciones de la intención declarada más el contexto de la tarea.
2. **Un círculo, no un escalafón.** Los flujos persona-a-persona, persona-a-IA y persona-a-IA-a-persona son de primera clase alrededor de una única capa de contexto compartida. El acceso es igual, la autoridad no: todo el que tiene acceso a una capa de contexto la lee entera, cualquiera propone y las personas aprueban. La participación depende del rol, no de la herramienta: quien nunca toca git directamente es igual de primera clase dentro del círculo. El acceso lo concede el sistema de control de versiones, no Leji; el círculo se acota a la audiencia de una capa de contexto.
3. **Mecanismo antes que buena voluntad.** El contexto compartido se degrada por defecto: la realidad avanza, los documentos no, y nada obliga a un wiki a estar al día. Los mecanismos de forzado de Leji son mecánicos, no de buena voluntad: los cambios pasan por el mismo proceso de revisión y aprobación que el código, el utillaje falla ante desviaciones mecánicas, los horizontes de vigencia señalan lo que ha envejecido y el contenido desactualizado nunca se trata en silencio como si estuviera vigente (de forma normativa, [governance.md](/es/spec/governance/) → Vigencia).

El resto de esta especificación es la consecuencia normativa de esos tres principios.

## Lenguaje de conformidad

Las palabras clave **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY** y **OPTIONAL** en esta especificación deben interpretarse como se describe en el [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## Cómo citar esta especificación (no normativo)

Cite una sección por su título y la versión de la especificación, con un enlace permanente al ancla de la sección. En el sitio de la especificación, cada encabezado revela su ancla al pasar el cursor.

- **Formato:** Leji 1.0, §_Sección_: `https://leji.org/spec/<document>/#<anchor>`
- **Ejemplo:** Leji 1.0, §The circle, normatively: `https://leji.org/spec/governance/#the-circle-normatively`

Cite siempre la versión (`Leji 1.0`): los cambios incompatibles se publican como una nueva versión mayor, de modo que una cita fijada a una versión sigue siendo exacta cuando la especificación evoluciona.

## Vocabulario

Estos términos se usan de forma consistente en todos los documentos normativos:

| Término | Significado |
|---|---|
| **capa de contexto** (*context layer*) | El artefacto que gobierna esta especificación: un conjunto versionado, propiedad del repositorio, de documentos legibles por personas y artefactos legibles por máquinas que codifica el contexto operativo duradero de un equipo. «Capa de contexto Leji» es la forma completa desambiguadora. Escriba siempre «capa de contexto»; «capa» a secas se reserva para nombrar una instancia contable de una federación (una capa hermana, anfitriona, montada, restringida, acompañante o inaccesible). |
| **agente** (*agent*) | Un sistema de IA que actúa: carga el contexto del repositorio, realiza trabajo o colabora en él y puede proponer cambios. Es el sustantivo normativo del actor. |
| **persona** / **personas** | Participantes humanos. Las personas tienen la autoridad de aprobación. |
| **participante** | Una persona o un agente. |
| **audiencia** | Las personas y agentes admitidos a leer una capa de contexto por los permisos de su repositorio y por cualesquiera permisos de sistema de archivos o unidad compartida que expongan la copia de trabajo. «Todos leen» se acota a la audiencia de una capa de contexto; audiencias distintas se sirven con capas de contexto separadas, nunca restringiendo contenido dentro de una. |
| **host de agente** (*agent host*) | El producto o entorno de ejecución a través del cual opera un agente (por ejemplo Claude Code, Codex, Cursor). Los adaptadores de proveedor configuran los hosts de agente. |
| **herramienta** (*tool*) | Una capacidad invocable que usa un agente (shell, búsqueda, un servidor MCP). Nunca es el nombre de un producto. |
| **adaptador de proveedor** (*vendor adapter*) | Un archivo de entrada de un host de agente que redirige al perfil de arranque y nunca guarda contenido canónico. Algunos son portables entre hosts (`AGENTS.md`); otros sirven a uno solo (`CLAUDE.md`, `.cursor/rules`). La regla es la misma para ambos; la diferencia solo cambia lo que el utillaje genera por defecto. |
| **perfil de arranque** (*boot profile*) | El punto de entrada de la capa de contexto, agnóstico respecto al agente, tanto para personas como para agentes. |
| **perfil de agente** (*agent profile*) | Un documento de carga y postura específico de un rol, dirigido a agentes. |
| **IA** | Se usa como adjetivo (nativo de IA) y en los nombres de flujo **persona-a-persona**, **persona-a-IA** y **persona-a-IA-a-persona**. En los nombres de flujo, «IA» designa a agentes que operan a través de un host de agente. |
| **modelo** (*model*) | El motor predictivo sobre el que corre un agente. Los modelos no leen la capa de contexto; los agentes sí. Aparece solo donde hay que distinguir el motor del actor (por ejemplo, la selección de modelo como mecánica propia de un host). |

La jerarquía puede resumirse en una línea: un **modelo** impulsa a un **agente**; un **agente** opera a través de un **host de agente** e invoca **herramientas**; la capa de contexto se dirige a agentes y hosts, nunca a modelos directamente. La especificación es agnóstica en cada nivel de esa pila: cualquier modelo puede impulsar cualquier agente, que puede operar a través de cualquier host y leer la misma capa de contexto. «LLM» queda deliberadamente fuera de este vocabulario: designa una sola clase de modelo, mientras que la especificación es agnóstica respecto al modelo por ese mismo principio.

**Límite de alcance.** Leji 1.0 gobierna a los agentes y a los hosts de agente que cargan contexto del repositorio. La IA no agéntica (autocompletado, sugerencias en línea, chat sin contexto del repositorio) queda fuera del alcance normativo, salvo cuando opera como parte de un host de agente que carga la capa de contexto.

## Documentos normativos

En orden de lectura:

| Documento | Define |
|---|---|
| [context-layer.md](/es/spec/context-layer/) | La capa de contexto, el manifiesto, la raíz y la regla del adaptador de proveedor |
| [content-categories.md](/es/spec/content-categories/) | Las cinco categorías lógicas de contenido y cómo los archivos de índice asignan contenido a ellas |
| [boot-profile.md](/es/spec/boot-profile/) | El punto de entrada agnóstico respecto al agente que carga todo host de agente |
| [machine-readable-surface.md](/es/spec/machine-readable-surface/) | Manifiesto, índice, registro de cambios, perfiles y registros de decisión |
| [decisions.md](/es/spec/decisions/) | Registros de decisión |
| [governance.md](/es/spec/governance/) | Proponer y aprobar, responsabilidad, inclusión y retirada, vigencia |
| [distribution.md](/es/spec/distribution/) | Monorepo, submódulo multirepo, federación |
| [conformance.md](/es/spec/conformance/) | Los cuatro niveles de conformidad y la lista de comprobación |
| [versioning.md](/es/spec/versioning/) | Versionado de la especificación y de los esquemas |

Los esquemas JSON de [`../schemas/`](../schemas/) son normativos para los artefactos legibles por máquinas. Los documentos de [`../rationale/`](/es/rationale/) y [`../adoption/`](/es/adoption/) no son normativos.

## Alcance de la 1.0

**Dentro del alcance:** aportar contexto, fijar restricciones, registrar decisiones, revisar cambios y capturar patrones reutilizables; la conexión agnóstica respecto al agente y los adaptadores de proveedor (someramente); la semántica de responsabilidad y continuidad (someramente).

**Límite de extensión.** Leji 1.0 especifica la capa de contexto compartida canónica: cómo se escribe, se posee, se versiona, se propone, se aprueba, se indexa y se lee el contexto de un equipo. Deliberadamente **no** especifica los protocolos de ejecución que operan *alrededor* de esa capa de contexto: sobres de tarea, un protocolo de evidencia generalizado, el traspaso entre agentes, los protocolos de permisos de herramientas y la orquestación. Son **protocolos de extensión, no requisitos previos**: una capa de contexto conforme con 1.0 **MUST** seguir siendo útil sin ellos, y una implementación **MUST NOT** exigirlos para leer, proponer, revisar, aprobar o validar la capa de contexto. Completan el lenguaje a medida que la práctica real los demuestra; no se inventan en abstracto.

Leji **no** es un lenguaje de programación, ni un DSL, ni un entorno de ejecución, ni un SaaS. Son convenciones de markdown, esquemas JSON pequeños y semántica de gobernanza.
