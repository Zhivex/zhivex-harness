# Calendar OAuth en Electron

> Las rutas históricas `reports/unification/…` citadas en este documento pertenecen al [archivo interno](INTERNAL_ARCHIVE.md); los originales se conservaron fuera del árbol publicable.

El borrador de un Assistant incluye **Google Calendar (optional)**. Se usa el OAuth existente del core, con PKCE, callback local, comprobación del estado y credenciales cifradas. La app no implementa otro flujo de intercambio de tokens.

1. En Assistant settings, crear un borrador y completar el cliente OAuth de Google. Si el host tiene `ASSISTANT_GOOGLE_CLIENT_ID` configurado, se puede usar ese cliente dejando los campos vacíos. El secreto de cliente es opcional y se borra del campo al enviarlo.
2. Elegir **Connect Google Calendar**. Electron abre la autorización vigente en el navegador del sistema. Google presenta los permisos solicitados; las escrituras posteriores siguen pasando por la revisión de herramientas.
3. Mantener la app abierta. La pantalla consulta el estado mientras espera, muestra la cuenta conectada al completar el callback y bloquea **Connect and start** mientras exista una autorización pendiente.
4. Se puede volver a abrir el enlace vigente o elegir **Cancel Calendar authorization**. La autorización vence a los diez minutos. Una cancelación o fallo permite iniciar un flujo nuevo; no reutiliza el estado OAuth anterior.
5. Completar la conexión del modelo y arrancar el agente. Las consultas y cambios de Calendar usan las herramientas del core; la pantalla [Today & agenda](AGENDA_ELECTRON.md) consulta eventos por fecha y zona horaria.

El renderer no proporciona URLs al sistema operativo. El proceso principal consulta `authorization` en el coordinador y acepta sólo el endpoint HTTPS de autorización de Google, sin credenciales embebidas, puertos alternativos ni fragmentos. El enlace no se entrega al renderer. Tokens y secretos no aparecen en el estado público; los refresh tokens quedan cifrados en el store local y la clave se conserva en el almacén de secretos del gestor.

Esta entrega cubre Calendar en nuevos borradores. Gmail/Drive, Microsoft, desconexión y revinculación de perfiles existentes siguen pendientes en la nueva UI. El entorno del propietario del coordinador determina los valores predeterminados; exportar variables en otro terminal no cambia el proceso ya iniciado.

## Validación

```sh
bun test tests/application-calendar.test.ts tests/assistant/web-setup.test.ts
bun run --cwd packages/desktop smoke:calendar:packaged
```

La prueba empaquetada usa el core instalado, callback loopback, PKCE y SQLite reales. Inyecta Google HTTP y almacenamiento de secretos, e intercepta la apertura del navegador. Verifica cancelación, rechazo del estado anterior, actualización automática de la cuenta, secreto fuera del estado público, refresh token cifrado y arranque del agente con Calendar. No accede a una cuenta real ni certifica consentimiento live. Evidencia: `reports/unification/calendar-onboarding/`.
