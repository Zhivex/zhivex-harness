# Assistant: proveedores configurables y módulos componibles

Una instancia por propietario. Esta extensión vive en Assistant sobre APIs públicas
de Harness; no agrega multiusuario, carga de código desde el chat ni instalación
automática de plugins. Las configuraciones son decisiones del operador local.

## Proveedores compatibles con OpenAI

Ejemplo editable: [compatible-calendar.json](../packages/assistant/examples/compatible-calendar.json).
Reemplazar endpoint/modelo y declarar solo capacidades verificadas del modelo.
Guardar el secreto en la variable indicada por `apiKeyEnv`, nunca en el JSON.
Después de preparar el candidato local de Harness y construir Assistant:

```sh
bun run --cwd packages/assistant start --directory "$HOME/.zhx-compatible" --owner local-owner --config /ruta/assistant.json --telegram-owner 123456789 --doctor
bun run --cwd packages/assistant start --directory "$HOME/.zhx-compatible" --owner local-owner --config /ruta/assistant.json --telegram-owner 123456789
```

Conectar OAuth antes de iniciar, según la [guía del piloto](ASSISTANT_PILOT.md),
usando `--calendar-connect` sin `--config`. La configuración Calendar continúa
leyendo sus credenciales de las variables existentes. Se puede omitir Calendar
y usar otros módulos o un perfil general sin herramientas.

El proveedor configurable requiere:

- `kind: openai-compatible`, `baseURL`, `model` y `apiKeyEnv` explícitos.
- `apiMode: chat` para `/chat/completions`, o `responses` para `/responses`.
  No hay autodetección ni fallback silencioso entre protocolos. El modo elegido
  prevalece sobre opciones por llamada.
- `capabilities.streaming` y `capabilities.tools` verdaderos. `toolChoice`,
  `parallelToolCalls`, `structuredOutput`, `jsonMode` y `reasoning` son opcionales,
  falsos por defecto. Esta declaración habilita modelos desconocidos en el SDK;
  no certifica que el servidor realmente cumpla el contrato.
- HTTPS sin credenciales embebidas, query ni fragmento. Para un servidor local
  HTTP en `localhost`, `127.0.0.1` o `[::1]`, usar `allowInsecureLocalhost: true`.
  Las redirecciones se rechazan. No habilita HTTP remoto ni búsqueda de endpoints.

`--doctor` valida configuración y presencia de la variable de credencial sin
llamar al proveedor. No comprueba capacidades reales. El transporte usa
`@zhivex-ai/openai` y mantiene los resultados de herramientas en formato envelope.
Las herramientas hospedadas de OpenAI no se conceden por declarar compatibilidad.

Endpoint, protocolo, modelo, referencia de credencial y capacidades forman un
digest ligado al perfil durable. Cambiarlos requiere un directorio nuevo; cambiar
el valor del secreto manteniendo la referencia permite rotarlo. El secreto no se
incluye en ese digest, las instrucciones ni el diagnóstico. Una sesión con el
proveedor anterior no se migra automáticamente al proveedor configurable.

La API embebida acepta `compatibleProvider` en `startAssistantHost`. Es mutuamente
excluyente con `engine.provider`, `engine.model` y `engine.modelInstance` para
impedir configuración ambigua. La ruta previa `--provider`/`--model` sigue disponible
si el archivo no define proveedor.

## Componer Calendar y otras herramientas

[composed-modules.json](../packages/assistant/examples/composed-modules.json) muestra
Calendar y un módulo MCP HTTP. Reemplazar endpoint, herramientas y referencia de
credencial por valores de una integración propia. Ejecutar con `--config` y, si
el JSON no define proveedor, los flags `--provider`/`--model` habituales.
No combinar `--config` con `--calendar` o acciones de OAuth en el mismo comando.

Cada módulo declara identidad/versión, instrucciones, lista exacta de herramientas,
permisos y configuración. Los nombres de servidores deben comenzar con `id_`;
las herramientas expuestas son `servidor_herramienta`. No se admiten catálogos
abiertos, colisiones, prefijos alternativos ni recursos MCP en este primer contrato.
El archivo admite solo los tipos `calendar` y `mcp`; un módulo MCP declarativo usa
HTTP y referencias `ZHIVEX_MCP_*` para cabeceras. Nunca carga rutas JavaScript,
comandos shell o paquetes indicados por un mensaje.

Harness continúa evaluando permisos, aprobaciones, límites y cancelación. Declarar
`read`/`network` no evita la política de revisión. Solo adaptadores locales de
lectura confiables pueden usar el tratamiento existente de anotaciones de lectura.

## Contrato para desarrolladores

Exports públicos de Assistant:

- `AssistantModule`: `id`, `version`, `open(context)`.
- `AssistantModuleContext`: directorio privado de la instancia, propietario y
  bandera de recuperación explícita. El módulo debe mantener su estado separado
  y vincularlo al propietario; compartir proceso no constituye un sandbox.
- `AssistantModuleInstance`: binding estable sin secretos, perfil, configuración
  MCP, clientes opcionales, cierre; opcionalmente herramientas que requieren
  detalles de revisión, su resolver y una fuente de agenda de solo lectura.
- `createCalendarModule(options)`: implementación Calendar con OAuth/registro de
  operaciones existente, propuesta exacta, revisión Telegram y agenda diaria.
- `createMcpModule(options)`: fábrica para HTTP o clientes locales inyectados. Los
  clientes locales deben ser provistos por código de confianza, junto con un
  `binding` de su cuenta/configuración y `close` si poseen recursos.

Ejemplo embebido:

```ts
const host = await startAssistantHost({
  directory, ownerId,
  compatibleProvider,
  modules: [createCalendarModule(calendarOptions), createMcpModule(notesOptions)]
});
```

El host ordena módulos por ID, valida namespaces y combina perfiles y clientes.
Si falla la apertura, cierra lo que ya abrió; al apagar, intenta cerrar todos los
módulos aunque uno falle. Los módulos reciben capacidades mediante sus adaptadores;
no se permite mezclar módulos con `engine.agentProfile`, `engine.mcpConfiguration`
o `engine.mcpClients`. Para personalizar herramientas se usa otro módulo.

Los resolvers de revisión agregan detalles al texto ligado a la revisión Telegram.
Si se declara `reviewTools` sin resolver, el arranque falla. En un bridge embebido
manual, pasar `host.approvalDetails`, `host.reviewTools` y `host.agendaSource` para
conservar la revisión y automatización. El host automático los conecta por sí mismo.
Solo puede existir una fuente de agenda para el resumen diario; dos fallan en
arranque para evitar elegir una cuenta implícitamente.

## Compatibilidad y recuperación

`calendar: options` y `--calendar` son atajos del módulo Calendar. Calendar solo,
sin proveedor configurable, conserva el perfil v1, nombres de herramientas,
almacenamiento, binding y revisión anteriores. Sus tests de aprobaciones y
recuperación siguen aplicando; no se requiere reconectar esa cuenta.

Agregar/quitar módulos, cambiar versiones/bindings o activar un proveedor
configurable produce un perfil diferente. El host rechaza el estado anterior;
usar un directorio nuevo, sin borrar `host.json` ni reciclar aprobaciones. El orden
de módulos no cambia el perfil. El mecanismo `preserveProfile` se reserva a
adaptadores de compatibilidad confiables que ya incluyen su identidad en el perfil;
Calendar v1 lo usa para conservar sesiones existentes.

La instancia sigue fijada a un propietario, un bot y una conversación privada.
Para otra persona usar directorio, credenciales y bot separados. No hay aislamiento
entre módulos maliciosos ejecutados en el mismo proceso: las extensiones embebidas
son código de confianza del operador.

## Validación y límites

Pruebas offline cubren Chat y Responses con modelo desconocido, streaming, modo
forzado, declaración de capacidades, secretos fuera del binding, endpoints
inválidos, composición determinista, colisiones, cierre al fallar, configuración
sin imports ejecutables y cambio de perfil rechazado. Servidores HTTP locales
simulan ambos protocolos durante herramienta → aprobación → reinicio → resolución,
comprobando un único efecto. Calendar se prueba junto a un segundo módulo con
aprobación Telegram y revalidación de eventos.

Esto no certifica proveedores comerciales, modelos locales específicos o un
servidor MCP real. Antes del piloto de cada endpoint ejecutar una prueba controlada
de streaming, herramientas, aprobación/reinicio, cancelación y errores. No basta
con que el endpoint responda a una petición de texto.

Aceptación local 2026-11-10: consumidor instalado con 51 pruebas, 282 aserciones,
0 fallos; tipos, build y ejemplo offline Node aprobados. Arquitectura, contratos,
documentación y `git diff --check` aprobados. Candidato Harness 1.6.3 no publicado,
SHA-256 `b199a154e3bfc95654df10cdc48f887f974098567f5c8bcb07646db106e04a1f`.
No se ejecutaron llamadas a proveedores reales, publicación ni merge.
