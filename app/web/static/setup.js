/* Server-backed setup. Credentials remain owned by each native CLI. */
(()=>{
  const icon=(kind,label,fn)=>{const b=button('',async()=>{b.disabled=true;try{await fn();}catch(e){status.textContent='● '+e.message;status.style.color='#ef9292';}finally{b.disabled=false;}});window.actionIcon(b,kind,label);return b;};
  const model=el('select');model.id='execution-model';model.setAttribute('aria-label','실행 모델');
  const modelLabel=el('label','모델');modelLabel.htmlFor=model.id;
  $('client').parentElement.append(modelLabel,model);
  let modelClient='',ticket=0;
  window.loadModelChoices=async(selected=null)=>{
    const client=$('client').value,request=++ticket;
    modelClient=client;model.replaceChildren(new Option('CLI 기본 모델',''));model.disabled=true;
    if(client!=='codex'){model.disabled=false;return;}
    try{
      const data=await api('/clients/codex/status');if(request!==ticket||client!==$('client').value)return;
      for(const row of data.models||[])if(row.model)model.add(new Option(row.displayName||row.model,row.model));
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
  const path=el('input');path.setAttribute('aria-label','CLI 실행 파일 경로');path.placeholder='실행 파일 경로 · 비우면 PATH에서 확인';
  const status=el('p');status.setAttribute('role','status');const commands=el('pre');commands.style.whiteSpace='pre-wrap';
  const pathRow=el('div',undefined,'client-path-row');pathRow.append(path,icon('folder','CLI 경로 등록',async()=>{await api('/clients/'+client.value,'PUT',{path:path.value});await inspect();}));
  const controls=el('div',undefined,'client-path-row');controls.append(icon('plug','연결 확인',inspect),icon('check','선택한 프로젝트에서 시작',finish));
  const projectRow=el('div',undefined,'client-path-row');project.style.flex='1';project.style.minWidth='0';
  projectRow.append(project,icon('folder','프로젝트 등록 열기',async()=>{await api('/onboarding','PUT',selection());dialog.close();$('add-workspace').click();}));
  const projectStep=el('section');projectStep.append(el('h3','STEP 2 · 프로젝트 생성 또는 선택'),projectRow);
  const newProject=el('input');newProject.placeholder='새 프로젝트 이름';newProject.setAttribute('aria-label','새 프로젝트 이름');
  const createRow=el('div',undefined,'client-path-row');createRow.append(newProject,icon('plus','새 프로젝트 생성',async()=>{
    const name=newProject.value.trim();await api('/projects','POST',{name});project.add(new Option(name,name));project.value=name;newProject.value='';await inspect();
  }));projectStep.append(createRow);
  dialog.append(head,el('p','Codex 또는 Claude 중 하나만 연결하면 됩니다. 기존 CLI 인증을 먼저 확인합니다.','hint'),
    el('h3','STEP 1 · 에이전트 로그인 및 연결'),client,el('p','CLI 경로'),pathRow,status,commands,projectStep,controls);
  projectStep.hidden=true;
  document.body.append(dialog);
  let state=null;
  const selection=()=>({project:project.value||null,client:client.value});
  async function defer(){await api('/onboarding','PUT',{...selection(),deferred:true});dialog.close();}
  dialog.addEventListener('cancel',event=>{event.preventDefault();act(defer);});
  async function inspect(){
    status.textContent='● 연결 확인 중';status.style.color='#7ab8ff';commands.textContent='';
    await api('/onboarding','PUT',selection());
    state=await api('/onboarding/check','POST');
    const ok=state.status==='completed';projectStep.hidden=state.connection?.auth!=='ready';status.style.color=ok?'#9bd4b9':'#e5bf72';
    status.textContent='● '+(ok?'인증 확인 완료 · 시작할 수 있습니다.':{project:'에이전트 연결 완료 · STEP 2에서 프로젝트를 생성하거나 선택하세요.',client:'CLI 경로를 등록하고 설치 상태를 확인하세요.',authentication:'CLI 로그인이 필요하거나 인증을 확인할 수 없습니다.'}[state.step]);
    if(state.connection?.path)path.value=state.connection.path;
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
    const [saved,list,connections]=await Promise.all([api('/onboarding'),api('/projects'),api('/clients')]);state=saved;
    project.replaceChildren(new Option('프로젝트 선택',''));for(const name of list.projects)project.add(new Option(name,name));
    project.value=saved.project||$('project').value||'';client.value=saved.client||'codex';
    path.value=connections.clients.find(c=>c.client===client.value)?.path||'';status.textContent='선택 후 연결 확인 아이콘을 누르세요.';commands.textContent='';
    projectStep.hidden=true;if(!dialog.open)dialog.showModal();await inspect();
  }
  client.onchange=()=>act(async()=>{const chosen=client.value;projectStep.hidden=true;path.value='';status.textContent='선택한 에이전트의 연결을 다시 확인하세요.';commands.textContent='';const data=await api('/clients');if(client.value===chosen)path.value=data.clients.find(c=>c.client===chosen)?.path||'';});
  window.refreshSetup=()=>{const chosen=!!$('project').value;$('welcome').hidden=chosen;$('messages').hidden=!chosen;$('composer').hidden=!chosen;$('delete-project').disabled=!chosen;};
  window.setupSettingsSaved=()=>{};window.setupRequestSent=()=>{};
  $('setup-steps').replaceChildren();$('setup-progress').textContent='서버에 진행 상태 저장';$('setup-detail').textContent='STEP 1 · 에이전트 하나 연결 → STEP 2 · 프로젝트 생성 또는 선택 → 모델 선택';
  $('setup-next').onclick=()=>act(open);window.actionIcon($('setup-next'),'plug','초기 연결 설정 열기');
  $('setup-skip').onclick=()=>{$('setup-guide').open=false;};$('welcome-start').textContent='처음 시작하기';$('welcome-start').onclick=()=>act(open);
  window.refreshSetup();window.loadModelChoices();
  act(async()=>{const saved=await api('/onboarding');if(['pending','in_progress'].includes(saved.status))await open();else if(saved.status==='completed'&&saved.project){await projects(saved.project);if($('project').value)await loadProject();}});
})();
