// Test-only plugin stand-in linked to the independently built core runtime.
// Uses real Control/world/collision code and real hypruned; no compositor or GL.
#include "control/Control.hpp"
#include <csignal>
#include <fcntl.h>
#include <filesystem>
#include <iostream>
#include <poll.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
using namespace hyprune;
using Json=ipc::Json;
using Clock=std::chrono::steady_clock;
volatile sig_atomic_t running=1;
void stop(int){running=0;}
int main(int argc,char**argv) {
 if(argc!=4)return 2;
 signal(SIGTERM,stop);signal(SIGINT,stop);signal(SIGPIPE,SIG_IGN);
 pid_t child=-1;
 try {
  Json config;std::cin>>config;
  auto current=world::load(argv[3]);sim::Camera camera;control::Control control;control.outputId="output-main";control.reset(current.get());
  const std::string runtime=argv[2],epoch="sdk-real-control";bool active=true;uint64_t revision=0;Json last;
  int bridge[2],grants[2];if(socketpair(AF_UNIX,SOCK_SEQPACKET,0,bridge) || pipe(grants))throw std::runtime_error("private IPC creation failed");
  auto grantBytes=config.at("grants").dump();if(write(grants[1],grantBytes.data(),grantBytes.size())!=(ssize_t)grantBytes.size())throw std::runtime_error("grant write failed");close(grants[1]);
  child=fork();if(child<0)throw std::runtime_error("fork failed");
  if(!child){
   close(bridge[0]);fcntl(bridge[1],F_SETFL,O_NONBLOCK);
   setenv("XDG_RUNTIME_DIR",runtime.c_str(),1);setenv("HYPRLAND_INSTANCE_SIGNATURE","sdk-conformance",1);
   const auto fd=std::to_string(bridge[1]),grant=std::to_string(grants[0]);setenv("HYPRUNE_BRIDGE_FD",fd.c_str(),1);setenv("HYPRUNE_LAUNCH_FD",grant.c_str(),1);
   execl(argv[1],argv[1],nullptr);_exit(127);
  }
  close(bridge[1]);close(grants[0]);
  auto send=[&](Json message){message["epoch"]=epoch;const auto bytes=message.dump();if(::send(bridge[0],bytes.data(),bytes.size(),MSG_NOSIGNAL)!=(ssize_t)bytes.size())throw std::runtime_error("private send failed");};
  auto publish=[&]{
   const auto pose=control.execute("camera.get",Json::object(),"host","org.example.host",current.get(),camera,Json::array({"output-main"}));
   Json state={{"runtime",{{"active",active},{"outputs",{"output-main"}}}},
    {"world",{{"id",current->id},{"spawnId",current->defaultSpawn}}},{"surfaces",Json::array()},
    {"movement",{{"modeId","com.hyprune.fly"},{"position",pose["position"]},{"orientation",pose["orientation"]}}},
    {"shell",{{"leases",control.leases}}},{"location",control.location},{"integrations",{{"sources",control.sources}}}};
   if(state!=last){++revision;last=state;send({{"type","state"},{"state",state}});}
   for(const auto&[event,params]:control.events)send({{"type","event"},{"event",event},{"params",params}});
   control.events.clear();
  };
  send({{"type","hello"},{"version",1}});publish();auto methods=control::Control::methods();methods["runtime.exit"]="runtime.control";methods["world.load"]="world.control";send({{"type","methods"},{"methods",methods}});
  const auto path=std::filesystem::path(runtime)/"hyprune/sdk-conformance/control.sock";
  for(int i=0;i<500 && !std::filesystem::exists(path);i++)std::this_thread::sleep_for(std::chrono::milliseconds(10));
  if(!std::filesystem::exists(path))throw std::runtime_error("daemon startup timed out");
  std::this_thread::sleep_for(std::chrono::milliseconds(30));std::cout<<path.string()<<std::endl;
  Json pending;bool cancelled=false;Clock::time_point ready;auto previous=Clock::now();
  auto reply=[&](const Json&id,Json result){send({{"type","reply"},{"id",id},{"result",result}});};
  auto error=[&](const Json&id,int code,const std::string&text){send({{"type","reply"},{"id",id},{"error",{{"code",code},{"message",text}}}});};
  while(running){
   pollfd descriptor{bridge[0],POLLIN,0};poll(&descriptor,1,10);
   if(descriptor.revents&POLLIN){
    char bytes[196609];auto count=recv(bridge[0],bytes,sizeof bytes,0);if(count<=0)break;auto message=Json::parse(bytes,bytes+count);
    if(message.at("type")=="cancel")cancelled=true;
    if(message.at("type")=="command"){
     const auto id=message.at("id"),method=message.at("method");auto params=message.at("params");const auto actor=params.value("_actor","host"),client=params.value("_client","org.example.host");params.erase("_actor");params.erase("_client");params.erase("_pid");params.erase("_protocol");
     try {
      if(method=="_connection.closed"){control.disconnect(actor);publish();reply(id,Json::object());}
      else if(method=="world.load"){control.beginLoad(params,"output-main");publish();pending=message;cancelled=false;ready=Clock::now()+std::chrono::milliseconds(100);}
      else if(method=="runtime.exit"){control.stop();active=false;publish();reply(id,{{"revision",revision}});}
      else {
       if((method=="travel.start" || method=="autodrive.start") && !active)throw ipc::Error(-32005,"world mode inactive");
       auto result=control.execute(method,params,actor,client,current.get(),camera,Json::array({"output-main"}));publish();if(method!="camera.get")result["revision"]=revision;reply(id,result);
      }
     }catch(const ipc::Error&e){error(id,e.code,e.what());}catch(const std::exception&e){error(id,-32603,e.what());}
    }
   }
   if(!pending.is_null() && Clock::now()>=ready){
    const auto id=pending.at("id");auto params=pending.at("params");
    try {
     if(cancelled)throw ipc::Error(-32004,"load cancelled");
     // Use the real loader even for missing packages; preserve Plugin.cpp's
     // generic load-failure classification rather than inventing a test reply.
     auto package=params.at("worldId")==current->id?std::filesystem::path(argv[3]):std::filesystem::path(argv[3]).parent_path()/params.at("worldId").get<std::string>();
     auto replacement=world::load(package);const auto&spawn=replacement->spawn(params.value("spawnId",""));auto transition=control.location["transition"];
     replacement->defaultSpawn=spawn.id;current=replacement;control.reset(current.get());control.location["transition"]=transition;control.endLoad(true);camera.position=spawn.position+Vec3{0,1.7f,0};camera.yaw=spawn.yaw;camera.pitch=spawn.pitch;active=true;publish();reply(id,{{"revision",revision}});
    }catch(const ipc::Error&e){control.endLoad(false,cancelled);publish();error(id,e.code,e.what());}catch(const std::exception&e){control.endLoad(false);publish();error(id,-32602,e.what());}
    pending=nullptr;
   }
   const auto now=Clock::now();control.tick(std::chrono::duration<float>(now-previous).count(),camera,current.get());previous=now;publish();
  }
  close(bridge[0]);kill(child,SIGTERM);waitpid(child,nullptr,0);return 0;
 }catch(const std::exception&e){std::cerr<<e.what()<<'\n';if(child>0){kill(child,SIGTERM);waitpid(child,nullptr,0);}return 1;}
}
