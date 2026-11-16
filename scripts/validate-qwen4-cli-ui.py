"""Live terminal acceptance: real PTY, interactive selection, file tool and incremental output."""
import sys
import os, pathlib, pty, subprocess, select, time, tempfile, json, secrets
approval="--approval" in sys.argv
repo=pathlib.Path(__file__).resolve().parent.parent
root=pathlib.Path(tempfile.mkdtemp(prefix="zhx-qwen4-pty-"))
receipt="CLI_RECEIPT_"+secrets.token_hex(12)
(root/"receipt.txt").write_text(receipt+"\n")
env=dict(os.environ, ZHIVEX_HARNESS_CONFIG_DIR=str(root/"config"), TERM="dumb", NO_COLOR="1")
master,slave=pty.openpty()
proc=subprocess.Popen(["node","--env-file="+str(repo/".env"),str(repo/"dist/cli.js"),"chat","--provider","qwen","--workspace",str(root)],stdin=slave,stdout=slave,stderr=slave,env=env)
os.close(slave)
pending=b""; chunks=[]
def read(marker, timeout=180):
 global pending
 deadline=time.monotonic()+timeout
 while marker.encode() not in pending:
  if time.monotonic()>deadline: raise AssertionError("Timed out waiting for "+marker+" "+pending[-2500:].decode(errors="replace"))
  if select.select([master],[],[],.05)[0]:
   data=os.read(master,65536); pending+=data;chunks.append({"time":time.monotonic(),"text":data.decode(errors="replace")})
 end=pending.index(marker.encode())+len(marker.encode()); result=pending[:end];pending=pending[end:];return result.decode(errors="replace")
def send(text): os.write(master,text.encode())
report={"approval":approval,"model":"qwen4-max","interface":"interactive PTY","ok":False}
try:
 print("waiting initial",flush=True);read("> ");print("initial ready",flush=True);send("/model\n")
 read("Choose number, type a filter, or Enter to cancel:");send("1\n")
 read("Choose number, type a filter, or Enter to cancel:");send("4\n")
 selected=read("> ");print("model selected",flush=True);assert "qwen4-max" in selected
 start=len(chunks)
 send(("Read receipt.txt with read_file then call apply_reviewed_replacement to replace its contents with exactly APPROVED_QWEN4_WRITE followed by one newline. Use the digest from read_file. Request approval. After approval, verify the file by reading it again and report success.\n") if approval else "Read receipt.txt with read_file. Do not modify anything. Print the exact receipt, then write 20 numbered short sentences about why tool output must be verified.\n")
 print("prompt sent",flush=True)
 if approval:
  review=read("Choose number, type a filter, or Enter to cancel:")
  assert "Approve this change" in review
  assert (root/"receipt.txt").read_text()==receipt+"\n"
  report["unchangedBeforeApproval"]=True
  send("2\n")
  output=read("Done ·");read("> ")
  assert (root/"receipt.txt").read_text()=="APPROVED_QWEN4_WRITE\n"
  report.update(writtenAfterApproval=True,review=review,approvalSubmitted=True)
  arrivals=[]
 else:
  output=read("Done ·");read("> ")
  assert receipt in output and "Read receipt.txt" in output
  runchunks=chunks[start:]
  first=next(i for i in range(len(runchunks)) if receipt in "".join(x["text"] for x in runchunks[:i+1]))
  arrivals=[x for x in runchunks[first:] if x["text"].strip()]
  assert len(arrivals)>2, "Expected incremental terminal text, not one final flush"
  assert arrivals[-1]["time"]>arrivals[0]["time"]
  assert (root/"receipt.txt").read_text()==receipt+"\n"
 send("/exit\n")
 deadline=time.monotonic()+15
 while proc.poll() is None and time.monotonic()<deadline:
  if select.select([master],[],[],.1)[0]:
   try: os.read(master,65536)
   except OSError: break
 proc.wait(timeout=2);assert proc.returncode==0
 report.update(ok=True,selectedModel="qwen4-max",reasoning="low",tool="apply_reviewed_replacement" if approval else "read_file",receiptMatched=not approval,outputArrivalsAfterReceipt=len(arrivals),streamDurationSeconds=round(arrivals[-1]["time"]-arrivals[0]["time"],3) if arrivals else None,transcript=output)
 if approval:
  for name in ["receiptMatched","outputArrivalsAfterReceipt","streamDurationSeconds"]: report.pop(name,None)
 print(json.dumps({k:v for k,v in report.items() if k not in ("transcript","review")}))
finally:
 if proc.poll() is None: proc.terminate();proc.wait(timeout=10)
 os.close(master)
 (repo/("docs/reports/evidence/qwen4-max-cli"+("-approval" if approval else "")+"-ui-2026-11-16.json")).write_text(json.dumps(report,indent=2)+"\n")
