import {test,expect} from "bun:test";
import {mkdtemp,mkdir,writeFile,readFile,chmod,rm} from "node:fs/promises";
import {openGitHubPullRequestTransport} from "../src/github-pr-transport.js";
import type {PullRequestInput} from "../src/pr-delivery.js";
import type {PushSnapshot} from "../src/remote-delivery.js";
test("GitHub PR API uses exact endpoint and stdin JSON, without shell or field expansion",async()=>{
 const root=await mkdtemp("/tmp/har-gh-pr-"),bin=root+"/bin",oldPath=process.env.PATH;await mkdir(bin);
 const head="a".repeat(40),base="b".repeat(40),input:PullRequestInput={destination:{remote:"origin",url:"https://github.com/fixture/repository.git",ref:"refs/heads/feat/task",baseRef:"refs/heads/main"},title:"Literal $(do-not-run)",body:"@/private/file\n`do-not-run`\n{owner}",draft:true};
 const record={number:7,html_url:"https://github.com/fixture/repository/pull/7",title:input.title,body:input.body,draft:true,state:"open",head:{sha:head,ref:"feat/task",repo:{full_name:"fixture/repository"}},base:{sha:base,ref:"main",repo:{full_name:"fixture/repository"}}};
 try{
  await writeFile(root+"/created.json",JSON.stringify(record));await writeFile(root+"/list.json",JSON.stringify([record,{...record,number:8,head:{...record.head,repo:{full_name:"fixture/other"}}}]));
  await writeFile(bin+"/gh",`#!/bin/sh\nprintf '%s\\n' "$@" > '${root}/args'\ncat > '${root}/payload'\ncase "$*" in *POST*) printf 'HTTP/2.0 201 Created\\r\\nContent-Type: application/json\\r\\n\\r\\n'; cat '${root}/created.json';; *) printf 'HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n'; cat '${root}/list.json';; esac\n`);await chmod(bin+"/gh",0o755);process.env.PATH=bin+":"+oldPath;
  const snapshot={} as PushSnapshot,transport=openGitHubPullRequestTransport({inspectPullRequest:async()=>snapshot});expect(await transport.inspect(input.destination)).toBe(snapshot);const created=await transport.create(input);expect(created.number).toBe(7);const args=await readFile(root+"/args","utf8");expect(args).toContain("--hostname\ngithub.com");expect(args).toContain("--input\n-");expect(args).toContain("repos/fixture/repository/pulls");expect(args).not.toContain(input.title);expect(args).not.toContain(input.body);expect(JSON.parse(await readFile(root+"/payload","utf8"))).toEqual({title:input.title,body:input.body,head:"feat/task",base:"main",draft:true,maintainer_can_modify:false});
  const listed=await transport.list(input.destination);expect(listed).toHaveLength(1);expect(listed[0]!.number).toBe(7);const query=await readFile(root+"/args","utf8");expect(query).toContain("state=all");expect(query).toContain("head=fixture%3Afeat%2Ftask");expect(query).toContain("base=main");
  await writeFile(bin+"/gh", "#!/bin/sh\nprintf 'HTTP/2.0 403 Forbidden\\r\\nContent-Type: application/json\\r\\n\\r\\n{}'\nexit 1\n");await expect(transport.create(input)).rejects.toThrow("PR_API_REJECTED");
  await writeFile(bin+"/gh", "#!/bin/sh\nprintf 'HTTP/2.0 500 Server Error\\r\\nContent-Type: application/json\\r\\n\\r\\n{}'\nexit 1\n");await expect(transport.create(input)).rejects.toThrow("PR_API_UNAVAILABLE");
 }finally{process.env.PATH=oldPath;await rm(root,{recursive:true,force:true});}
});
