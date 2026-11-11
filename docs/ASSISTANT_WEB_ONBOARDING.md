# Assistant: configuración desde la web

El lanzador local de macOS permite abrir Assistant con doble clic y configurar
modelo, Calendar y Telegram desde el navegador. No se necesitan comandos durante
la primera sesión ni para volver a abrirlo. El servicio escucha solo en loopback.

## Para usar esta copia local

Abrir `release-artifacts/Zhivex Assistant.app`. El lanzador abre el navegador con
acceso privado y reutiliza una instancia ya encendida. La primera vez:

1. Pulsar **Configurar mi asistente**.
2. Elegir OpenAI, Muse / Meta, Qwen o un proveedor compatible, ingresar modelo y clave y pulsar
   **Probar y guardar conexión**. La prueba realiza una generación corta real,
   que puede consumir cuota. No certifica streaming ni herramientas del proveedor.
   Para información actual, marcar **Búsqueda web de OpenAI**: selecciona
   Responses automáticamente y envía la herramienta en la prueba de compatibilidad.
   Las búsquedas tienen un costo adicional de OpenAI; la prueba corta no obliga
   al modelo a buscar. Requiere un modelo compatible y el endpoint oficial.
   Muse / Meta y Qwen usan los adaptadores nativos del harness. Para una cuenta de QwenCloud, elegir **Servicio de Qwen → QwenCloud**
   (o **QwenCloud Token Plan** si la clave pertenece a ese plan); no requiere
   región ni workspace. Los perfiles guardados sin servicio conservan Model Studio.
   En **Alibaba Cloud Model Studio**, Qwen permite
   elegir región y workspace; fuera de Singapur se requiere el ID del workspace
   regional. Sin workspace se usa el endpoint internacional predeterminado.
   La búsqueda web de Assistant sigue disponible solo para OpenAI.
3. Opcionalmente conectar Google Calendar. Si la distribución tiene configurado
   su cliente OAuth, basta con consentir. Esta copia local permite importar el
   JSON de un cliente OAuth **Desktop**, o ingresar sus datos desde la web.
   La creación y habilitación de esa aplicación en Google sigue siendo una tarea
   del distribuidor/operador: no se simula un cliente oficial de Zhivex.
4. Opcionalmente crear un bot en BotFather e ingresar su token. Abrir el enlace
   de Telegram, pulsar Iniciar, volver y pulsar **Ya envié el mensaje**. Confirmar
   la cuenta detectada desde la web. No hace falta averiguar el ID numérico.
5. Pulsar **Empezar a conversar**. Telegram queda vinculado con la cuenta
   confirmada desde la web. No se envían mensajes de prueba automáticamente.
6. Con Calendar y Telegram vinculado, configurar el resumen diario en
   **Automatizaciones**. La entrega requiere que Assistant siga encendido.

La configuración se guarda en el llavero del sistema (Keychain en macOS,
Secret Service en Linux), sin fallback a secretos en texto plano. Las claves
no se devuelven en las respuestas de configuración. La clave de cifrado de
Calendar se genera y conserva automáticamente en ese llavero.

**Configuración → Apagar Assistant** cierra el servicio. Volver a abrir la app
restaura la configuración guardada y abre un enlace de acceso nuevo. Cerrar la
pestaña no apaga el servicio. Un fallo del llavero se puede reintentar desde la
web. Un cierre abrupto permite recuperar solo procesos comprobados como muertos.

## Configuraciones e historial

El modo administrado usa `~/.zhx-app`, separado de los directorios de las
instancias CLI existentes. No importa ni modifica esas instancias automáticamente.

Cambiar proveedor o capacidades crea una configuración con conversaciones
separadas; las anteriores permanecen guardadas y pueden seleccionarse desde la
web. No se migran ni reutilizan aprobaciones con otro perfil. Antes de cambiar,
resolver/cancelar las tareas pendientes y pausar el resumen diario. Las
conexiones de Calendar deben autorizarse en la nueva configuración.

Si ya guardaste una clave de OpenAI, **Configuración → Configurar búsqueda web**
la reutiliza sin pedirla ni mostrarla. Luego pulsar **Empezar a conversar ahora**.
La nueva configuración conserva el modelo, habilita Responses y búsqueda web;
Calendar y Telegram se vinculan nuevamente si se necesitan. La anterior queda
disponible en **Configuraciones guardadas**. Las citas se conservan en el historial
y la interfaz web las muestra como enlaces. No se activan ejecución de código,
búsqueda de archivos ni otras herramientas de OpenAI automáticamente.

## Preparar el lanzador (desarrollo/distribución)

Una vez preparado el candidato local de Harness según el README:

```sh
bun run --cwd packages/assistant build:launcher
```

Genera `release-artifacts/Zhivex Assistant.app`, ignorado por Git. Este lanzador
apunta a Node y a este checkout: **no es un instalador autónomo, firmado ni
notarizado**. No mover/eliminar el proyecto ni Node mientras se use. Distribuir
Assistant a otras máquinas requiere empaquetar runtime y dependencias, firma,
actualizaciones y la configuración OAuth del producto.

El modo administrado también está disponible para desarrolladores con
`node packages/assistant/dist/cli.js --setup --open`; sin argumentos, el CLI
elige este modo. Los comandos CLI explícitos anteriores siguen disponibles.
No combinar `--setup` con flags del host anterior; admite `--directory` y
`--web-port` para un supervisor separado.

`bun run scripts/preview-onboarding.ts` (desde el paquete) sirve una vista de
prueba con almacenamiento temporal y modelo simulado; no usarla como instancia
personal. Sus datos se eliminan al detenerla con SIGTERM.

## Validación

`tests/web-setup.test.ts` cubre configuración sin credenciales, rechazo de accesos
sin token y solicitudes de otro origen, almacenamiento separado, bloqueo de
instancias duplicadas, rotación del acceso, historial entre reinicios y
configuraciones, fallos de llavero, prueba de proveedor, callback OAuth y
confirmación local del propietario de Telegram. Las integraciones se simulan;
no sustituyen una prueba con cuentas reales.

## Varios agentes y proveedores

En Assistant web, **Agregar agente** crea un agente independiente. Asignale un
nombre, guardalo y conectá su proveedor y modelo: OpenAI, Muse / Meta, Qwen o una
API compatible con OpenAI. Cada agente guarda sus propias credenciales,
conversaciones y conexiones de Calendar y Telegram. Las configuraciones guardadas
anteriormente aparecen como agentes, sin migrar ni borrar su historial.

El selector **Agente** permite volver a cualquiera de los agentes guardados;
**Configuración → Tus agentes** muestra su proveedor y modelo y permite
renombrarlos. Se admiten hasta 50 agentes, con uno activo a la vez. Antes de
cambiar, terminá o cancelá las tareas y aprobaciones pendientes y pausá el resumen
diario. Al reiniciar se recupera el último agente activo. Si el nuevo agente no
puede iniciarse, Assistant intenta recuperar el anterior y conserva el borrador.

### Reutilizar claves y actualizar modelos

Al agregar un agente, **Usar una conexión guardada** permite seleccionar un
proveedor ya conectado y elegir el modelo sin volver a escribir la API key.
La clave permanece en el llavero: la interfaz recibe únicamente el identificador
y la descripción de la conexión. El formato de almacenamiento se migra
automáticamente para guardar una sola clave por conexión; cada agente conserva
su configuración de modelo y una referencia a esa clave.

Para actualizar un agente, seleccionalo y abrí **Configuración → Tus agentes**.
Editá su modelo y pulsá **Probar y cambiar modelo**. Se prueba el acceso con la
clave guardada antes de aplicar el cambio. Se conservan el agente, sus conexiones
y las conversaciones; los mensajes siguientes usan el nuevo modelo. Primero
hay que terminar las tareas pendientes y pausar las automatizaciones. Si el
nuevo modelo no puede iniciarse, se intenta restaurar el modelo anterior.

### Administrar conexiones guardadas

En **Configuración → Conexiones guardadas** se muestran las conexiones y los
agentes que las usan. Ingresá la nueva API key y elegí **Probar y actualizar
clave** para actualizarla en todos esos agentes y en cualquier borrador que use
la misma conexión. El identificador de la conexión no cambia al rotar la clave.

Antes de guardar, Assistant prueba cada modelo y protocolo asociado. Si el
agente activo usa esa conexión, debe estar sin tareas pendientes y con su resumen
diario pausado; se reinicia con la nueva clave conservando su historial. Si falla
la prueba, el inicio o el guardado en el llavero, se conserva la configuración
anterior y se intenta recuperar el agente activo. Las claves nunca se devuelven
a la interfaz y el campo se vacía tras una actualización exitosa.

### Eliminar agentes y conexiones

En **Configuración → Tus agentes**, **Eliminar agente** pide confirmar y elimina
el agente junto con sus conversaciones y datos locales. Su conexión al proveedor
se conserva. Si es el agente activo, se detiene; no se permite eliminarlo con
tareas o aprobaciones pendientes ni con el resumen diario activo. Después podés
seleccionar otro agente o crear uno nuevo.

En **Conexiones guardadas**, **Eliminar conexión** elimina su clave del llavero
tras confirmar. Solo se permite cuando ningún agente ni borrador la utiliza.
La interfaz indica los usos y deshabilita el botón, y el servidor vuelve a
comprobar la condición antes de eliminar. Las conexiones sin agentes se conservan
entre reinicios hasta que decidas borrarlas y siguen disponibles para reutilizar.

### Cambiar la conexión de un agente

Seleccioná el agente y abrí **Configuración → Tus agentes → Conexión de …**.
Elegí una conexión guardada y pulsá **Probar y cambiar conexión**. Podés indicar
un modelo distinto; si dejás el campo vacío se usa el modelo de esa conexión.
No hace falta ingresar la API key nuevamente.

El agente conserva su identidad, historial, Calendar y Telegram. Las próximas
respuestas usan el provider nuevo con el contexto de la conversación. El cambio
requiere terminar las tareas pendientes y pausar el resumen diario. Se valida la
conexión antes de aplicarla y se intenta restaurar la anterior si falla el inicio
o el guardado. La conexión anterior queda guardada y puede eliminarse si ya no
la usa ningún agente ni borrador.

En **Tus agentes**, cada agente tiene su propia pestaña. Cambiar de pestaña solo
cambia la configuración visible y conserva los campos que estés editando.
**Activar agente** cambia el agente que responde, sin salir de Configuración.
Las pestañas admiten las flechas izquierda/derecha y las teclas Inicio/Fin;
en pantallas pequeñas se desplazan horizontalmente.

La creación de un agente también usa pestañas: **Agente**, **Modelo**,
**Calendar** y **Telegram**. Solo se muestra un formulario a la vez y los datos
se conservan al cambiar de pestaña. **Guardar y continuar** guarda el nombre y
abre Modelo; Calendar y Telegram siguen siendo opcionales.

## Panel de configuración

La configuración usa navegación lateral con **Agentes**, **Conexiones** e
**Integraciones**, una lista compacta y un editor del elemento seleccionado.
En Agentes, **Guardar cambios** valida y guarda nombre, conexión, modelo y búsqueda
web en una sola operación. **Cancelar** restaura los valores guardados. Para editar
un agente inactivo, usá **Activar agente**. Cambiar de sección con campos pendientes
pide confirmar su descarte.

Las claves API se editan en Conexiones. Los menús de opciones conservan las
acciones de eliminación y la protección de conexiones en uso. Integraciones
muestra Calendar y Telegram de cada agente; se conectan durante su creación.
En móvil, se navega de la lista al detalle y los botones de guardado permanecen
visibles mientras se desplaza el contenido del editor.
