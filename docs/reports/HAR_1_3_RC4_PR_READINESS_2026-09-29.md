# Harness RC4 — preparación para PR

El incremento queda preparado en `feat/provider-reliability-acceptance` para
revisión. No se abrió PR ni se publicó. La certificación protegida de release
requiere configuración externa y ejecución sobre el commit integrado.

## Cambios de cierre

- Harness `1.3.0-rc.4` y Code `0.1.0-rc.2`, con dependencia exacta. Ambas versiones
  se comprobaron ausentes en npm. Las versiones publicadas no se modificaron.
- Tarball con documentación Vertex, política y fixture MCP; se retiraron los
  enlaces empaquetados a reportes de desarrollo. `artifact:check` pasa, 322 archivos.
- Desktop privado fija `harness.version` y exige la instalación explícita del
  tarball; no intenta resolver la RC inédita desde npm al instalar sus herramientas.
  Build/package conservan controles de versión, instalación y hash.
- Release protegido exige seis rutas, compactación con aprobación, delegación
  estructurada, OCI, continuidad entre procesos y cuatro cruces. Los modelos de
  Meta/Qwen/OpenAI coinciden con la matriz representativa del nuevo tag; los pins
  históricos y los modelos predeterminados de los usuarios se conservan.
- Vertex usa el action oficial fijado por SHA y OIDC; preflight comprueba presencia
  de configuración antes de consumir APIs. Los secretos siguen limitados a pasos.
- El smoke MCP acepta un tarball inmutable explícito, sin volver a empaquetarlo.
- El fixture de captura Desktop usa la captura del compositor después de las
  aserciones de DOM, con la ventana visible y despierta. Conserva los límites de
  ejecución y todas las verificaciones de aprobación/rechazo. No cambia el modo
  de producción ni sustituye pruebas funcionales por capturas.

## Artefactos y validación

Harness SHA256:
`cd43a2e313b56303bb9476011574ac172b08a4fc0bfc624e2f97b9cb848a1b32`.
Code SHA256:
`12f0c5584a53b0371a338fb63748a7f238cdcbd8dd2850b5026b541f7dc1ccc0`.
Los 244 archivos dist de Harness coinciden con el build y la instalación usados.
El informe JSON compañero contiene resultados y digests de evidencia.

- `bun run check`: **1891 pass, 1 skip, 0 fail**, más arquitectura, documentación,
  contratos, tipos, migraciones, evaluaciones, benchmarks y smokes MCP/OCI/paquete.
  La modificación posterior se limita al fixture de capturas Desktop y se valida
  mediante el watchdog y el recorrido empaquetado; no se atribuye esa modificación
  a la ejecución anterior de toda la suite.
- Code: tipos, **100 tests**, inspección del tarball y consumidores Node 22.13/24.11.
  Cuatro gestores y ambos órdenes: **16 casos locales y 16 globales**. Además,
  cuatro casos locales con pnpm 11.25.0, la versión de CI (la primera matriz usó
  pnpm 10.19.0). Prefijos y registro de prueba aislados; sin instalaciones globales
  del operador ni afirmaciones sobre todas las plataformas.
- Política, revisión, observabilidad, contratos, entrega OCI, recuperación,
  delegación y gobernanza: **65 fases instaladas** en Node 22.13.
- MCP real aislado: paquete exacto, Node 22.13, Node 24.11 y Bun 1.4.
- Transición RC3 local → RC4: sesión preservada, aprobación incompatible rechazada
  sin invocar el modelo ni escribir, y recuperación mediante el runtime anterior.
- Desktop unsigned macOS arm64: conversación/aprobaciones, reinicio/diff,
  checkpoints y revisión explícita empaquetados. CLI de checkpoints aprobada.
- Auditoría de dependencias sin vulnerabilidades; redacción SDK aprobada.
  El postinstall de protobufjs continúa bloqueado, no se habilitó.

## Matriz live del mismo RC4

| Ruta | Modelo | Base / compactación / delegación / OCI / continuidad |
| --- | --- | --- |
| Anthropic | claude-sonnet-5-5 | 5/5 |
| Vertex | gemini-3.7-flash | 5/5 |
| Gemini API | gemini-3.6-flash | 5/5 |
| OpenAI | gpt-6-luna | 5/5 |
| Qwen | qwen3.8-max | 5/5 |
| Meta | muse-spark-1.3 | 5/5 |

Continuidad: **36/36**. Cruces OpenAI→Vertex/Anthropic/Gemini y Qwen→Meta: **4/4**.
Todos estos gates se ejecutaron sobre RC4. No se transfirió la certificación del
tarball anterior. Una invocación por gate, con la política existente de hasta tres
intentos transitorios internos en base/compactación; no se promete primer intento.
El piloto competitivo previo permanece ligado a su hash RC3 local y no se relabela
como una nueva campaña RC4.

## Fallos preservados y corrección

El primer consumidor no encontró Yarn; se completó con el ejecutable temporal
existente. La primera suite tuvo seis ENOENT porque la instalación sin scripts
retiró el binario Electron; se restauró con el instalador explícito usado por CI
y la cadena completa pasó. La primera invocación MCP recibió el tarball como
runtime; la nueva opción de artefacto elimina esa ambigüedad.

Los intentos de revisión explícita conservaron timeouts de animation frames y un
error del compositor. Mantener background throttling desactivado por sí solo no
resolvió la captura. La corrección final no aumenta tiempos ni elimina aserciones:
solicita la captura directamente con la ventana visible y despierta.

## Requisitos posteriores al PR

1. Configurar en `live-certification` los secretos Anthropic/Gemini y las variables
   Vertex indicadas en `docs/RELEASE.md`, con la identidad federada autorizada.
   El inventario consultado no los contiene; no se copiaron credenciales locales.
2. Revisar/integrar el cambio y obtener CI/CodeQL remotos del commit final.
3. Ejecutar el release protegido, evaluación representativa y publicación con
   verificación de integridad/provenance. Publicar Harness antes de Code.

El gate de release completo sigue rechazando correctamente esta rama con cambios
locales; solo señala árbol no limpio y rama distinta de main. No se debilitaron
esas restricciones para conseguir una salida verde antes del PR.
