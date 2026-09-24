// Offline visual fixture. Real CLI and workspace tools; no provider request leaves this process.
let round = 0;
globalThis.fetch = async (url, options) => {
  if (!String(url).endsWith('/responses')) throw new Error('Unexpected visual fixture endpoint');
  const index = round++;
  const text = index === 0 ? 'Reviso el provider y la configuración del proyecto.\n'
    : index === 1 ? 'Encontré la integración de Qwen. Compruebo los detalles.\n'
    : '\n## Soporte de QwenCloud\n\nEl provider está actualizado a **0.15.2** y admite **Token Plan**\ncon Qwen 3.8 Max y Flash.\n\n- Configura el endpoint de Token Plan y su credencial dedicada.\n- La conversación conserva el contexto después de usar herramientas.\n- La actividad desaparece cuando continúa la respuesta.\n\nPuedes consultar el detalle con `/verbose` cuando lo necesites.\n';
  const stream = new ReadableStream({
    async start(controller) {
      const send = event => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      for (const delta of text.match(/.{1,9}|\n/g) ?? []) {
        send({type:'response.output_text.delta',delta});
        await new Promise(resolve => setTimeout(resolve,30));
      }
      if(index < 2) send({type:'response.output_item.done',item:{type:'function_call',id:`fc_${index}`,call_id:`call_${index}`,name:index === 0 ? 'list_files' : 'read_files',arguments:JSON.stringify(index === 0 ? {path:'.'} : {files:[{path:'README.md'}]})}});
      send({type:'response.completed',response:{id:`resp_${index}`,status:'completed',usage:{input_tokens:240,output_tokens:100,total_tokens:340}}});
      controller.close();
    }
  });
  return new Response(stream,{headers:{'content-type':'text/event-stream'}});
};
