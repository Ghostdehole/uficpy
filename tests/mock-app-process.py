#!/usr/bin/env python3
"""Android-free fixture for the reviewed scrcpy wire contract."""
import os,sys,socket,struct,time,threading,re,json
args=dict(a.split('=',1) for a in sys.argv[1:] if '=' in a)
assert args['audio']=='false' and args['send_stream_meta']=='false'
raw=open(os.environ['UFICPY_TEST_H264'],'rb').read()
units=[n for n in re.split(b'\x00\x00\x00?\x01',raw) if n]
annex=lambda ns:b''.join(b'\x00\x00\x00\x01'+n for n in ns)
config=annex([n for n in units if n[0]&31 in (7,8)])
frames=[];frame=[]
for n in units:
 if n[0]&31==9 and frame: frames.append(frame);frame=[]
 frame.append(n)
if frame:frames.append(frame)
srv=socket.socket(socket.AF_UNIX);srv.bind('\0scrcpy_'+args['scid']);srv.listen(2)
v,_=srv.accept();c,_=srv.accept()
def controls():
 while True:
  data=c.recv(4096)
  if not data:return
  print('TEST_CONTROL '+data.hex(),flush=True)
threading.Thread(target=controls,daemon=True).start()
def send(flags,data):v.sendall(struct.pack('>QI',flags,len(data))+data)
send(1<<62,config)
i=0
try:
 while True:
  ns=frames[i%len(frames)];key=any(n[0]&31==5 for n in ns)
  send((1<<61 if key else 0)|(1000000+i*33333),annex([n for n in ns if n[0]&31 not in (7,8)]))
  time.sleep(1/30);i+=1
except (BrokenPipeError,ConnectionResetError):pass
