/* Familiar action icons retain Korean accessible names and hover descriptions. */
(()=>{
  const paths={
    pin:'<path d="m8 3 8 0-1 6 4 4v2H5v-2l4-4-1-6zM12 15v6"/>',
    archive:'<path d="M3 4h18v4H3zM5 8v12h14V8M9 12h6"/>',
    edit:'<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6z"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    importDocument:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M20 15H10m3-3-3 3 3 3"/>',
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
    'save-settings':['save','실행 설정 저장'],
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
