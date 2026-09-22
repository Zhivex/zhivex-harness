# Auditoría de aceptación HAR-HU-13–35

Revisión del checkout `0191246`, implementación de actualizador `70b04a1`, rama `feat/harness-desktop`. Notion consultado nuevamente para las 23 HU; sus 69 criterios están enumerados en el JSON de esta auditoría con la evidencia correspondiente. No hubo push, publicación ni llamadas nuevas a proveedores.

## Resultado

| Alcance | Resultado comprobado | Pendiente |
| --- | --- | --- |
| HU13–20 | Implementadas y marcadas Hecha / Pendiente de publicación en Notion. Paquete CLI instalado, primer uso y PTY revalidados. Dataset y 22 intentos conservados coinciden con el informe. | El piloto produjo HOLD: 6/10 correctas en ambos artefactos; esto no habilita release ni uso diario certificado. |
| HU21–25 | Contrato, servicio, replay y CLI implementados. Notion mantiene los 15 criterios cerrados. El smoke del paquete instalado incluye cliente de referencia y servicio. | Sin publicación. |
| HU26–30 | Desktop alpha implementado; runtime separado, conversación, aprobación y recuperación cubiertos por informes y smoke instalado del incremento actual. Cuatro geometrías del paquete actual pasan. | Sin certificación general de providers/OCI ni beta firmada. |
| HU31–33 | Worktrees, entrega Git/PR y llavero implementados. El paquete actual vuelve a pasar dos tareas concurrentes, reinicio, commit/push/PR únicos, recuperación de respuestas perdidas y limpieza revisada. | GitHub simulado y remotos Git locales; no se certifica autenticación live. |
| HU34 | DMG local preparado, instalado y verificado; versiones, hashes y documentación conservados. | Developer ID, notarización y aceptación de distribución firmada, diferidos expresamente por el usuario. |
| HU35 | Consulta/descarga/instalación/reinicio/recuperación conectados. Backup, fallos y controles de acceso tienen evidencia local. | Configuración real de confianza y demostración positiva de actualización/recuperación firmada. El build sigue deshabilitando actualizaciones sin esa configuración. |

Las HU34–35 permanecen En curso / Por verificar en Notion. No se sustituyen sus criterios por pruebas de componentes, claves efímeras ni verificación de firma simulada. La preparación local solicitada avanzó, pero el objetivo completo no está demostrado.

## Comprobaciones de este cierre

- `bun run docs:check`: 111 archivos; aprobado.
- `bun run contract:check` y `bun run typecheck:tooling`: aprobados.
- `bun run migration:check`: fixtures publicados 0.10.0/0.11.1 aprobados.
- `bun run build` y `bun --no-env-file run smoke:artifact`: aprobados. El script incluye PTY, primer uso, contrato de cliente y servicio contra el paquete instalado. Usa proveedores offline.
- `bun run --cwd desktop smoke:worktrees:packaged`: aprobado; evidencia `/tmp/har-tasks-USYWyg/report` y resultado preservado en el JSON de auditoría. Los pushes de esta prueba van a un bare repo temporal; la rama de implementación no se pusheó.
- `bun run desktop/scripts/smoke-layout.ts --packaged`: sidebar/contenido correctos a 720 y 1120 píxeles, con panel abierto y cerrado. Reporte `/tmp/har-layout-XSfX5b/report.json`.
- Los manifiestos de instalación del incremento anterior identifican el DMG SHA-256 `0fd6156ca88bb6422287dbc3cbedb00ed98fcdb785e1ece9285d3e4e95625404` y la instalación temporal con imagen desmontada.

## Límite de cierre

La firma/notarización fueron diferidas por el usuario. No corresponde crear identidades, inventar valores de confianza, publicar un feed ni omitir verificaciones nativas para declarar cerradas esas HU. El bloqueo de cierre firmado se mantuvo durante los últimos incrementos y la auditoría. No se modifica esa decisión ni se vuelve a pedir autorización para lo ya resuelto.

La exclusión SQLite protege clientes actuales que participan en el protocolo; no certifica clientes antiguos ni bibliotecas directas ajenas a él. Es una limitación conservada explícitamente, no evidencia de exclusión universal. El formato actual es 1 y los formatos incompatibles se rechazan; no se promete una migración para un esquema futuro no implementado.

Se preservan sin incorporar los cambios de formato del usuario en `desktop/src/ReviewPanel.tsx` y su carpeta `output/`.
