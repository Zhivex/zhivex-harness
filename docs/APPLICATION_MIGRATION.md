# Migración local de la aplicación

La reorganización del código no mueve datos del usuario. Electron conserva `~/.zhx-app`, los directorios de estado de Code y su perfil Electron. Se conservan rutas, IDs, scopes, bindings, decisiones pendientes y referencias a credenciales. No se fusionan perfiles ni se convierten formatos Tauri desconocidos. Las credenciales permanecen en su almacén original.

## Workspaces

- `packages/core/src`: autoridad y casos de uso compartidos.
- `packages/cli`: producto de terminal y wrapper `zhivex-code`.
- `packages/desktop`: interfaz Electron basada en la propuesta web.

El manifiesto raíz sigue publicando `@zhivex-ai/harness` y sus exports/binarios existentes. `packages/core/package.json` es privado y debe mantener la misma versión y engines; `bun run workspace:check` comprueba esa invariancia. El build compila la fuente canónica, y el lockfile raíz cubre los tres workspaces. Los paquetes Assistant/web y los aliases temporales fueron retirados. El dominio Assistant y sus pruebas viven en el core y `tests/assistant`.

## Backup y rollback sin llavero

Herramienta de mantenimiento desde el checkout: `bun run migration:application`. No se ejecuta automáticamente al abrir Electron ni opera sobre perfiles reales sin rutas explícitas. Es un snapshot completo de los directorios seleccionados y una recuperación byte por byte, no un conversor de esquemas desconocidos.

1. Detener Electron, el coordinador, CLI y cualquier cliente antiguo que use esos datos. Inventariar **todos** los directorios de estado: aplicación personal, estados externos de Code y metadatos de Electron que se quieran recuperar. No seleccionar repositorios, worktrees ni el HOME entero.
2. Usar rutas absolutas canónicas, privadas, del mismo usuario, sin solapamiento ni symlinks. El destino de backup debe quedar fuera de todos los orígenes. Archivos deben ser privados, regulares y sin hardlinks. El límite es 32 raíces, 10 000 archivos/directorios, 128 MiB por archivo y 512 MiB total. Se rechaza WAL/journal no vacío: cerrar/checkpointar limpiamente el escritor primero, nunca borrar WAL a mano.
3. Ejecutar `bun run migration:application backup /ruta/backup /ruta/estado-personal /ruta/estado-code`. Se adquieren exclusiones para el coordinador y cada SQLite antes de copiar; también se rechaza un PID vivo del dueño legacy. Las referencias a credenciales se copian como datos opacos; no se consulta, exporta ni modifica el llavero.
4. Conservar `manifest.json`, `journal.json` y `objects/` juntos. El manifiesto vincula rutas, tamaños y SHA-256. Después de un corte, repetir el comando con los mismos argumentos. Se verifican objetos ya escritos y el origen completo; un origen cambiado no se acepta como si fuera el snapshot anterior.
5. Para rollback, ejecutar `inspect-rollback` con los mismos argumentos, revisar el estado actual y usar su `currentSha256` en `rollback ... --expected-current=HASH`. Se verifica **todo** el backup antes de escribir. El rollback conserva contenido posterior en `before-rollback/` con su índice `before-rollback-manifest.json`; no lo elimina silenciosamente. Los nuevos directorios vacíos pueden permanecer.
6. Un rollback interrumpido se reanuda con el mismo backup y hash aprobado. El diario recuerda archivos completados. Una recuperación terminada no permite volver a sobrescribir trabajo nuevo usando el consentimiento anterior.

`.zhivex-migration.json` bloquea la admisión mientras existe una operación incompleta. El coordinador mantiene una exclusión compartida durante toda su vida; los lectores del core rechazan raíces con una intención de recuperación pendiente. Los sockets y locks operativos no forman parte del estado restaurado. No borrar marcadores ni archivos de acceso manualmente.

Si una copia incompleta ya no coincide con el origen, `inspect` devuelve el hash actual sin habilitar escritores. Se puede cancelar esa intención con `abort ... --expected-current=HASH`: conserva todos los datos y objetos de backup y libera la admisión. Un rollback en curso no admite abortar; debe terminar la recuperación. Para una nueva copia después de abortar se usa otro destino.

La exclusión cooperativa sólo se implementa en macOS; otros sistemas se rechazan. Los clientes antiguos/arbitrarios que ignoren este protocolo deben permanecer detenidos durante toda la operación. No se afirma protección contra un proceso del mismo usuario que modifique archivos por fuera del protocolo. La herramienta no acredita por sí sola que el operador haya inventariado todas las raíces externas.

## Versiones y distribución

Las fixtures publicadas inventariadas del core son 0.10.0 y 0.11.1; `bun run migration:check` verifica su migración al core actual. No hay una fixture certificada de datos Tauri ni una identidad Developer ID final disponible en esta ejecución: la retirada de las interfaces del repositorio no certifica migración de datos personales ni distribución firmada. Se conservan los migradores, la evidencia histórica y el respaldo del bundle anterior.

Las pruebas offline de Electron usan un modelo HTTP local y SecretStore en memoria. El DMG es **sin firma Developer ID, sin notarización y no publicado**. La prueba de reemplazo/rollback usa un verificador de fixture explícito; el verificador de producción rechaza ese mismo bundle. El feed sigue deshabilitado. La fase 7 no puede darse por cerrada para distribución hasta certificar firma, notarización, actualización real y acceso a las cuentas del llavero con la identidad final.
