"""Capture the real CLI in a PTY and render its terminal cells to PNG.
Offline provider fixture; requires pyte + Pillow. No model calls or credentials.
Usage: python3 scripts/capture-console-ux.py /absolute/output.png
"""
import fcntl, json, os, pathlib, pty, select, shutil, struct, subprocess, sys, tempfile, termios, time
import pyte
from PIL import Image, ImageDraw, ImageFont
repo = pathlib.Path(__file__).resolve().parent.parent
output = pathlib.Path(sys.argv[1]).resolve()
root = tempfile.mkdtemp(prefix='harness-ux-',dir='/tmp')
master, slave = pty.openpty()
cols, rows = 106, 54
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
env = {k:v for k,v in os.environ.items() if k in ('PATH','HOME','TMPDIR','LANG')}
env.update(NODE_NO_WARNINGS='1',TERM='xterm-256color', FORCE_COLOR='1', DASHSCOPE_API_KEY='sk-sp-fixture-only', QWEN_BASE_URL='https://token-plan.maas.qwencloudapi.com/compatible-mode/v1')
pathlib.Path(root,'README.md').write_text('Fixture project: Qwen Token Plan, interactive CLI.\n')
proc = subprocess.Popen(['node','--import',str(repo/'tests/fixtures/console-ux-fetch.mjs'),str(repo/'dist/cli.js'),'chat','--provider','qwen','--model','qwen3.8-max','--workspace',root],stdin=slave,stdout=slave,stderr=slave,env=env)
os.close(slave)
transcript = b''
def read_until(marker):
 global transcript
 recent=b''; deadline=time.monotonic()+30
 while time.monotonic()<deadline:
  if select.select([master],[],[],0.1)[0]:
   chunk=os.read(master,65536);recent+=chunk;transcript+=chunk
   if marker.encode() in recent:return
 raise RuntimeError('Missing visual fixture marker: '+marker+'\n'+recent.decode(errors='replace')[-1500:])
try:
 read_until('> ')
 os.write(master,'Como estamos de soporte en QwenCloud?\n'.encode())
 read_until('Puedes consultar el detalle')
 read_until('> ')
 screen=pyte.Screen(cols,rows);pyte.Stream(screen).feed(transcript.decode('utf8',errors='replace'))
 visible='\n'.join(screen.display)
 assert 'tools ·' not in visible and 'Reading files' not in visible and 'Exploring the project' not in visible
 assert '0.15.2' in visible and 'Token Plan' in visible
 font_path='/System/Library/Fonts/Menlo.ttc'
 if not pathlib.Path(font_path).exists():font_path='/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
 font=ImageFont.truetype(font_path,18);bold=ImageFont.truetype(font_path,18,index=1) if sys.platform=='darwin' else font
 cw,ch=11,25;pad=28;top=64
 last=min(rows, max(i for i,line in enumerate(screen.display) if line.strip())+2)
 image=Image.new('RGB',(cols*cw+pad*2,last*ch+top+pad),'#10151e');draw=ImageDraw.Draw(image)
 draw.rounded_rectangle((0,0,image.width,43),radius=10,fill='#1d2633')
 draw.text((pad,11),'Zhivex Harness  /  PTY capture  /  offline provider fixture',font=font,fill='#aebdd0')
 colors={'default':'#e1e8f2','black':'#10151e','red':'#f28b82','green':'#9ad6b1','brown':'#e3c688','blue':'#8ab4f8','magenta':'#c3a6ed','cyan':'#8fd3e8','white':'#e1e8f2','brightblack':'#94a3b8'}
 for y in range(last):
  for x in range(cols):
   cell=screen.buffer[y][x]
   color=colors.get(cell.fg,'#'+cell.fg if len(cell.fg)==6 else '#e1e8f2')
   px,py=pad+x*cw,top+y*ch
   if len(cell.data)==1 and 0x2800<=ord(cell.data)<=0x28ff:
    bits=ord(cell.data)-0x2800
    for bit,(dx,dy) in enumerate([(0,0),(0,1),(0,2),(1,0),(1,1),(1,2),(0,3),(1,3)]):
     if bits & (1<<bit):draw.ellipse((px+dx*5,py+dy*5+3,px+dx*5+2,py+dy*5+5),fill=color)
   else:draw.text((px,py),cell.data,font=bold if cell.bold else font,fill=color)
 output.parent.mkdir(parents=True,exist_ok=True);image.save(output)
 output.with_suffix('.ansi').write_bytes(transcript)
 print(json.dumps({'capture':str(output),'columns':cols,'rows':last,'provider':'offline fixture','source':'real CLI PTY terminal cells'}))
 os.write(master,b'/exit\n')
 deadline=time.monotonic()+10
 while proc.poll() is None and time.monotonic()<deadline:
  if select.select([master],[],[],0.1)[0]:
   try:os.read(master,65536)
   except OSError:break
 proc.wait(timeout=1)
 assert proc.returncode==0
finally:
 if proc.poll() is None:proc.kill();proc.wait()
 os.close(master);shutil.rmtree(root)
