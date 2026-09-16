/* Familiar action icons retain Korean accessible names and hover descriptions. */
(()=>{
  const paths={
    plus:'<path d="M12 5v14M5 12h14"/>',
    folder:'<path d="M3 7V5h6l2 2h10v12H3z"/><path d="M3 11h18"/>',
    file:'<path d="M14 3H5v18h14V8zM14 3v5h5"/><path d="M8 13h8M8 17h6"/>',
    save:'<path d="M4 3h13l3 3v15H4zM8 3v6h8V3M8 21v-8h8v8"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    close:'<path d="m6 6 12 12M6 18 18 6"/>',
    trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    send:'<path d="m3 3 18 9-18 9 4-9zM7 12h14"/>',
    plug:'<path d="M8 3v5M16 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
    back:'<path d="m14 6-6 6 6 6"/>',
    next:'<path d="m10 6 6 6-6 6"/>',
    restore:'<path d="M3 4v6h6M3 10a9 9 0 1 1 1 8"/>',
    route:'<path d="M5 4v16M5 8h8a5 5 0 0 0 5-5M5 15h8a5 5 0 0 1 5 5M15 4l3-2 3 2M15 20l3 2 3-2"/>'
  };
  function icon(button,kind,label){
    button.classList.add('action-icon');button.setAttribute('aria-label',label);button.title=label;
    button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+paths[kind]+'</svg>';
  }
  const dynamic={'열기':'file','경로 저장':'folder','경로 등록':'folder','복원':'restore','이 에이전트로 준비':'check','CLI 설치·연결 확인 열기':'plug','이동':'route'};
  window.decorateAction=(button,label)=>{if(dynamic[label])icon(button,dynamic[label],label);};
  window.actionIcon=icon;
  const actions={
    'add-workspace':['folder','프로젝트 폴더 선택'],
    'choose-workspace':['folder','폴더 선택 · 워크스페이스 추가'],
    'pick-folder':['folder','폴더 선택'],
    'register-folder':['plus','선택한 워크스페이스 추가'],
    'cancel-workspace':['close','워크스페이스 추가 취소'],
    'open-editor':['file','문서 탐색 · 편집 열기'],
    'new-document':['plus','새 문서'],
    'read':['file','경로의 문서 열기'],
    'write':['save','문서 저장 (Ctrl+S)'],
    'save-settings':['save','실행 설정 저장'],
    'update-task':['check','작업 변경 적용'],
    'probe-clients':['plug','CLI 설치·연결 확인'],
    'delete-project':['trash','선택한 프로젝트 삭제'],
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
