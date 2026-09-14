/* Optional onboarding. Completion records user choices, not inferred CLI authentication. */
(()=>{
  const labels=['프로젝트 선택','에이전트 선택','작업 범위 설정','첫 요청 보내기'];
  const descriptions=[
    '기존 프로젝트를 선택하거나 새 프로젝트 이름을 입력하고 생성하세요.',
    '실행 설정에서 기본 에이전트를 선택하세요. Mock은 화면 시험용입니다. 실제 CLI 설치·인증은 CLI 연결에서 확인하세요.',
    '작업 디렉터리와 권한을 확인하고 설정 저장을 누르세요. 처음에는 읽기 전용을 권장합니다. 참고 파일은 선택 사항입니다.',
    '요청 예시를 입력창에 넣어 드립니다. 내용을 고친 뒤 직접 보내세요.'
  ];
  let step=0;
  const cache={};
  function name(){return $('project').value;}
  function read(){
    const key=name();if(!key)return {};
    if(!cache[key]){try{const value=JSON.parse(localStorage.getItem('codast-setup:'+key)||'{}');cache[key]=value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{cache[key]={};}}
    return cache[key];
  }
  function save(update){if(!name())return;Object.assign(read(),update);try{localStorage.setItem('codast-setup:'+name(),JSON.stringify(read()));}catch{}refresh();}
  function signature(){return JSON.stringify({cwd:$('cwd').value,client:$('client').value,mode:$('mode').value,files:selectedPaths().sort()});}
  function openPanel(id,focus){
    $('workspace').classList.remove('collapsed');$('toggle-sidebar').setAttribute('aria-expanded','true');
    $(id).open=true;$(id).scrollIntoView({block:'nearest',behavior:'smooth'});if(focus)$(focus).focus({preventScroll:true});
  }
  function refresh(){
    const selected=!!name(),state=read();
    const done=[selected,selected&&state.agent===$('client').value,selected&&state.settings===signature(),selected&&!!state.sent];
    step=done.findIndex(value=>!value);
    $('setup-progress').textContent=done.filter(Boolean).length+'/4';$('setup-steps').replaceChildren();
    labels.forEach((label,index)=>{const item=el('li');const action=button((done[index]?'✓':String(index+1))+'  '+label,async()=>go(index));action.disabled=index>0&&!selected;action.className=done[index]?'setup-done':index===step?'setup-current':'';if(index===step)action.setAttribute('aria-current','step');item.append(action);$('setup-steps').append(item);});
    $('setup-detail').textContent=step<0?'준비 완료. 필요할 때 설정을 다시 바꿀 수 있습니다.':descriptions[step];
    $('setup-next').textContent=step<0?'새 요청 작성하기':['프로젝트 선택하기','에이전트 고르기','작업 설정 열기','요청 예시 넣기'][step];
    $('messages-prev').closest('.pagination').hidden=!selected;if(!selected)$('chat-title').textContent='시작 준비';
    $('welcome').hidden=selected;$('messages').hidden=!selected;$('composer').hidden=!selected;
    $('delete-project').disabled=!selected;
  }
  function go(index){
    if(index===0){openPanel('project-panel',name()?'project':'name');return;}
    if(!name())return;
    if(index===1){openPanel('settings-panel','client');return;}
    if(index===2){openPanel('settings-panel','cwd');return;}
    const client=$('client').value;
    if(!$('text').value.trim())$('text').value=client==='mock'?'선택한 자료와 적용 규칙을 확인해줘.':'/'+client+' '+(selectedPaths().length?'선택한 파일을 읽고 요구사항을 정리해줘.':'이번 프로젝트에서 만들 기능을 정리하려고 해. 먼저 필요한 정보를 질문해줘.');
    if(client==='mock')$('action').value='run';
    actionHint();$('text').focus();notice('예시를 입력했습니다. 요청 내용을 고친 뒤 보내세요.');
  }
  window.refreshSetup=refresh;
  window.setupSettingsSaved=()=>{save({agent:$('client').value,settings:signature()});openPanel('setup-guide');};
  window.setupRequestSent=()=>save({sent:true});
  $('client').addEventListener('change',()=>save({agent:$('client').value}));
  $('mode').addEventListener('change',refresh);$('cwd').addEventListener('input',refresh);$('files').addEventListener('change',refresh);
  // Confirm the current default too; no forced change to another agent is necessary.
  const confirmAgent=button('이 에이전트로 준비',async()=>{save({agent:$('client').value});openPanel('settings-panel','cwd');});
  window.decorateAction?.(confirmAgent,'이 에이전트로 준비');$('client').after(confirmAgent);const checkClient=button('CLI 설치·연결 확인 열기',async()=>openPanel('clients-panel','probe-clients'));window.decorateAction?.(checkClient,'CLI 설치·연결 확인 열기');confirmAgent.after(checkClient);
  $('setup-next').onclick=()=>go(step<0?3:step);$('welcome-start').onclick=()=>go(0);
  $('setup-skip').onclick=()=>{$('setup-guide').open=false;};
  refresh();
})();
