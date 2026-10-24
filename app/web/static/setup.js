/* Server-backed setup. Credentials remain owned by each native CLI. */
(()=>{
  let connecting=false;
  async function runConnection(fn){if(connecting)return;connecting=true;dialog.querySelectorAll('button,input,select').forEach(n=>n.disabled=true);try{await fn();}catch(e){status.textContent='● '+e.message;status.style.color='#ef9292';}finally{connecting=false;dialog.querySelectorAll('button,input,select').forEach(n=>n.disabled=false);}}
  const icon=(kind,label,fn)=>{const b=button('',()=>runConnection(fn));window.actionIcon(b,kind,label);return b;};
  const dialog=el('dialog',undefined,'session-drawer');dialog.id='onboarding-dialog';dialog.setAttribute('aria-label','최초 연결 설정');
  const head=el('div',undefined,'account-dialog-header');head.append(el('h2','작업실 연결'),icon('close','설정 나중에 하기',defer));
  const project=el('select');project.setAttribute('aria-label','연결할 프로젝트');
  const client=el('select');client.setAttribute('aria-label','연결할 에이전트');client.append(new Option('Codex','codex'),new Option('Claude','claude'));
  const tabs=el('div',undefined,'agent-segment');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','에이전트별 연결');
  const observations={},draftPaths={};
  const connectionLabel=row=>!row?'미확인':row.state!=='installed'?(row.state==='missing'?'찾지 못함':'확인 실패'):row.auth==='ready'?'인증 확인':row.auth==='check_required'?'로그인 필요':'인증 미확인';
  function renderTabs(){for(const tab of tabs.children){const selected=tab.dataset.client===client.value;tab.setAttribute('aria-pressed',String(selected));tab.textContent=(tab.dataset.client==='codex'?'Codex':'Claude')+', '+connectionLabel(observations[tab.dataset.client]);}}
  for(const value of ['codex','claude']){const tab=button(value==='codex'?'Codex':'Claude',()=>runConnection(async()=>{draftPaths[client.value]=path.value;client.value=value;path.value=draftPaths[value]??observations[value]?.path??'';renderTabs();await inspect();}));tab.dataset.client=value;tabs.append(tab);}
  const path=el('input',undefined,'form-control');path.id='onboarding-cli-path';path.setAttribute('aria-label','CLI 실행 파일 경로');path.placeholder='자동 검색 또는 실행 파일의 전체 경로';
  const status=el('p');status.setAttribute('role','status');const commands=el('pre');commands.style.whiteSpace='pre-wrap';
  const pathRow=el('div',undefined,'client-path-row');pathRow.append(path,icon('folder','CLI 실행 파일 선택',async()=>{status.textContent='● Windows 파일 선택 창에서 '+(client.value==='codex'?'codex.exe':'claude.exe')+'를 선택하세요. 최대 60초 후 대기를 종료합니다.';status.style.color='#7ab8ff';const chosen=await api('/clients/'+client.value+'/executable-picker','POST');if(!chosen.path){status.textContent='● 파일 선택을 취소했습니다. 기존 연결은 유지됩니다.';return;}path.value=chosen.path;draftPaths[client.value]=chosen.path;await api('/clients/'+client.value,'PUT',{path:chosen.path});await inspect();}));
  const pathLabel=el('label','CLI 실행 파일');pathLabel.htmlFor=path.id;
  const pathField=el('div',undefined,'form-field');pathField.append(pathLabel,pathRow);
  const autoFind=icon('restore','CLI 자동 검색',async()=>{path.value='';draftPaths[client.value]='';await api('/clients/'+client.value,'PUT',{path:''});await inspect();});
  const controls=el('div',undefined,'client-path-row');controls.append(autoFind,icon('plug','경로 저장 및 연결 확인',async()=>{await api('/clients/'+client.value,'PUT',{path:path.value.trim()});await inspect();}));
  const login=button('로그인',()=>window.clientAuth.start(client.value));login.hidden=true;controls.prepend(login);
  const finishRow=el('div',undefined,'client-path-row');finishRow.append(icon('check','선택한 프로젝트에서 시작',finish));
  const projectRow=el('div',undefined,'client-path-row');project.style.flex='1';project.style.minWidth='0';
  projectRow.append(project,icon('folder','프로젝트 등록 열기',async()=>{await api('/onboarding','PUT',selection());dialog.close();$('add-workspace').click();}));
  const projectStep=el('section');projectStep.append(el('h3','프로젝트 선택'),projectRow);
  const newProject=el('input',undefined,'form-control');newProject.placeholder='새 프로젝트 이름';newProject.setAttribute('aria-label','새 프로젝트 이름');
  const createRow=el('div',undefined,'client-path-row');createRow.append(newProject,icon('plus','새 프로젝트 생성',async()=>{
    const name=newProject.value.trim();await api('/projects','POST',{name});project.add(new Option(name,name));project.value=name;newProject.value='';await inspect();
  }));projectStep.append(createRow);
  dialog.append(head,el('p','설치된 Codex와 Claude의 경로와 로그인 상태를 자동으로 확인합니다. 두 에이전트 중 하나만 연결해도 작업을 시작할 수 있습니다.','hint'),
    el('h3','에이전트 연결'),tabs,pathField,el('p','자동 검색은 PATH와 기본 설치 위치를 확인하며, 직접 입력한 경로는 연결 확인 버튼으로 저장합니다.','hint'),status,commands,controls,projectStep,finishRow);
  dialog.append(button('기본 도구 설치와 연결 안내',()=>{dialog.close();window.settingsPage.open('tools');}));
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
    login.hidden=state.connection?.state!=='installed'||state.connection?.auth!=='check_required';
    status.textContent='● '+(ok?'로그인이 확인되어 선택한 프로젝트에서 시작할 수 있습니다.':{project:'에이전트가 연결되었습니다. 프로젝트를 선택하거나 새로 만들면 연결 설정이 완료됩니다.',client:state.connection?.detail||'CLI를 자동으로 찾지 못했습니다. 실행 파일을 직접 선택하거나 자동 검색을 다시 실행할 수 있습니다.',authentication:'CLI 로그인이 필요하거나 인증을 확인할 수 없습니다.'}[state.step]);
    if(state.connection?.path){path.value=state.connection.path;draftPaths[client.value]=path.value;}
    if(state.step==='authentication'){
      const data=await api('/clients/'+client.value+'/login-instructions');
      const quote=value=>"'"+value.replaceAll("'","''")+"'";
      commands.textContent='로그인 버튼으로 CLI 인증 절차를 시작하며, 인증이 끝나면 로그인 상태를 자동으로 확인합니다.\n\n직접 실행하려면 PowerShell에서:\n& '+data.argv.map(quote).join(' ');
    }
  }
  async function finish(){
    await inspect();if(state.status!=='completed')return;
    await projects(project.value);await loadProject();$('client').value=client.value;await window.loadModelChoices();
    await api(base()+'/settings','PUT',{cwd:$('cwd').value,context_paths:selectedPaths(),client:client.value,mode:$('mode').value,model:null});
    actionHint();dialog.close();notice('연결 설정이 완료되어 모델과 채팅을 선택하고 요청을 보낼 수 있습니다.');
  }
  async function open(selectedClient=null){
    if(!dialog.open)dialog.showModal();status.textContent='● 설치 경로와 로그인 상태를 자동으로 확인 중…';
    await runConnection(async()=>{const [saved,list,connections]=await Promise.all([api('/onboarding'),api('/projects'),api('/clients')]);state=saved;
    project.replaceChildren(new Option('프로젝트 선택',''));for(const name of list.projects)project.add(new Option(list.names?.[name]||name,name));
    project.value=saved.project||$('project').value||'';client.value=selectedClient||saved.client||'codex';
    for(const row of connections.clients){observations[row.client]=row;draftPaths[row.client]=row.path||'';}renderTabs();path.value=draftPaths[client.value]||'';status.textContent='선택한 경로는 연결 확인 버튼으로 저장합니다.';commands.textContent='';
    projectStep.hidden=true;await inspect();});
  }
  window.openConnections=open;
  window.refreshConnectionsAuth=rows=>{
    const previous=observations[client.value]?.auth;
    for(const row of rows)observations[row.client]=row;
    renderTabs();const row=observations[client.value];
    if(!dialog.open||!row)return;
    login.hidden=row.state!=='installed'||row.auth!=='check_required';
    login.disabled=['checking','waiting','verifying'].includes(row.login?.state);
    if(row.login?.message){status.textContent=row.login.message;status.style.color=row.auth==='ready'?'#9bd4b9':'#e5bf72';}
    if(row.auth==='ready'&&previous!=='ready'&&!connecting)void runConnection(inspect);
  };
  client.onchange=()=>act(async()=>{const chosen=client.value;projectStep.hidden=true;path.value='';status.textContent='선택한 에이전트의 연결 확인이 필요합니다.';commands.textContent='';const data=await api('/clients');if(client.value===chosen)path.value=data.clients.find(c=>c.client===chosen)?.path||'';});
  window.refreshSetup=()=>{const chosen=!!$('project').value;$('welcome').hidden=chosen;$('messages').hidden=!chosen;$('composer').hidden=!chosen||!filter;$('messages-prev').closest('.pagination').hidden=!chosen||!filter;for(const id of ['delete-project','rename-project','manage-project-name'])$(id).disabled=!chosen;};
  window.setupSettingsSaved=()=>{};window.setupRequestSent=()=>{};
  $('setup-steps').replaceChildren(...[
    ['에이전트 연결','설치된 Codex 또는 Claude CLI의 연결과 로그인 상태를 확인합니다.'],
    ['프로젝트 선택','작업할 폴더를 연결하거나 빈 프로젝트를 만듭니다.'],
    ['룰북과 실행 설정','필요한 규정과 코드 수정 권한을 확인합니다.'],
    ['새 채팅 시작','채팅을 만들고 요청을 입력합니다. Ctrl+Enter로 전송할 수 있습니다.']
  ].map(([title,description])=>{const item=el('li');item.append(el('h3',title),el('p',description));return item;}));
  $('setup-progress').textContent='';$('setup-detail').textContent='에이전트 연결을 마친 경우에는 프로젝트를 선택하고 새 채팅에서 작업을 시작할 수 있습니다.';
  $('setup-next').onclick=()=>act(async()=>{$('setup-guide').closest('dialog').close();await open();});window.actionIcon($('setup-next'),'plug','에이전트 연결 열기');
  $('setup-skip').hidden=true;$('welcome-start').textContent='처음 시작하기';$('welcome-start').onclick=()=>act(open);
  window.refreshSetup();
  startWorkspace();
})();
