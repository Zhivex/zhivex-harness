# Harness 1.3 — auditoría de despliegue, 29/09/2026

**No está listo para publicar el incremento actual.** Las HU39–58 tienen
implementación y evidencia para revisión, pero quedan defectos de empaquetado,
preparación de versión y gates de entrega. Los criterios marcados en Notion no
equivalen a una publicación ni a certificación del próximo artefacto.

## Identidad y alcance

- Rama: `feat/provider-reliability-acceptance`; HEAD base `e0c4abc` más cambios
  locales. No se ha creado commit, push, PR, tag ni publicación en esta auditoría.
- Candidato local: `1.3.0-rc.3`, SHA256
  `2f4af7d422825d466bafa2ab3f08b9675d024471924a258c46b07005b001bafc`.
- Los 244 archivos `dist` del tarball coinciden byte a byte con su instalación
  limpia y con el build actual. Es una identidad local, distinta de npm RC3.
- Suite previa del mismo runtime: **1889 pass, 1 skip, 0 fail**, 11324 aserciones,
  243 archivos. Se releyó `/tmp/context-efficiency-v3-suite.log`; no se atribuye
  una nueva ejecución de la suite completa a esta auditoría.
- Recertificación por ruta y pruebas instaladas adicionales:
  `HAR_HU_45_CONTEXT_RECERTIFICATION_2026-09-29.json`. La evidencia Anthropic
  proviene de los cinco gates del mismo hash ejecutados anteriormente hoy;
  los cinco proveedores restantes y cuatro cruces se ejecutan en este seguimiento.
  No se mezclan resultados del antiguo candidato `1dc3375a`.

## Notion: revisión de las 23 historias del plan

Resultado final de recertificación: **6 rutas × 5 gates aprobados**, continuidad
**36/36** y **4/4 cruces** (OpenAI → Vertex/Anthropic/Gemini; Qwen → Meta).
Los consumidores instalados adicionales pasan **65 fases** en Node 22.13.
No hubo repetición selectiva de gates; base/compactación conservan hasta tres
intentos transitorios internos. El driver no informa cada intento interno, por lo
que no se afirma éxito al primer intento para esas celdas.

Se leyeron las páginas completas y criterios de HU36–58. Antes de corregir
estados, HU36 figuraba Hecha; HU37–58 En revisión. HU39–58 sumaban **72 de 73
criterios marcados**; HU45 mantiene abierto publicar la evidencia y cerrar todos
los gates aplicables. Esto mide el tablero, no un porcentaje de producción.

| HU | Alcance | Situación auditada |
| --- | --- | --- |
| 36 | Frontera de paquetes / ADR | Hecha; entrega no aplica. |
| 37–38 | Motor público y paquete Code | Publicados en la entrega anterior. Se corrigió Notion a Hecha/Publicada. |
| 39 | Desktop con motor empaquetado | Implementado; smoke empaquetado histórico unsigned macOS arm64. Revalidar con la versión final. |
| 40 | Compatibilidad y releases independientes | Implementado y matriz local histórica documentada; falta aceptación del nuevo par de versiones en CI. |
| 41–43 | Anthropic, Gemini y Vertex | Implementados; recertificación local por ruta/modelo/hash. Soporte protegido/publicación pendientes. |
| 44 | Suite de aceptación común | Fixtures y mediciones implementados; no sustituye la certificación de release. |
| 45 | Certificación de proveedores | Gates locales en informe separado; criterio de publicación/protección sigue abierto. |
| 46–48 | Contrato MCP aislado, runtime OCI y ACP | Implementados; servidor real y cliente SDK probados. No declara conformidad ACP completa. |
| 49–50 | Checkpoints y retención | Implementados; evidencia CLI/Desktop y recuperación histórica. Revalidar paquete Desktop final. |
| 51 | Piloto comparativo | Harness 21/21 y referencia SDK 21/21, Sonnet 5.5, mismos presupuestos; resultados locales publicados en Notion. |
| 52–55 | Políticas, revisión, observabilidad y contratos | Implementados; se repiten consumidores instalados sobre el candidato actual. APIs experimentales. |
| 56–57 | Entrega verificada y delegación estructurada | Implementados; se repiten casos OCI, recuperación y delegación con el mismo hash. |
| 58 | Informe portable de gobernanza | Implementado; seis escenarios y doce fases instaladas recertificados. |

HU39–58 permanecen En revisión / Pendiente de publicación. No se han cerrado
como Hecha por pasar tests. La revisión explícita no acredita identidad corporativa;
los informes no aportan firma externa; el alcance de aislamiento es el documentado.
El piloto compara con una referencia técnica SDK, no con productos comerciales.
Harness consume 3,55 veces la entrada de esa referencia; no demuestra superioridad
general ni coste monetario conocido. La reducción histórica comparable es 36,3%.

## Bloqueos concretos de entrega

1. **Versión ocupada.** npm ya publica Harness `1.3.0-rc.3` (`next`), mientras
   `latest` sigue en `1.2.0`; Code `0.1.0-rc.1` existe en `next` y `latest`.
   `release:status` rechazó el candidato porque los bytes de RC3 son distintos.
   Hace falta una nueva versión, changelog y pins coherentes de Code/Desktop;
   no se puede sustituir la RC3 publicada.
2. **Tarball incompleto.** `artifact:check` falla en README → `docs/VERTEX.md`.
   El mismo resolutor del gate encuentra seis referencias rotas en cinco archivos:
   Vertex; `TOOL_POLICY.md` desde CLI y STABILITY; dos enlaces al reporte HU39
   desde ENGINE_API; y el fixture MCP desde el ADR. Incluir documentación/fixtures
   de consumidor y retirar o convertir referencias a informes de desarrollo:
   `docs/reports` está deliberadamente excluido del paquete. Conservar el gate.
3. **Certificación protegida incompleta para el alcance nuevo.** El workflow
   `release.yml` sigue seleccionando solo `meta,qwen,openai`, con modelos Meta/Qwen
   distintos de esta campaña local. Falta configurar Anthropic/Gemini/Vertex y
   sus credenciales/identidad protegidas, compactación, continuidad, delegación
   estructurada y cruces requeridos. No trasladar ADC del equipo ni secretos al repo.
4. **Integración y CI pendientes.** `release:preflight` pasa los metadatos actuales,
   pero `check-release-readiness.ts` falla por árbol sucio y rama distinta de main.
   El preflight no prueba disponibilidad de versión sin consultar el registro.
   Hace falta revisión/integración y la cadena completa de checks de release.
5. **Artefacto final y clientes.** Al corregir versión/contenido cambiará el hash.
   Generar un nuevo artefacto inmutable, instalarlo y ejecutar los gates pertinentes,
   incluido el par Harness/Code y Desktop empaquetado. Los smokes históricos de
   clientes no certifican automáticamente los nuevos bytes. Luego publicación
   protegida y verificación de registro, integridad y provenance de la entrega.

## Publicaciones anteriores verificadas en vivo

El registro público y los workflows se consultaron el 29/09/2026:

- [Harness RC3: workflow exitoso](https://github.com/Zhivex/zhivex-harness/actions/runs/36470356555).
- [Code RC1: workflow exitoso](https://github.com/Zhivex/zhivex-harness/actions/runs/36505200186).
- Ambos corresponden a `6b74df8a428980cef37aa3c9d9e0d66ec0a28d8e`.
- npm anuncia attestations SLSA para ambas versiones. Esta consulta no reejecutó
  el verificador completo de provenance de la publicación anterior.

Estas entregas cierran HU37/38, pero no contienen el trabajo local HU39–58.
Los informes históricos y fallos intermedios se conservan. El estado actual del
plan en Notion se actualiza mediante una nota nueva, sin borrar su cronología.
