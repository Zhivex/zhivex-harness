# HU45/HU57: cobertura consolidada del candidato instalado

Candidato Harness 1.3.0-rc.3, SHA256 `993bc5a63bff13ce8ac015061082a1ad4384b4257d3f91b488891f6bb8700d92`. Los 241 archivos de dist instalados coinciden byte a byte con el tarball. El JSON homónimo conserva planes previos, resultados nuevos y fallos históricos; no es un registro de publicación ni certificación del pipeline protegido de release.

| Ruta | Modelo | Base y efecto único | Compactación/aprobación/reinicio | Delegación estructurada/reapertura | OCI | Continuidad |
| --- | --- | --- | --- | --- | --- | --- |
| Vertex | gemini-3.7-flash | Pasa | Pasa | Pasa | Pasa | 6/6 |
| Anthropic | claude-sonnet-5 | Pasa | 3/3 repeticiones nuevas; fallo anterior preservado | Pasa | Pasa | 6/6 |
| OpenAI | gpt-6-luna | Pasa | Pasa | Pasa | Pasa | 6/6 |
| Qwen | qwen3.8-max | Pasa | Pasa | Pasa | Pasa | 6/6 |
| Meta | muse-spark-1.3 | Pasa | Pasa | Pasa | Pasa | 6/6 |
| Gemini API | gemini-3.6-flash | Pasa | Pasa | Pasa | Pasa | 6/6 |

Routing seleccionado: OpenAI a Vertex, Anthropic y Gemini; Qwen a Meta. Los cuatro pasan. No se ejecutó la matriz completa de pares dirigida. Vertex y Gemini API son rutas distintas aunque ambas sirvan modelos de Google.

Las tres repeticiones de Anthropic se fijaron antes de ejecutarlas y se ejecutaron todas. Conservan el mismo candidato, modelo y smoke; no hubo reintentos selectivos para sustituir fallos. Los drivers mantienen su política propia de reintentos de errores transitorios. La campaña inicial de compactación de este candidato fue 4/5, seguida de un diagnóstico Anthropic exitoso y estas tres repeticiones exitosas. No presentar todo el historial como 100% ni inferir una tasa poblacional de fiabilidad.

HU57: 18 fases instaladas de nueve escenarios compartidos con HU44 pasan en Node 22.13: valid, invented, partial, tool-error, invalid, corrected, exhausted, cancellation y correction-cancel. Cada escenario se ejecuta e inspecciona en procesos separados. Incluyen rechazo de evidencia inventada/parcial y conservación de límites/cancelación durante corrección. Son modelos sintéticos; la delegación real se acredita por separado en las seis rutas de la tabla.

No hubo cambios de motor en esta consolidación. Se conserva la validación del código del candidato: 1858 tests pasan, 1 omitido, sin fallos; build, tipos y contrato aprobados en la verificación previa. La comprobación documental actual también pasa. No se transfirieron resultados del tarball anterior db853c7a.

HU45 y HU57 pueden pasar a revisión de la entrega local. La publicación y promoción formal de soporte siguen pendientes: las etiquetas de soporte del artefacto no cambian por ejecutar esta campaña. HU45 conserva pendiente su criterio de publicación de evidencia. Sin commit, push ni PR. HU51 tiene ahora evidencia identificada del candidato para fijar el piloto; aún requiere implementar adaptadores, fijar sus configuraciones y ejecutar los 42 casos acordados. Estos smokes no sustituyen ese piloto ni demuestran preparación general para producción.
