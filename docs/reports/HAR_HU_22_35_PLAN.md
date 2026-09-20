# HAR-HU-22–35 — implementation and acceptance ledger

Objective: implementar el resto de las HU del harness. Source checkout `f61d40b`.

No completed flag without direct evidence. This ledger preserves the full scope across turns.

## HAR-HU-22 — Exponer el motor mediante un servicio local controlado

Source: https://app.notion.com/p/3e1777b104f681cdad6edcd7abcb70e3?pvs=204

- [x] El servicio encapsula el runtime y valida cada comando sin delegar autorización a la interfaz.
- [x] El transporte local restringe acceso al usuario autorizado; si usa sockets de red, verifica autenticación y origen y no expone escucha pública.
- [x] Inicio, apagado, caída de cliente y cierre del proceso tienen comportamiento definido y no abandonan efectos sin estado durable.

Evidence: docs/reports/HAR_HU_22_24_2026-09-20.md; 625 passing tests and installed Node subprocess crash/recovery smoke.

## HAR-HU-23 — Persistir y reproducir la actividad de una sesión

Source: https://app.notion.com/p/3e1777b104f68122a471f470056c2798?pvs=204

- [x] Los eventos tienen ID estable, secuencia, run/session y esquema versionado, con redacción y límites de retención.
- [x] Una suscripción con cursor recupera lo faltante y tolera duplicados; un cursor expirado obtiene snapshot y señal explícita.
- [x] Desconectar/reconectar durante streaming y aprobación reconstruye estado y texto sin duplicar herramientas ni efectos.

Evidence: docs/reports/HAR_HU_22_24_2026-09-20.md; 625 passing tests and installed Node subprocess crash/recovery smoke.

## HAR-HU-24 — Coordinar aprobaciones y cancelación entre clientes

Source: https://app.notion.com/p/3e1777b104f6811f8da9dbeb86a190bd?pvs=204

- [x] Dos clientes que responden a la misma aprobación producen una sola decisión efectiva; el segundo recibe conflicto legible.
- [x] Aprobaciones se vinculan a identidad, alcance y revisión; caducidad o cambios invalidan respuestas obsoletas.
- [x] Cancelar, reconectar y reanudar con fallos inyectados mantiene leases, estado y journal sin repetir efectos.

Evidence: docs/reports/HAR_HU_22_24_2026-09-20.md; 625 passing tests and installed Node subprocess crash/recovery smoke.

## HAR-HU-25 — Conectar la CLI al servicio preservando compatibilidad

Source: https://app.notion.com/p/3e1777b104f681439edae7b512ce6281?pvs=204

- [x] Un adaptador CLI usa comandos/eventos del servicio y mantiene los contratos públicos documentados.
- [x] El modo no interactivo conserva códigos de salida y salida estructurada; se documenta cualquier cambio o deprecación.
- [x] La misma sesión se inicia por CLI, consulta por otro cliente y recupera tras desconexión con pruebas sobre paquete instalado.

Evidence: docs/reports/HAR_HU_25_2026-09-20.md; 627 tests and installed CLI/service recovery smoke passed.

## HAR-HU-26 — Validar arquitectura y empaquetado del escritorio

Source: https://app.notion.com/p/3e1777b104f68127b878c070f94238cd?pvs=204

- [x] Un spike Electron + React abre una ventana y conversa con un proceso runtime separado mediante el contrato mínimo.
- [x] Se comprueban SQLite, cancelación, arranque y OCI en macOS; se documentan compatibilidad Node y límites de empaquetado.
- [x] Una decisión de arquitectura acepta o descarta la hipótesis con evidencia y amenazas; el renderer no recibe acceso general a filesystem ni credenciales.

Evidence: docs/reports/HAR_HU_26_2026-09-20.md; packaged Electron smoke and macOS OCI smoke passed. Unsigned architecture spike only.

## HAR-HU-27 — Abrir proyectos y navegar conversaciones

Source: https://app.notion.com/p/3e1777b104f681d4b8c0c08926b36e5f?pvs=204

- [x] La interfaz permite seleccionar repositorio, ver proyectos recientes y crear/listar conversaciones por proyecto.
- [x] Elegir sesión recupera estado desde el servicio y muestra carga, vacío y errores con acciones útiles.
- [x] La navegación funciona por teclado y los proyectos mantienen contexto separado sin ejecutar acciones al seleccionarlos.

Evidence: docs/reports/HAR_HU_27_2026-09-20.md; registry regression tests and packaged two-project/navigation/reload smoke passed.

## HAR-HU-28 — Conversar y observar el progreso de una tarea

Source: https://app.notion.com/p/3e1777b104f681c8bb76e138bf016bb2?pvs=204

- [x] Chat muestra streaming, herramientas, checks y estados sin exponer secretos ni renderizar contenido activo inseguro.
- [x] Enviar y cancelar usa el contrato del servicio, con prevención de envíos duplicados y estados de error recuperables.
- [x] Reabrir una conversación reconstruye actividad y resultado mediante snapshot/replay, incluso después de una desconexión.

Evidence: docs/reports/HAR_HU_28_2026-09-20.md; 633 tests, installed CLI/SDK smoke and packaged chat/fault/replay smoke passed.

## HAR-HU-29 — Revisar diffs y resolver aprobaciones en escritorio

Source: https://app.notion.com/p/3e1777b104f681fb9c57eb4e53ca5c9e?pvs=204

- [x] Un visor presenta archivos, diff, comandos y evidencia de checks ligados al run y parche concretos.
- [x] Aprobar y rechazar muestran consecuencias y alcance; el servicio rechaza decisiones caducadas o conflictos con otro cliente.
- [x] Los estados pendiente, rechazado, fallido y aplicado son distinguibles; contenido de repositorio no puede accionar controles de aprobación.

Evidence: HAR_HU_29_CLOSURE_2026-09-20.md; 654 tests pass and both packaged flows pass. Implemented, pending publication.

## HAR-HU-30 — Completar el flujo alpha y recuperar trabajo tras reinicio

Source: https://app.notion.com/p/3e1777b104f68109bd14c4b4b0640a70?pvs=204

- [x] Un paquete de prueba permite abrir repositorio, pedir cambio, aprobar, verificar y revisar el diff final.
- [x] Se ensayan caída de renderer, desconexión, reinicio del servicio y cierre de ventana con una aprobación pendiente; se documenta cuándo continúa o pausa el trabajo.
- [x] La misma sesión es coherente en CLI y escritorio; se publica una lista priorizada de fallos y el criterio de entrada a beta.

Evidence: HAR_HU_30_CLOSURE_2026-09-20.md. All three criteria and the remaining
alpha P1 issues are verified locally. The package demonstrates a SIGKILL after
file write/before journal completion, unknown outcome preservation, old-approval
rejection, explicit cancellation after lease expiry and continuation without replay.
667 tests, 3790 assertions; current packaged restart and OCI fixture regression pass.
Implemented, pending publication. Signing and real OCI/provider certification are
separate; no beta claim. Historical increments remain in their dedicated reports.

## HAR-HU-31 — Aislar tareas en worktrees administrados

Source: https://app.notion.com/p/3e1777b104f681319a9ac8db519c9caf?pvs=204

- [x] Crear tarea permite asignar worktree y rama con identidad persistida y estado visible.
- [x] Cambios sin commit del checkout original no se pierden ni se copian implícitamente; la política de estado inicial es explícita.
- [x] Limpiar worktree requiere revisar cambios no integrados; dos tareas concurrentes y un reinicio conservan sus entornos separados.

Implemented and verified locally; pending publication. Evidence:
HAR_HU_31_CLOSURE_2026-09-20.md. 673 tests pass (3837 assertions); types,
documentation and stable contracts pass. The unsigned macOS arm64 package verifies
two concurrent task workers, separate sessions/files, whole-app restart, explicit
cleanup review and original staged/unstaged/untracked preservation. General desktop
and offline OCI review regressions also pass on this candidate.

## HAR-HU-32 — Crear commits y pull requests con autorización explícita

Source: https://app.notion.com/p/3e1777b104f6810f8471e3c472071aa5?pvs=204

- [x] El usuario revisa archivos staged, mensaje, rama y destino antes de autorizar commit, push o creación de PR.
- [x] La integración no incluye archivos ajenos ni secretos y usa credenciales existentes sin exponerlas al modelo.
- [x] Conflictos, remoto desactualizado y fallo de red conservan estado recuperable; reintentar no duplica commits o PRs y no habilita force-push implícito.

Implemented and verified locally; publication remains pending by user instruction.
Closure: HAR_HU_32_PR_UI_2026-09-20.md. Commit/staging, reviewed push and PR
creation use separate host-authorized snapshots and durable reconciliation.
695 tests pass (3985 assertions); packaged worktree journey verifies exactly one
commit/push/PR, lost-response recovery, whole-app restart and verified PR routing.
GitHub requests are simulated and pushes target a local bare fixture. Live GitHub
authentication is not certified. Secret detection is bounded. The candidate remains
unsigned and unnotarized; no implementation-branch push or real PR was performed.
Earlier increments: HAR_HU_32_COMMIT_UI_2026-09-20.md,
HAR_HU_32_PUSH_UI_2026-09-20.md and HAR_HU_32_PR_MANAGER_2026-09-20.md.

## HAR-HU-33 — Guardar credenciales en el almacén seguro del sistema

Source: https://app.notion.com/p/3e1777b104f681459966fbb71f9f5c78?pvs=204

- [ ] La aplicación almacena y elimina claves mediante el almacén seguro de macOS; no aparecen en SQLite, logs, renderer ni exportaciones.
- [ ] La configuración muestra presencia y prueba acotada de conexión sin revelar el secreto.
- [ ] Bloqueo del almacén, rotación y credencial inválida ofrecen recuperación; otros sistemas quedan sin soporte hasta validar su backend.

Evidence: pending.

## HAR-HU-34 — Distribuir un instalador macOS firmado y verificable

Source: https://app.notion.com/p/3e1777b104f6815bb468f800ff8b80cc?pvs=204

- [ ] Un instalador macOS firmado y notarizado contiene runtime y dependencias compatibles con las arquitecturas declaradas.
- [ ] Instalación limpia, apertura, SQLite y conexión al runtime pasan en el artefacto distribuido; ausencia de OCI muestra instrucciones claras.
- [ ] Versión, hash y notas de release coinciden con la fuente; permisos requeridos y desinstalación que preserva datos están documentados.

Evidence: pending.

## HAR-HU-35 — Actualizar la aplicación con recuperación de estado

Source: https://app.notion.com/p/3e1777b104f681149546e5dcf0557092?pvs=204

- [ ] Las actualizaciones verifican firma e integridad y distinguen canal estable de prerelease.
- [ ] No se interrumpe una operación crítica para actualizar; se prueban descarga parcial y fallo de instalación.
- [ ] La migración de estado cuenta con backup y recuperación compatible; una versión antigua rechaza esquemas incompatibles y el usuario dispone de diagnóstico sanitizado.

Evidence: pending.

## Delivery order

1. Runtime owner and protected local transport (22), durable replay (23), coordinated decisions/cancellation (24), CLI client (25).
2. Electron/React spike with isolated renderer and separate runtime, SQLite/OCI/macOS packaging evidence (26).
3. Projects, conversations, streaming, review and recovery in a tested alpha artifact (27–30).
4. Managed worktrees, explicit Git authorizations and macOS credential storage (31–33).
5. Signed/notarized installer, integrity/versioned release evidence and tested update recovery (34–35). Actual signing/notarization requires an available Developer ID and notarization profile; do not substitute unsigned/ad-hoc artifacts for acceptance.

User decision: prepare packaging now; configure Developer ID/notarization later. HU-34 signing acceptance remains outstanding.

## HU29 work in progress

Read-only approval projection and desktop panel implemented after b6fbc58. Three
projection tests and desktop TypeScript pass; development Electron smoke opened a
real pending run_check approval and verified the review revision/digest. Still open:
positive/negative decision flow, full patch-bound before/after and check evidence,
and durable distinction between denied, failed and applied operations. No HU29
acceptance box is closed by this partial increment.

Second HU29 increment: host-held one-use review receipts, strict decision shape,
captured revision/digests, expiry checks, 128-receipt bound and blocked renderer
approval.resolve bypass. UI offers scoped approve/reject; positive file/OCI decisions
remain disabled pending complete previews. Six targeted tests (22 assertions),
desktop typecheck/build and development Electron smoke passed; smoke resolved the
real pending check through a receipt and rejected the generic renderer bypass.
Evidence: /tmp/har-electron-NsAkBU/report. This does not certify the buttons end to
end, persistent decision history, stale-client scenarios or the installed package.

Third HU29 increment: complete protected file previews and packaged approval/rejection
flow verified. Terminal continuation after denial repaired. Evidence and remaining
criteria: HAR_HU_29_PROGRESS_2026-09-20.md. Suite: 645 pass, 0 fail; package smoke
includes exact preimage/destination, reject-preserves-file and literal HTML-like text.

Fourth HU29 increment: durable decision intent and journal-bound effect history.
Status-distinction criterion verified by unit/integration tests and packaged
renderer-reload flow. Evidence: HAR_HU_29_HISTORY_2026-09-20.md. Remaining acceptance
criteria stay open; no publication claim.

Fifth HU29 increment: read-only OCI content/mode previews and verified import
history bound to patch/run/argv. 654 full-suite tests pass; OCI integration uses a
fixture runtime. Packaged local-flow regression and installed CLI/SDK smoke pass.
Evidence and explicit remaining demonstration: HAR_HU_29_OCI_2026-09-20.md.

HU30 in progress: pending-approval runtime crash recovery now works through
“Reabrir proyecto”; dead-owner cleanup is serialized without blocking contention.
655 tests and packaged recovery smoke pass. Evidence and remaining acceptance:
HAR_HU_30_RECOVERY_2026-09-20.md. No HU30 checkbox is closed by this increment.

HU30 active-run increment: explicit orphan cancellation requires an available
execution lease; live owners are preserved, children are requested to stop without
finalizing them, and no tool is replayed. 656 tests (3744 assertions) and the
unsigned packaged Electron crash/reopen/cancel flow pass, as does installed
CLI/SDK smoke. Evidence: HAR_HU_30_ACTIVE_RECOVERY_2026-09-20.md. HU30 remains open.
