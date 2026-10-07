#!/usr/bin/env python3
"""Compile a plugin stand-in against built core Control; launch real hypruned.
No Hyprland, Wayland, GL, or owner's session is accessed.
"""
import json, pathlib, signal, subprocess, sys
config=json.load(sys.stdin)
binary=pathlib.Path(config['binary']).resolve()
core=pathlib.Path(config.get('coreDirectory',binary.parent.parent))
runtime=pathlib.Path(config['runtime'])
host=runtime/'core-host'
subprocess.run(['c++','-std=c++23','-O1','-I',str(core/'src'),'-I',str(core/'third_party'),str(pathlib.Path(__file__).with_name('core-host.cpp')),str(binary.parent/'libhyprune_runtime.a'),'-pthread','-o',str(host)],check=True,stdout=sys.stderr)
process=subprocess.Popen([str(host),str(binary),str(runtime),str(core/'tests/fixtures/atrium')],stdin=subprocess.PIPE)
process.stdin.write(json.dumps({'grants':config['grants']}).encode());process.stdin.close()
def stop(*_):
 process.terminate()
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
try:
 status=process.wait()
finally:
 if process.poll() is None:
  process.terminate()
  try:process.wait(timeout=3)
  except subprocess.TimeoutExpired:process.kill();process.wait()
sys.exit(status)
