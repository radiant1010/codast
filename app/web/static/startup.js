/* Restore the workspace before considering first-time setup. */
async function initializeWorkspace(){
  await projects();
  $('project').value=window.chatState.lastProject();
  if($('project').value){await loadProject();return;}
  const saved=await api('/onboarding');
  const candidates=[window.chatState.lastProject(),saved.project].filter(Boolean);
  for(const name of new Set(candidates)){
    $('project').value=name;
    if($('project').value){await loadProject();return;}
  }
  if(!['pending','in_progress'].includes(saved.status))return;
  return checkInitialConnection;
}

async function checkInitialConnection(){
  notice('에이전트 연결 확인 중 · 프로젝트를 선택하거나 등록할 수 있습니다.');
  let connections;
  try{connections=await api('/clients');}
  catch{if(!$('project').value)notice('연결 상태를 확인하지 못했습니다. 에이전트 연결 메뉴에서 다시 확인하세요.',true);return;}
  if($('project').value)return;
  if(connections.clients.some(client=>client.state==='installed'&&client.auth==='ready')){
    notice('에이전트가 연결되어 있습니다. 프로젝트를 선택하거나 등록하세요.');
    return;
  }
  notice('에이전트 연결이 필요합니다. 에이전트 연결 메뉴에서 설정하세요.');
}


async function startWorkspace(){
  const overlay=$('startup-loading'),workspace=$('workspace'),retry=$('startup-retry');
  overlay.hidden=false;workspace.inert=true;workspace.setAttribute('aria-busy','true');
  retry.hidden=true;overlay.classList.remove('failed');$('startup-message').textContent='작업실을 불러오는 중…';
  try{const afterReady=await initializeWorkspace();overlay.hidden=true;workspace.inert=false;workspace.setAttribute('aria-busy','false');if(afterReady)void afterReady();}
  catch(error){overlay.classList.add('failed');$('startup-message').textContent='작업실을 불러오지 못했습니다. '+error.message;retry.hidden=false;retry.focus();}
}
$('startup-retry').onclick=()=>startWorkspace();
