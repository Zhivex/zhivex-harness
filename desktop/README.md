# Zhivex Harness Desktop

Aplicación local para trabajar sobre repositorios Git con conversaciones persistentes,
selección de modelos, revisión de cambios y aprobaciones explícitas. Usa Electron y
React, con el motor Harness en un proceso separado.

El desktop es **alpha para macOS Apple Silicon**. El paquete local todavía no está
firmado ni notarizado. La actualización está implementada, pero deshabilitada hasta
configurar la confianza de producción y validar una actualización firmada. El estado
estable del paquete CLI no implica que el desktop tenga distribución estable.

## Desarrollo

Desde la raíz del repositorio, usando Bun:

```sh
bun install --frozen-lockfile
bun install --cwd desktop --frozen-lockfile
bun run --cwd desktop typecheck
bun run --cwd desktop build
bun run --cwd desktop start
# Abrir un repositorio al iniciar, opcional:
bun run --cwd desktop start --workspace /absolute/repository
```

El producto utiliza el Node incluido en Electron. El usuario no necesita instalar
Node ni Bun para abrir la aplicación empaquetada. Git es un requisito externo;
Docker/OCI y GitHub CLI se necesitan solo para las funciones que los utilizan.

## Uso

1. **Abrir repositorio** selecciona un repositorio Git mediante el diálogo nativo.
   Los proyectos recientes y sus conversaciones se guardan por separado.
2. **Nueva conversación** crea una sesión. Seleccionar una conversación o pulsar
   una sugerencia no ejecuta herramientas: las sugerencias solo completan el editor.
3. Pulsá el modelo al pie del editor para buscar y seleccionar uno. Configurá la
   clave de su proveedor en **Credenciales**, mediante el diálogo seguro de macOS.
   Sin clave podés consultar el historial, pero no enviar mensajes.
4. Enter envía; Shift + Enter agrega una línea. La respuesta muestra texto,
   herramientas y resultados. Podés cancelar una ejecución activa.
5. Si una operación requiere aprobación, revisá su alcance, los archivos y comandos
   antes de aceptarla. Cancelar no revierte efectos ya aplicados.

La barra lateral permite buscar conversaciones y puede ocultarse. El editor permanece
visible mientras se desplaza la conversación. Los paneles superiores agrupan:

- **Entrega Git:** preparación de archivos, revisión y autorización de commit local,
  push y creación de PR. Las operaciones usan revisiones y resultados persistentes;
  ante una respuesta perdida, consultá el resultado antes de reintentar. La autenticación
  Git/GitHub se configura por separado de las claves de modelos.
- **Tareas aisladas:** worktrees desde el commit actual, sin copiar cambios sin commit.
  La limpieza requiere una revisión y conserva la rama y las conversaciones.
- **Historial de decisiones:** resultados de aprobaciones y efectos registrados por
  ejecución. Una comprobación aislada no certifica automáticamente los bytes de un cambio.

Las conversaciones y aprobaciones sobreviven a reinicios. Reabrir un proyecto solo
recupera un transporte anterior cuando su dueño ya no está vivo. No borres archivos
de bloqueo para forzar la apertura. El cierre normal espera las operaciones aceptadas;
una terminación forzada puede requerir recuperación al reiniciar.

## Guías

- [Proveedores, modelos y credenciales](MODELS.md)
- [Instalación, dependencias y desinstalación](INSTALLATION.md)
- [Confianza, instalación y recuperación de actualizaciones](UPDATES.md)
- [Arquitectura y límites de seguridad](../docs/DESKTOP_ARCHITECTURE.md)
- [Contrato compartido de clientes](../docs/CLIENT_PROTOCOL.md)

Las claves se guardan en cuentas separadas del llavero. No se entregan al renderer
ni se heredan del shell para redirigir silenciosamente el proveedor. Las pruebas con
fixtures no leen ni modifican el llavero personal.

## Empaquetado y verificación

```sh
bun test desktop/tests
bun run --cwd desktop package
bun run --cwd desktop smoke:packaged --empty-start
bun run desktop/scripts/smoke.ts --models --packaged
bun run --cwd desktop smoke:restart:packaged
bun run --cwd desktop smoke:worktrees:packaged
bun run desktop/scripts/smoke-layout.ts --packaged
bun run desktop/scripts/smoke-layout.ts --packaged --credentials
bun run desktop/scripts/smoke-layout.ts --packaged --updates
```

El paquete queda en `desktop/out/Zhivex Harness-darwin-arm64/Zhivex Harness.app`.
Estas pruebas usan repositorios temporales y modelos offline. Cubren aislamiento,
streaming, cancelación, revisiones, persistencia, recuperación, modelos, teclado y
geometría del chat. Emiten reportes y capturas en directorios temporales.

Pruebas adicionales:

```sh
# Revisión OCI en el renderer, con runtime simulado; no certifica Docker real:
bun run --cwd desktop smoke:packaged --oci-review
# Integración del helper y runtime con llaveros temporales:
bun run desktop/scripts/smoke-native-credentials.ts
# Preparación y comprobación del instalador local sin firma:
bun run desktop/scripts/prepare-installer.ts
bun run desktop/scripts/smoke-installer.ts
```

La [guía de modelos](MODELS.md#prueba-live-de-qwen) describe la prueba live opcional,
sus credenciales y límites. La validación de Docker real, la autenticación GitHub
live y la distribución firmada son verificaciones separadas.
