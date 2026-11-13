import {createHash,createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {readRegularFileChunksNoFollow,readRegularFileNoFollow} from '../delivery/file-security.js';
import {verifyUpdateManifest,type UpdateManifest} from './update-manifest.js';

/** Offline publisher operation. Private keys never enter app resources, logs, or manifest data. */
export async function signReleaseManifest(input:{artifact:string;privateKeyFile:string;manifest:UpdateManifest;currentVersion:string;stateSchema:number}) {
 const {contents,stat}=await readRegularFileNoFollow(input.privateKeyFile,{label:'Release signing key',maxBytes:16*1024,requireSingleLink:true});
 // The publisher's key file must be private; do not silently repair its permissions.
 if((stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw Error('RELEASE_KEY_PERMISSIONS');
 const key=createPrivateKey(contents);if(key.asymmetricKeyType!=='ed25519')throw Error('RELEASE_KEY_ALGORITHM');
 const hash=createHash('sha256');let size=0;
 for await(const chunk of readRegularFileChunksNoFollow(input.artifact,{label:'Release artifact',requireSingleLink:true})) {
  size+=chunk.length;if(size>1024**3)throw Error('RELEASE_ARTIFACT_TOO_LARGE');hash.update(chunk);
 }
 if(size!==input.manifest.artifact.size||hash.digest('hex')!==input.manifest.artifact.sha256)throw Error('RELEASE_ARTIFACT_MISMATCH');
 const payload=Buffer.from(JSON.stringify(input.manifest));
 const envelope=JSON.stringify({payload:payload.toString('base64url'),signature:sign(null,payload,key).toString('base64url')});
 verifyUpdateManifest(envelope,{publicKey:createPublicKey(key),currentVersion:input.currentVersion,channel:input.manifest.channel,stateSchema:input.stateSchema});
 return envelope+'\n';
}
