# Proveedores y modelos en el desktop

El desktop usa los cuatro proveedores ya registrados en el Harness: OpenAI, Qwen,
Meta y Gemini. No se incorporan proveedores nuevos. Gemini conserva su estado
provisional en el registro del motor.

## Uso

1. Abrí un repositorio. Se puede consultar el historial sin una API key.
2. Pulsá el nombre del modelo al pie del editor para abrir **Elegí el modelo**.
   Buscá por nombre o proveedor, seleccioná una tarjeta y pulsá **Usar modelo**.
   Para un ID específico, abrí **Configurar otro modelo**, elegí el proveedor y
   **Otro modelo…**. **Volver** o Escape descartan los cambios sin confirmar.
   La selección no certifica disponibilidad remota.
3. En **Credenciales**, seleccioná el proveedor y guardá la clave en el diálogo
   seguro de macOS. El proyecto abierto se reconecta al terminar. Las claves se
   guardan en cuentas distintas del llavero, sin llegar al renderer, argumentos,
   variables de entorno del proceso hijo ni archivos de configuración.
4. Enviá el mensaje. Sin clave, el envío permanece deshabilitado, pero el historial
   y la configuración siguen disponibles.

La elección se conserva por proyecto, incluso al reiniciar. Una tarea nueva en un
worktree hereda inicialmente la selección del proyecto origen y después conserva
la suya. El cambio afecta los siguientes mensajes de ese proyecto; no modifica los
proveedores/modelos registrados en ejecuciones anteriores. No se permite cambiar
mientras haya una ejecución, una aprobación o una recuperación pendiente en
cualquiera de las conversaciones del proyecto. Finalizá o cancelá ese trabajo
primero. Cambiar una clave tampoco cancela una ejecución activa.

## Alcance de conexión

Se utilizan los endpoints predeterminados de los adaptadores. Qwen usa Model
Studio internacional (Singapur), con credenciales estándar. Los endpoints
personalizados, otros despliegues regionales y planes especiales no se configuran
en esta interfaz. No se heredan overrides del shell para cambiar silenciosamente
el destino de la clave. La prueba de conexión consulta modelos, sin generación;
no certifica permisos de un modelo concreto ni su capacidad para usar herramientas.

## Verificación local

- `bun test desktop/tests/model-selection.test.ts desktop/tests/credential-store.test.ts`
- `bun run --cwd desktop typecheck`
- `bun run --cwd desktop build`
- `bun run desktop/scripts/smoke.ts --models`
- `bun run desktop/scripts/smoke.ts --models --packaged` después de empaquetar.

El smoke usa modelos offline: comprueba IPC, selección real del runtime,
persistencia en las sesiones, recarga, aprobaciones y geometría del chat. No es una
certificación live de las cuentas de los proveedores. El helper nativo incluye un
self-test de aislamiento entre cuentas en un llavero temporal.

## Prueba live de Qwen

`bun --env-file=.env run desktop/scripts/live-qwen-smoke.ts --live`

Usa la aplicación ya empaquetada, tres turnos y un repositorio temporal. Verifica
lectura con herramientas, respuesta en el renderer, continuación del chat y una
edición que espera aprobación. Reinicia el runtime antes de aprobar y comprueba
los bytes finales. La clave de `.env` llega por el canal privado del helper; el
test no escribe ni reemplaza credenciales del llavero personal. El proceso main
es un driver de prueba que conecta el renderer y el runtime empaquetados. No
certifica el flujo completo de configuración del main de producción ni otros
modelos o endpoints. El límite global es de seis minutos, sin reintentos de la
prueba completa. El reporte solo expone resultados y la fase fallida, si la hay.
