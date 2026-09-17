/* Browser-local drafts. No credentials or native conversation copies are stored. */
(()=>{
  const key='codast.chat-state.v1';
  let data={projects:{},lastProject:''},active=null,ready=false;
  try{const saved=JSON.parse(localStorage.getItem(key)||sessionStorage.getItem(key));if(saved?.projects&&typeof saved.projects==='object')data=saved;}catch{}
  const project=name=>{
    if(!Object.hasOwn(data.projects,name)||!data.projects[name]?.chats)data.projects[name]={chats:{},selected:null};
    return data.projects[name];
  };
  const id=task=>JSON.stringify(task);
  function persist(){try{localStorage.setItem(key,JSON.stringify(data));sessionStorage.removeItem(key);}catch{notice('브라우저 저장이 불가능합니다. 이 탭에서만 작성 내용을 유지합니다.',true);}}
  function capture(){return {text:$('text').value,client:$('client').value,model:window.selectedConfiguredModel?.()||null,
    cwd:$('cwd').value,mode:$('mode').value,paths:selectedPaths(),fresh:$('fresh').checked,
    action:$('action').value,offset,scroll:$('messages').scrollTop};}
  function save(){if(!ready||!active)return;project(active.project).chats[id(active.task)]=capture();persist();}
  window.chatState={
    save,
    request(name,task,payload){
      const p=project(name);p.requests??={};const fingerprint=JSON.stringify(payload),prior=p.requests[id(task)];
      if(prior?.fingerprint===fingerprint)return prior.key;
      const key=crypto.randomUUID();p.requests[id(task)]={fingerprint,key};persist();return key;
    },
    acknowledge(name,task,key){const p=project(name);if(p.requests?.[id(task)]?.key===key){delete p.requests[id(task)];persist();}},
    pause(){save();ready=false;},
    lastProject:()=>data.lastProject,
    selected:name=>project(name).selected,
    drafts:name=>Object.keys(project(name).chats).map(JSON.parse).filter(task=>typeof task==='string'&&task),
    async restore(name,task,defaults){
      ready=false;active={project:name,task};
      const current=active,p=project(name),saved=p.chats[id(task)]||{};
      p.selected=task;data.lastProject=name;persist();
      const state={text:'',client:defaults.client,model:defaults.model,cwd:defaults.cwd,mode:defaults.mode,
        paths:defaults.context_paths||[],fresh:false,action:'run',offset:0,scroll:0,...saved};
      if(!['codex','claude'].includes(state.client)){state.client=['codex','claude'].includes(defaults.client)?defaults.client:'codex';state.model=null;}
      p.chats[id(task)]=state;persist();
      $('text').value=state.text;$('task-name').value=task||'';$('client').value=state.client;
      $('cwd').value=state.cwd;$('mode').value=state.mode;$('fresh').checked=state.fresh;$('action').value=state.action;
      offset=state.offset;
      window.loadModelChoices?.(state.model);
      if(active!==current)return null;
      return {state,current};
    },
    finish(result){if(!result||active!==result.current)return;ready=true;$('messages').scrollTop=result.state.scroll;actionHint();save();},
    seed(name,task,state){project(name).chats[id(task)]={...state,text:'',offset:0,scroll:0};persist();},
    checkRename(name,oldTask,newTask){save();const p=project(name);if(oldTask!==newTask&&p.chats[id(oldTask)]?.text&&p.chats[id(newTask)]?.text)throw Error('두 채팅에 작성 중인 내용이 있습니다. 먼저 전송하거나 비운 뒤 합쳐 주세요.');},
    rename(name,oldTask,newTask){save();if(oldTask===newTask)return;const p=project(name);if(!p.chats[id(newTask)]?.text)p.chats[id(newTask)]=p.chats[id(oldTask)];delete p.chats[id(oldTask)];ready=false;persist();},
    sent(name,task,text){const draft=project(name).chats[id(task)];if(draft?.text===text){draft.text='';draft.fresh=false;persist();}}
  };
  document.addEventListener('input',save);document.addEventListener('change',save);
  window.addEventListener('pagehide',save);
})();
