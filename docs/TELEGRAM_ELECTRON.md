# Vincular Telegram desde Electron

> Historical monorepo integration guide. Electron now belongs to [zhivex-app](https://github.com/Zhivex/zhivex-app); use its README for current installation, artifact preparation and build commands. The instructions below retain their original integration context.

> Las rutas históricas `reports/unification/…` citadas en este documento pertenecen al [archivo interno](INTERNAL_ARCHIVE.md); los originales se conservaron fuera del árbol publicable.

Al crear un Assistant, el borrador incluye la sección opcional **Telegram**. El flujo usa las acciones del gestor compartido del core; no hay un segundo cliente de bot en el renderer.

1. Introducir el token del bot y elegir **Verify Telegram bot**. El core comprueba el bot y rechaza un webhook ya configurado.
2. Elegir **Open Telegram pairing** y presionar Start en el chat privado con el bot. El enlace vence a los diez minutos. El proceso principal sólo abre el enlace actual que devuelve el core; no recibe una URL arbitraria del renderer.
3. Elegir **Check private account**. Un mensaje de grupo, de un bot, de otro chat o con un código anterior no verifica al propietario.
4. Revisar el ID detectado, marcar **This is my private Telegram account** y confirmar.
5. Completar la conexión del modelo y arrancar el agente. Si se habilitan tareas/recordatorios, el resumen diario queda disponible en **Automations**; su activación requiere una revisión separada.

No se puede arrancar el agente mientras una vinculación esté pendiente. **Cancel Telegram pairing** descarta el token y desafío transitorios. **Remove Telegram from draft** retira la conexión guardada del borrador; no revoca el token en Telegram. El token se borra del campo al enviarlo, no aparece en el estado público y sólo se guarda con el borrador después de confirmar la cuenta. El gestor normal usa el llavero del sistema.

Esta pantalla cubre nuevos borradores. La edición/revinculación de un agente ya iniciado, OAuth de otras integraciones y entrega real con una cuenta de usuario siguen pendientes de certificación en Electron.

## Validación

```sh
bun test tests/application-telegram.test.ts tests/assistant/web-setup.test.ts
bun run --cwd packages/desktop smoke:telegram:packaged
```

El smoke usa Electron y core instalados, el puente Telegram y el scheduler reales. Inyecta respuestas HTTP y un almacén de secretos en memoria. Comprueba el rechazo de grupos, cancelación, confirmación explícita del ID, ausencia del token en el estado público y arranque con el scheduler disponible. Intercepta la apertura del enlace y no contacta Telegram ni envía mensajes. Las pruebas del core también verifican código obsoleto, cuenta incorrecta y eliminación del token del borrador. Evidencia: `reports/unification/telegram-onboarding/`.

Google Calendar puede autorizarse en el mismo borrador desde [Calendar OAuth](CALENDAR_ELECTRON.md).
