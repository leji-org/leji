---
source: "9550ceea3130bc921e029e51d882c675dbcc3564"
---

# Decisiones

Los registros de decisión recogen, con fecha, el *porqué* de la capa de contexto: decisiones de arquitectura, selección de proveedores, límites de alcance y decisiones deliberadas de no actuar. Evitan reabrir debates ya resueltos y proporcionan a los agentes el razonamiento, no solo la regla.

Los registros de decisión son el subtipo formal de **registro** (véase [content-categories.md](/es/spec/content-categories/), Intención y registros): son registros por naturaleza, con un esquema y un ciclo de vida uniformes que los registros genéricos no tienen. Sus entradas de índice generadas llevan `kind: record`; un registro de decisión no declara clave `kind` propia (el esquema es cerrado, así que un `kind` explícito falla la validación).

## Requisitos

1. Los registros de decisión son markdown con frontmatter YAML válido frente a [`decision-record.schema.json`](../schemas/decision-record.schema.json), un registro por archivo. El corpus de decisiones es la unión de dos superficies declaradas en el manifiesto, y una capa de contexto **MAY** usar cualquiera de las dos o ambas: la ruta de registros declarada (`machine.decisionRecordsPath`, por defecto `<root>/decisions/`) y las entradas a las que resuelven los archivos de índice de la categoría `decisions`. Un registro **MUST** ser alcanzable a través de al menos una de las dos.
2. El frontmatter **MUST** llevar: `id` (estable), `title`, `status` y `date`. `status` es uno de `proposed`, `accepted`, `superseded`, `deprecated` o `rejected`.
3. El cuerpo **MUST** enunciar, en prosa: el contexto (qué situación obligó a decidir), la decisión en sí y sus consecuencias. Los encabezados de sección **RECOMMENDED** son `## Context`, `## Decision` y `## Consequences`; un registro **MAY** añadir `## Alternatives`.
4. Los registros son **historia de solo anexión**: un registro **MUST NOT** editarse para convertirlo en una decisión distinta. Dos campos del frontmatter son **mutables** a medida que una decisión envejece, `status` (su ciclo de vida) y `supersededBy` (que se fija cuando queda sustituida); todo lo demás, el `id`, el `title` y la `date` originales, el alcance declarado y el cuerpo en prosa, es **inmutable** una vez publicado. Una reversión o un cambio es un registro nuevo cuyo frontmatter fija `supersedes`, y el `status` del registro antiguo pasa a `superseded` con `supersededBy` fijado. El enlace de sustitución **MUST** mantenerse consistente en ambas direcciones: cuando el registro B fija `supersedes: A`, el registro A lleva `status: superseded` y `supersededBy: B`, y un registro `superseded` **MUST** nombrar a su sucesor en `supersededBy`. Ambos registros permanecen. El utillaje de referencia comprueba hoy la consistencia bidireccional de la sustitución. Todavía no verifica la inmutabilidad en sí (que los campos congelados y el cuerpo de un registro publicado no hayan cambiado frente a una revisión base); eso es una comprobación con informe que está en la hoja de ruta, todavía no una comprobación cuyo fallo impida continuar. Hasta que llegue, la inmutabilidad se apoya en la disciplina de revisión atestiguada por proceso (véase [conformance.md](/es/spec/conformance/)).
5. Un registro **MAY** declarar `affectedPaths` y `affectedCategories`, para que el utillaje pueda encaminar desde el alcance de una tarea hacia las decisiones que la gobiernan. Cómo selecciona registros el alcance de una tarea (contención de rutas consciente del solapamiento, coincidencia estrecha de categoría, la vinculación de `accepted` / `deprecated` y el tratamiento de ámbito organizativo de un registro que no declara ninguno de los dos) es el algoritmo de enrutamiento por tarea de [machine-readable-surface.md](/es/spec/machine-readable-surface/).
6. Las propuestas rechazadas también son registros (`status: rejected`). Una decisión que no se tomó, puesta por escrito, es el seguro más barato que hay contra volver a litigarla.

## Compatibilidad con ADR (no normativo)

Los registros de decisión de Leji se han diseñado para ser compatibles con los Architecture Decision Records: un directorio de ADR existente satisface `decisions` si se añaden los campos de frontmatter a cada registro (o a los nuevos a partir de ese momento) y se asigna el directorio en el manifiesto. No se exige ninguna herramienta de ADR ni se excluye ninguna.
