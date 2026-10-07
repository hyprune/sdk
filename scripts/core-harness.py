#!/usr/bin/env python3
"""Test-only private-plugin stand-in. Does not start or alter Hyprland."""
import json, os, select, signal, socket, subprocess, sys, time
config=json.load(sys.stdin)
parent,child=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET)
child.setblocking(False)
r,w=os.pipe()
os.write(w,json.dumps(config['grants']).encode());os.close(w)
env={**os.environ,'XDG_RUNTIME_DIR':config['runtime'],'HYPRLAND_INSTANCE_SIGNATURE':'sdk-conformance','HYPRUNE_BRIDGE_FD':str(child.fileno()),'HYPRUNE_LAUNCH_FD':str(r)}
process=subprocess.Popen([config['binary']],env=env,pass_fds=(child.fileno(),r),stdout=sys.stderr)
child.close();os.close(r)
epoch='sdk-conformance-epoch'
def send(value):
 value['epoch']=epoch;parent.send(json.dumps(value).encode())
parent.send(json.dumps({'type':'hello','version':1,'epoch':epoch}).encode())
send({'type':'state','state':config['state']})
send({'type':'methods','methods':{'runtime.exit':'runtime.control'}})
path=os.path.join(config['runtime'],'hyprune','sdk-conformance','control.sock')
try:
 deadline=time.monotonic()+5
 while not os.path.exists(path):
  if process.poll() is not None: raise RuntimeError('hypruned exited at startup')
  if time.monotonic()>deadline: raise RuntimeError('hypruned socket startup timed out')
  time.sleep(.01)
 print(path,flush=True)
 def stop(*_): raise KeyboardInterrupt()
 signal.signal(signal.SIGTERM,stop)
 while process.poll() is None:
  ready,_,_=select.select([parent],[],[],.1)
  if not ready: continue
  data=parent.recv(196609)
  if not data: break
  message=json.loads(data)
  if message['type']=='command':
   state=config['state'];state['runtime']['active']=False
   send({'type':'state','state':state})
   send({'type':'reply','id':message['id'],'result':{'revision':2}})
except KeyboardInterrupt:
 pass
finally:
 process.terminate()
 try: process.wait(timeout=3)
 except subprocess.TimeoutExpired: process.kill();process.wait()
 parent.close()
