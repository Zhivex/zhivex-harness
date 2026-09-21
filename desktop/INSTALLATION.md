# Instalar Zhivex Harness para macOS

Este candidato local no está firmado ni notarizado. No es una distribución beta
verificada por Apple. La firma y notarización se configurarán antes de publicar.
No desactives Gatekeeper ni elimines la cuarentena para ocultar ese estado.

El paquete contiene Electron, el runtime Node del producto, el helper de llavero
y el helper nativo de bloqueo para actualizaciones. La actualización desde la
interfaz está implementada, pero deshabilitada en la configuración distribuida
por este checkout. Requiere un feed firmado y una identidad de editor configurados;
este candidato local se reemplaza manualmente. Véase [UPDATES.md](UPDATES.md).
No requiere instalar Node o Bun para abrir la aplicación. Arquitectura: Apple
Silicon (arm64); objetivo mínimo de compilación: macOS 13. La evidencia adjunta
identifica la versión de macOS donde se ejecutaron las pruebas; no equivale a
haber probado todas las versiones desde ese mínimo. Intel no está soportado.

1. Compará el SHA-256 del DMG con release-manifest.json mediante `shasum -a 256`.
   El hash detecta cambios de bytes; un manifiesto sin firma no acredita al editor.
2. Abrí el DMG y arrastrá Zhivex Harness.app a Aplicaciones. Si ya existe una
   instalación, conservá la versión anterior hasta verificar la nueva. Cerrá las
   tareas y la aplicación antes de reemplazarla.
3. Abrí la aplicación. Para este candidato sin firma, el bloqueo de Gatekeeper
   es una limitación pendiente de distribución, no un error que deba desactivarse.
4. Abrí un repositorio, elegí el modelo y configurá la clave de su proveedor en
   Credenciales. La clave se introduce en una ventana nativa y se guarda en el
   llavero de macOS.

La selección de repositorios usa el diálogo nativo y permisos normales de archivos;
no se solicita acceso completo al disco. El llavero puede solicitar autorización o
desbloqueo. Las conexiones al proveedor y a GitHub requieren red. Git y gh son
requisitos externos para entrega Git; configurar credenciales de proveedor no
configura autenticación GitHub.

## OCI y dependencias externas

La aplicación incluye su runtime, pero no Docker, Podman ni imágenes OCI. Si no
hay un motor OCI disponible, las operaciones que exigen aislamiento OCI no pueden
iniciarse. Instalá y arrancá un motor compatible siguiendo la
[matriz de soporte](../docs/SUPPORT_MATRIX.md) y la
[guía de ejecución](../docs/EXECUTION_ENVIRONMENTS.md); ejecutá el diagnóstico del Harness
antes de usar ese modo. No se sustituye silenciosamente OCI por ejecución directa.

## Desinstalar conservando datos

Cerrá las tareas y la aplicación, y mové únicamente Zhivex Harness.app a la Papelera.
Conservá ~/Library/Application Support/zhivex-harness-desktop (o la ruta userData de
la instalación), los repositorios originales, los worktrees de tareas y el estado
.zhivex-harness de los proyectos. No borres carpetas de estado o llaveros como parte
de la desinstalación. Las claves permanecen en el llavero; si querés eliminarlas,
usá Eliminar clave del llavero antes de quitar la app. Guardá un backup verificable
del estado antes de migraciones o cambios de versión.
