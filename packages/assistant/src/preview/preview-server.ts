/** Dedicated unprivileged static-preview worker. It never reads the repository or imports the host. */
import {createServer} from 'node:http';
import path from 'node:path';
const mime:Record<string,string>={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.txt':'text/plain'};
process.once('message',(message: {files:[string,string][]})=>{
  const files=new Map(message.files.map(([name,data])=>[name,Buffer.from(data,'base64')]));
  const server=createServer((req,res)=>{
    try{
      const address=server.address();
      if(!address||typeof address==='string'||req.headers.host!==`127.0.0.1:${address.port}`)throw Error('HOST');
      if(req.method!=='GET'&&req.method!=='HEAD')throw Error('METHOD');
      const name=decodeURIComponent(new URL(req.url??'/',`http://${req.headers.host}`).pathname).slice(1)||'index.html',bytes=files.get(name);
      if(!bytes)throw Error('FILE');
      res.writeHead(200,{'content-type':mime[path.extname(name).toLowerCase()]??'application/octet-stream','x-content-type-options':'nosniff','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"});
      res.end(req.method==='HEAD'?undefined:bytes);
    }catch{res.writeHead(404);res.end();}
  });
  server.listen(0,'127.0.0.1',()=>{const address=server.address();if(address&&typeof address!=='string')process.send?.({port:address.port});});
  server.on('error',()=>process.exit(1));
  process.once('disconnect',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
});
// No orphan: IPC disconnect ends the worker even if the host crashes during initialization.
process.once('disconnect',()=>process.exit(0));
