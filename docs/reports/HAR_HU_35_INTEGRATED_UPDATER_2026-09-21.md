# HAR-HU-35 — instalación conectada a main y recuperación al arrancar

Implementación local: `332ddf5` (descarga) y `70b04a1` (instalación/recuperación), rama `feat/harness-desktop`. Sin push ni publicación. Firma/notarización diferidas por el usuario.

La interfaz solicita descargar e instalar sin enviar rutas, claves ni parámetros de confianza. Main controla admisión y operaciones IPC, rechaza trabajo activo sin cancelarlo, verifica/monta el DMG en solo lectura, prepara el bundle, desmonta la imagen, cierra servicios, crea backup bajo leases exclusivos y registra el job antes de armar recuperación. Solo sale tras el acuse del worker. Al arrancar, un recibo activo permite localizar un único job antes de abrir registros. El worker reabre la aplicación verificada después de completar instalación o recuperación y soltar los leases.

## Evidencia

- Suite completa: 816 pass, 0 fail, 4611 assertions (`/tmp/har-update-install-suite.log`). Después se agregaron dos casos de arranque/reapertura: los 18 tests de instalación/job/sesión pasaron con 92 assertions. No se presenta este último conteo como una segunda ejecución completa.
- Tipos core y desktop, build y package aprobados.
- UI Electron: descarga, recarga durante descarga, reintento de instalación y mensaje de trabajo activo; `/tmp/har-layout-Dj25Bj/report.json`.
- Flujo general Electron con seguimiento de todas las operaciones IPC: `/tmp/har-electron-jsKUNG/report`.
- DMG real montado en solo lectura y rechazado por el verificador nativo; desmontaje comprobado. Reproducible con `bun run desktop/scripts/smoke-update-image.ts` sobre el candidato unsigned alpha.1.
- Entrada de producción del worker: `/tmp/har-production-worker-report-1QC8w9`; acuse, rechazo de bundle sin firma, app/datos conservados y recuperación armada.
- DMG actualizado SHA-256 `0fd6156ca88bb6422287dbc3cbedb00ed98fcdb785e1ece9285d3e4e95625404`, 142183437 bytes. Manifiesto y comprobación instalados en los JSON HAR_HU_34_35_INTEGRATED_UPDATER de esta fecha.
- Instalación temporal con imagen desmontada: perfil limpio, SQLite, runtime separado, streaming/aprobaciones/recuperación, llavero temporal, handoff y worker instalado pasan. La firma del origen del worker se simula por tratarse de un artefacto unsigned; su verificador de destino sigue siendo nativo y rechaza el bundle de prueba.

## Límites y cierre

La configuración de producción sigue deshabilitada y no se inventaron feed, clave pública ni Team ID. No hay demostración de actualización positiva firmada ni ensayo completo de recuperación desde main contra ese artefacto firmado. El formato actual sigue siendo 1. La exclusión SQLite es cooperativa; no certifica clientes antiguos o bibliotecas directas que ignoran el protocolo. Estas limitaciones impiden declarar cerrada HU35 con esta evidencia. HU34 conserva pendiente la firma/notarización acordada. Los cambios de formato del usuario en ReviewPanel y su carpeta output no se incorporaron a los commits.
