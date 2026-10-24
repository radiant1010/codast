/* Familiar action icons retain Korean accessible names and hover descriptions. */
(()=>{
  const symbols={
    pin:'push_pin',archive:'archive',edit:'edit',plus:'add',minus:'remove',
    paperclip:'attach_file',importDocument:'file_open',folderPlus:'create_new_folder',
    folder:'folder_open',file:'description',save:'save',check:'check',close:'close',
    trash:'delete',send:'send',plug:'power',back:'chevron_left',next:'chevron_right',
    restore:'refresh',route:'account_tree',menu:'menu'
  };
  function icon(button,kind,label){
    button.classList.add('action-icon');button.setAttribute('aria-label',label);button.title=label;
    button.innerHTML='<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><use href="/static/vendor/material-symbols-sharp/symbols.svg#'+symbols[kind]+'"></use></svg>';
  }
  const dynamic={'열기':'file','경로 저장':'folder','경로 등록':'folder','복원':'restore','이 에이전트로 준비':'check','CLI 설치 및 연결 확인 열기':'plug','이동':'route'};
  window.decorateAction=(button,label)=>{if(dynamic[label])icon(button,dynamic[label],label);};
  window.actionIcon=icon;
  const actions={
    'toggle-sidebar':['menu','제어판 접기'],
    'reload':['restore','작업 목록 새로고침'],
    'reload-rules':['restore','적용 규칙 새로고침'],
    'add-workspace':['folder','프로젝트 폴더 선택'],
    'choose-workspace':['folder','작업 폴더 연결'],
    'pick-folder':['folder','폴더 선택'],
    'register-folder':['plus','선택한 워크스페이스 추가'],
    'cancel-workspace':['close','워크스페이스 추가 취소'],
    'save-settings':['save','실행 설정 저장'],
    'probe-clients':['plug','CLI 설치 및 연결 확인'],
    'delete-project':['trash','선택한 프로젝트 삭제'],
    'rename-project':['edit','프로젝트 이름 변경'],
    'manage-project-name':['edit','선택한 프로젝트 이름 변경'],
    'save-project-name':['save','프로젝트 이름 저장'],
    'cancel-project-name':['close','프로젝트 이름 변경 취소'],
    'send':['send','요청 보내기'],
    'preview-route':['route','작업 분류 확인'],
    'messages-prev':['back','최신 대화 쪽'],
    'messages-next':['next','이전 대화 기록'],
    'history-prev':['back','최신 실행 쪽'],
    'history-next':['next','이전 실행 기록']
  };
  for(const [id,[kind,label]] of Object.entries(actions)){const button=document.getElementById(id);if(button)icon(button,kind,label);}
  const create=document.querySelector('#create button');if(create)icon(create,'plus','빈 프로젝트 생성');
})();

// Resolve the current full label on demand, including dynamically populated controls.
for(const event of ['mouseover','focusin','change'])document.addEventListener(event,({target})=>{
  if(!(target instanceof Element))return;
  const node=target.closest('select,input:not([type=checkbox]):not([type=radio]),.archived-chat-row>span,.rulebook-select,.rulebook-trash-row>span,.settings-context,#chat-title');
  if(!node||node.matches('input[type=password]'))return;
  node.title=node instanceof HTMLSelectElement?node.selectedOptions[0]?.textContent||'':node instanceof HTMLInputElement?node.value:node.textContent.trim();
});
