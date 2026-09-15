---
source: "954281dd7ebde528ca176407d310556ec7749057"
---

# Versionado

La especificación, los esquemas y el utillaje que los implementa se versionan de forma independiente.

## La especificación

1. La especificación lleva una versión SemVer (actualmente **1.0.0**). Los cambios incompatibles exigen una versión mayor; todo cambio se anota en el registro de cambios del repositorio.
2. Una capa de contexto declara la línea de especificación a la que apunta en `leji.json` mediante la clave autonombrada `leji` (por ejemplo `"leji": "1.0"`), siguiendo la convención de OpenAPI. El valor es la **línea** de la especificación (`major.minor`), nunca su versión de parche: una versión de parche (`1.0.0` a `1.0.1`) refina la redacción o el utillaje sin mover la línea, así que el manifiesto se queda en `"1.0"` a lo largo de cada parche. El utillaje **MUST** validar una capa de contexto contra la línea declarada, no contra la más nueva.

## Líneas de vista previa

Una línea de especificación **MAY** designarse como **vista previa**. Mientras esté en vista previa, puede revisarse sobre la marcha: **MAY** cambiar de formas que en otro caso serían incompatibles, en vez de subir a una versión nueva, hasta que se congela en la disponibilidad general (GA). La regla de que «los cambios incompatibles exigen una versión mayor» (punto 1) y la regla de que «el `$id` se mueve ante un cambio incompatible de forma» (punto 3) se aplican desde el congelado en GA en adelante, no mientras una línea está en vista previa. En GA la línea se congela y ambas reglas entran en vigor.

Una línea que se publica antes de la disponibilidad general **MUST** declararlo en su primera publicación.

La línea 1.0 está **congelada en la versión v1.3.0 del utillaje de referencia**. Dentro de la línea, los cambios de esquema son solo aditivos y el `$id` se queda en `v1.0`; cualquier cambio incompatible se publica como línea nueva, nunca sobre la marcha.

## Los esquemas

3. Cada esquema lleva un `$id` estable con la forma `https://leji.org/schemas/v<major>.<minor>/<name>.schema.json`. La línea del `$id` se mueve solo cuando la forma del esquema cambia de manera incompatible.
4. Dentro de una línea publicada, los cambios de esquema **MUST** ser aditivos (nuevos campos opcionales). Las eliminaciones de campos o los cambios semánticos exigen una línea nueva.
5. Los artefactos legibles por máquinas distintos del manifiesto declaran la línea de esquema contra la que se escribieron mediante `schemaVersion`; el manifiesto declara la línea de especificación a la que apunta mediante la clave autonombrada `leji` (punto 2).

## Conjunto de estabilidad

Lo siguiente queda congelado dentro de una línea de especificación; el utillaje (incluidas futuras implementaciones comerciales) se construye contra ello sin esquemas paralelos:

- la forma del manifiesto y su nombre de archivo fijo `leji.json`,
- los identificadores de categoría (`domain`, `system`, `practice`, `governance`, `decisions`),
- los identificadores de nivel de conformidad (`core`, `indexed`, `governed`, `federated`),
- las reglas de normalización de identificadores y rutas según [machine-readable-surface.md](/es/spec/machine-readable-surface/),
- las formas de la entrada de índice, la entrada de registro de cambios, el perfil de agente y el registro de decisión.

## Utillaje que la implementa (no normativo)

Los SDK y las CLI se versionan con su propio SemVer y declaran qué líneas de especificación admiten. Los SDK de referencia de este repositorio son el paquete npm `@leji-org/leji` (packages/sdk), el paquete PyPI `leji` (packages/sdk-py) y el módulo Go `leji` (packages/sdk-go, un único binario estático); son idénticos en comportamiento y se prueban contra un mismo conjunto compartido de fixtures.
