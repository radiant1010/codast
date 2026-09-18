/* Server-backed setup. Credentials remain owned by each native CLI. */
(()=>{
  let connecting=false;
  async function runConnection(fn){if(connecting)return;connecting=true;dialog.querySelectorAll('button,input,select').forEach(n=>n.disabled=true);try{await fn();}catch(e){status.textContent='● '+e.message;status.style.color='#ef9292';}finally{connecting=false;dialog.querySelectorAll('button,input,select').forEach(n=>n.disabled=false);}}
  const icon=(kind,label,fn)=>{const b=button('',()=>runConnection(fn));window.actionIcon(b,kind,label);return b;};
  const model=el('select');model.id='execution-model';model.setAttribute('aria-label','실행 모델');
  const modelLabel=el('label','모델');modelLabel.htmlFor=model.id;
  $('client').parentElement.append(modelLabel,model);
  let modelClient='',ticket=0;
  window.loadModelChoices=async(selected=null)=>{
    const client=$('client').value,request=++ticket;
    modelClient=client;model.replaceChildren(new Option('CLI 기본 모델',''));if(selected){model.add(new Option(selected+' (저장됨 · 확인 중)',selected));model.value=selected;}model.disabled=true;
    if(client!=='codex'){model.disabled=false;return;}
    try{
      const data=await api('/clients/codex/status');if(request!==ticket||client!==$('client').value)return;
      model.replaceChildren(new Option('CLI 기본 모델',''));for(const row of data.models||[])if(row.model)model.add(new Option(row.displayName||row.model,row.model));
      if(selected&&!Array.from(model.options).some(o=>o.value===selected))model.add(new Option(selected+' (저장됨 · 사용 가능 여부 미확인)',selected));
      model.value=selected||'';
    }catch(error){if(request===ticket)notice('모델 목록 조회 실패: '+error.message,true);}
    finally{if(request===ticket)model.disabled=false;}
  };
  window.selectedConfiguredModel=()=>modelClient===$('client').value?model.value||null:null;
  window.selectedExecutionModel=()=>{
    const explicit=$('text').value.trim().match(/^\/(codex|claude)(?:\s|$)/)?.[1];
    return (!explicit||explicit===modelClient)&&modelClient===$('client').value?model.value||null:null;
  };
  $('client').addEventListener('change',()=>act(()=>window.loadModelChoices()));
  model.addEventListener('change',()=>notice('모델을 선택했습니다. 실행 설정 저장으로 다음 접속에도 유지할 수 있습니다.'));
  const dialog=el('dialog',undefined,'session-drawer');dialog.id='onboarding-dialog';dialog.setAttribute('aria-label','최초 연결 설정');
  const head=el('div',undefined,'account-dialog-header');head.append(el('h2','작업실 연결'),icon('close','설정 나중에 하기',defer));
  const project=el('select');project.setAttribute('aria-label','연결할 프로젝트');
  const client=el('select');client.setAttribute('aria-label','연결할 에이전트');client.append(new Option('Codex','codex'),new Option('Claude','claude'));
  const tabs=el('div',undefined,'agent-segment');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','에이전트별 연결');
  const observations={},draftPaths={};
  const connectionLabel=row=>!row?'미확인':row.state!=='installed'?(row.state==='missing'?'찾지 못함':'확인 실패'):row.auth==='ready'?'인증 확인':row.auth==='check_required'?'로그인 필요':'인증 미확인';
  function renderTabs(){for(const tab of tabs.children){const selected=tab.dataset.client===client.value;tab.setAttribute('aria-pressed',String(selected));tab.textContent=(tab.dataset.client==='codex'?'Codex':'Claude')+' · '+connectionLabel(observations[tab.dataset.client]);}}
  for(const value of ['codex','claude']){const tab=button(value==='codex'?'Codex':'Claude',()=>runConnection(async()=>{draftPaths[client.value]=path.value;client.value=value;path.value=draftPaths[value]??observations[value]?.path??'';renderTabs();await inspect();}));tab.dataset.client=value;tabs.append(tab);}
  const path=el('input');path.id='onboarding-cli-path';path.setAttribute('aria-label','CLI 실행 파일 경로');path.placeholder='자동으로 찾습니다 · 찾지 못하면 실행 파일 선택';
  const status=el('p');status.setAttribute('role','status');const commands=el('pre');commands.style.whiteSpace='pre-wrap';
  const pathRow=el('div',undefined,'client-path-row');pathRow.append(path,icon('folder','CLI 실행 파일 선택',async()=>{status.textContent='● Windows 파일 선택 창에서 '+(client.value==='codex'?'codex.exe':'claude.exe')+'를 선택하세요. 최대 60초 후 대기를 종료합니다.';status.style.color='#7ab8ff';const chosen=await api('/clients/'+client.value+'/executable-picker','POST');if(!chosen.path){status.textContent='● 파일 선택을 취소했습니다. 기존 연결은 유지됩니다.';return;}path.value=chosen.path;draftPaths[client.value]=chosen.path;await api('/clients/'+client.value,'PUT',{path:chosen.path});await inspect();}));
  const pathLabel=el('label','CLI 실행 파일');pathLabel.htmlFor=path.id;
  const pathField=el('div',undefined,'form-field');pathField.append(pathLabel,pathRow);
  const autoFind=icon('restore','CLI 자동 검색',async()=>{path.value='';draftPaths[client.value]='';await api('/clients/'+client.value,'PUT',{path:''});await inspect();});
  const controls=el('div',undefined,'client-path-row');controls.append(autoFind,icon('plug','경로 저장 및 연결 확인',async()=>{await api('/clients/'+client.value,'PUT',{path:path.value.trim()});await inspect();}));
  const finishRow=el('div',undefined,'client-path-row');finishRow.append(icon('check','선택한 프로젝트에서 시작',finish));
  const projectRow=el('div',undefined,'client-path-row');project.style.flex='1';project.style.minWidth='0';
  projectRow.append(project,icon('folder','프로젝트 등록 열기',async()=>{await api('/onboarding','PUT',selection());dialog.close();$('add-workspace').click();}));
  const projectStep=el('section');projectStep.append(el('h3','STEP 2 · 프로젝트 생성 또는 선택'),projectRow);
  const newProject=el('input');newProject.placeholder='새 프로젝트 이름';newProject.setAttribute('aria-label','새 프로젝트 이름');
  const createRow=el('div',undefined,'client-path-row');createRow.append(newProject,icon('plus','새 프로젝트 생성',async()=>{
    const name=newProject.value.trim();await api('/projects','POST',{name});project.add(new Option(name,name));project.value=name;newProject.value='';await inspect();
  }));projectStep.append(createRow);
  dialog.append(head,el('p','Codex와 Claude를 각각 연결할 수 있습니다. 설치 경로와 기존 로그인을 자동으로 확인하며, 하나만 연결해도 시작할 수 있습니다.','hint'),
    el('h3','STEP 1 · 에이전트 로그인 및 연결'),tabs,pathField,el('p','자동 검색은 PATH와 기본 설치 위치를 확인합니다. 직접 입력했다면 연결 아이콘으로 저장하세요.','hint'),status,commands,controls,projectStep,finishRow);
  renderTabs();
  projectStep.hidden=true;
  document.body.append(dialog);
  let state=null;
  const selection=()=>({project:project.value||null,client:client.value});
  async function defer(){await api('/onboarding','PUT',{...selection(),deferred:true});dialog.close();}
  dialog.addEventListener('cancel',event=>{event.preventDefault();if(!connecting)runConnection(defer);});
  async function inspect(){
    status.textContent='● 연결 확인 중';status.style.color='#7ab8ff';commands.textContent='';
    await api('/onboarding','PUT',selection());
    state=await api('/onboarding/check','POST');
    observations[client.value]=state.connection;renderTabs();const ok=state.status==='completed';projectStep.hidden=state.connection?.auth!=='ready';status.style.color=ok?'#9bd4b9':'#e5bf72';
    status.textContent='● '+(ok?'인증 확인 완료 · 시작할 수 있습니다.':{project:'에이전트 연결 완료 · STEP 2에서 프로젝트를 생성하거나 선택하세요.',client:state.connection?.detail||'CLI를 자동으로 찾지 못했습니다. 파일 선택 또는 자동 검색을 이용하세요.',authentication:'CLI 로그인이 필요하거나 인증을 확인할 수 없습니다.'}[state.step]);
    if(state.connection?.path){path.value=state.connection.path;draftPaths[client.value]=path.value;}
    if(state.step==='authentication'){
      const data=await api('/clients/'+client.value+'/login-instructions');
      const quote=value=>"'"+value.replaceAll("'","''")+"'";
      commands.textContent='PowerShell에서 실행:\n& '+data.argv.map(quote).join(' ')+'\n\n브라우저에서 인증을 마친 뒤 연결 확인 아이콘을 다시 누르세요.';
    }
  }
  async function finish(){
    await inspect();if(state.status!=='completed')return;
    await projects(project.value);await loadProject();$('client').value=client.value;await window.loadModelChoices();
    await api(base()+'/settings','PUT',{cwd:$('cwd').value,context_paths:selectedPaths(),client:client.value,mode:$('mode').value,model:null});
    actionHint();dialog.close();notice('연결 설정 완료. 모델과 채팅을 선택해 첫 요청을 보내세요.');
  }
  async function open(){
    if(!dialog.open)dialog.showModal();status.textContent='● 설치 경로와 로그인 상태를 자동으로 확인 중…';
    await runConnection(async()=>{const [saved,list,connections]=await Promise.all([api('/onboarding'),api('/projects'),api('/clients')]);state=saved;
    project.replaceChildren(new Option('프로젝트 선택',''));for(const name of list.projects)project.add(new Option(name,name));
    project.value=saved.project||$('project').value||'';client.value=saved.client||'codex';
    for(const row of connections.clients){observations[row.client]=row;draftPaths[row.client]=row.path||'';}renderTabs();path.value=draftPaths[client.value]||'';status.textContent='선택 후 연결 확인 아이콘을 누르세요.';commands.textContent='';
    projectStep.hidden=true;await inspect();});
  }
  window.openConnections=open;
  client.onchange=()=>act(async()=>{const chosen=client.value;projectStep.hidden=true;path.value='';status.textContent='선택한 에이전트의 연결을 다시 확인하세요.';commands.textContent='';const data=await api('/clients');if(client.value===chosen)path.value=data.clients.find(c=>c.client===chosen)?.path||'';});
  window.refreshSetup=()=>{const chosen=!!$('project').value;$('welcome').hidden=chosen;$('messages').hidden=!chosen;$('composer').hidden=!chosen||!filter;$('messages-prev').closest('.pagination').hidden=!chosen||!filter;$('delete-project').disabled=!chosen;};
  window.setupSettingsSaved=()=>{};window.setupRequestSent=()=>{};
  $('setup-steps').replaceChildren(...[
    ['에이전트 연결','설치된 Codex 또는 Claude CLI의 연결과 로그인 상태를 확인합니다.'],
    ['프로젝트 선택','작업할 폴더를 연결하거나 빈 프로젝트를 만듭니다.'],
    ['룰북과 실행 설정','필요한 규정과 코드 수정 권한을 확인합니다.'],
    ['새 채팅 시작','채팅을 만들고 요청을 입력합니다. Ctrl+Enter로 전송할 수 있습니다.']
  ].map(([title,description])=>{const item=el('li');item.append(el('h3',title),el('p',description));return item;}));
  $('setup-progress').textContent='';$('setup-detail').textContent='이미 연결했다면 프로젝트를 선택하고 새 채팅을 시작하세요.';
  $('setup-next').onclick=()=>act(async()=>{$('setup-guide').closest('dialog').close();await open();});window.actionIcon($('setup-next'),'plug','에이전트 연결 열기');
  $('setup-skip').hidden=true;$('welcome-start').textContent='처음 시작하기';$('welcome-start').onclick=()=>act(open);
  window.refreshSetup();
  startWorkspace();
})();
