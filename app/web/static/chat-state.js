/* Browser-local drafts. No credentials or native conversation copies are stored. */
(()=>{
  const key='codast.chat-state.v1';
  let data={projects:{},lastProject:''},active=null,ready=false;
  try{const saved=JSON.parse(localStorage.getItem(key)||sessionStorage.getItem(key));if(saved?.projects&&typeof saved.projects==='object')data=saved;}catch{}
  const project=name=>{
    if(!Object.hasOwn(data.projects,name)||!data.projects[name]?.chats)data.projects[name]={chats:{},selected:null};
    return data.projects[name];
  };
  const chatId=(name,task)=>Object.entries(project(name).identities||{}).find(([,title])=>title===task)?.[0];
  const id=(name,task)=>chatId(name,task)?'@'+chatId(name,task):JSON.stringify(task);
  const fingerprint=payload=>JSON.stringify(Object.fromEntries(Object.entries(payload.chat_id?{...payload,task:''}:payload).sort(([a],[b])=>a.localeCompare(b))));
  function persist(){try{localStorage.setItem(key,JSON.stringify(data));sessionStorage.removeItem(key);}catch{notice('브라우저 저장이 불가능합니다. 이 탭에서만 작성 내용을 유지합니다.',true);}}
  function capture(){return {text:$('text').value,client:$('client').value,model:window.selectedConfiguredModel?.()||null,
    cwd:$('cwd').value,mode:$('mode').value,paths:selectedPaths(),fresh:$('fresh').checked,
    action:$('action').value,offset,scroll:$('messages').scrollTop};}
  function save(){if(!ready||!active)return;project(active.project).chats[id(active.project,active.task)]=capture();persist();}
  window.chatState={
    save,
    identity:chatId,
    bind(name,rows){
      save();const p=project(name);p.identities??={};
      for(const row of rows){
        if(!row.id)continue;
        const old=p.identities[row.id]||row.task,legacy=JSON.stringify(old),stable='@'+row.id;
        for(const collection of [p.chats,p.requests])if(collection&&Object.hasOwn(collection,legacy)){
          if(!Object.hasOwn(collection,stable))collection[stable]=collection[legacy];delete collection[legacy];
        }
        const pending=p.requests?.[stable];
        if(pending){try{const payload=JSON.parse(pending.fingerprint);pending.fingerprint=fingerprint({...payload,chat_id:row.id});}catch{}}
        if(p.selectedId===row.id||(!p.selectedId&&p.selected===old)){p.selected=row.task;p.selectedId=row.id;}
        if(active?.project===name&&active.task===old)active.task=row.task;
        p.identities[row.id]=row.task;
      }
      persist();
    },
    request(name,task,payload){
      const p=project(name);p.requests??={};const signature=fingerprint(payload),prior=p.requests[id(name,task)];
      if(prior){try{if(fingerprint(JSON.parse(prior.fingerprint))===signature)return prior.key;}catch{}}
      const key=crypto.randomUUID();p.requests[id(name,task)]={fingerprint:signature,key};persist();return key;
    },
    acknowledge(name,task,key){const p=project(name);if(p.requests?.[id(name,task)]?.key===key){delete p.requests[id(name,task)];persist();}},
    pause(){save();ready=false;},
    lastProject:()=>data.lastProject,
    selected:name=>project(name).selected,
    drafts:name=>Object.keys(project(name).chats).map(key=>key.startsWith('@')?project(name).identities?.[key.slice(1)]:JSON.parse(key)).filter(task=>typeof task==='string'&&task),
    async restore(name,task,defaults){
      ready=false;active={project:name,task};
      const current=active,p=project(name),saved=p.chats[id(name,task)]||{};
      p.selected=task;p.selectedId=chatId(name,task)||null;data.lastProject=name;persist();
      const state={text:'',client:defaults.client,model:defaults.model,cwd:defaults.cwd,mode:defaults.mode,
        paths:defaults.context_paths||[],fresh:false,action:'run',offset:0,scroll:0,...saved};
      if(!['codex','claude'].includes(state.client)){state.client=['codex','claude'].includes(defaults.client)?defaults.client:'codex';state.model=null;}
      p.chats[id(name,task)]=state;persist();
      $('text').value=state.text;$('task-name').value=task||'';$('client').value=state.client;
      $('cwd').value=state.cwd;$('mode').value=state.mode;$('fresh').checked=state.fresh;$('action').value=state.action;
      offset=state.offset;
      window.loadModelChoices?.(state.model);
      if(active!==current)return null;
      return {state,current};
    },
    finish(result){if(!result||active!==result.current)return;ready=true;$('messages').scrollTop=result.state.scroll;actionHint();save();},
    seed(name,task,state){project(name).chats[id(name,task)]={...state,text:'',offset:0,scroll:0};persist();},
    checkRename(name,oldTask,newTask){save();const p=project(name);if(oldTask!==newTask&&Object.hasOwn(p.chats,id(name,newTask)))throw Error('같은 이름의 채팅 초안이 있습니다. 다른 이름을 입력하세요.');},
    rename(name,oldTask,newTask){
      save();if(oldTask===newTask)return;const p=project(name),stable=chatId(name,oldTask);
      if(stable)p.identities[stable]=newTask;
      else for(const collection of [p.chats,p.requests])if(collection&&Object.hasOwn(collection,id(name,oldTask))){collection[id(name,newTask)]=collection[id(name,oldTask)];delete collection[id(name,oldTask)];}
      if(p.selected===oldTask)p.selected=newTask;if(active?.project===name&&active.task===oldTask)active.task=newTask;
      ready=false;persist();
    },
    sent(name,task,text){const draft=project(name).chats[id(name,task)];if(draft?.text===text){draft.text='';draft.fresh=false;persist();}}
  };
  document.addEventListener('input',save);document.addEventListener('change',save);
  window.addEventListener('pagehide',save);
})();
