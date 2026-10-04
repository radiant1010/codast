/* The document room reads durable files. No model calls or attachment selection. */
(()=>{
  const panel=el('section',undefined,'vault-panel');panel.id='document-vault-panel';
  const intro=el('p','문서를 작성하고 변경 내용을 검토하세요. 이전 승인본과 검토 결과는 문서함에 함께 보관됩니다.','hint');
  const setup=el('form',undefined,'modal-form'),path=el('input'),mode=el('select'),status=el('p',undefined,'hint');
  path.id='vault-path';path.required=true;path.placeholder='산출물을 보관할 폴더의 전체 경로';
  mode.id='vault-mode';mode.add(new Option('새 문서함 만들기','create'));mode.add(new Option('기존 문서함 연결','connect'));
  status.id='vault-status';status.setAttribute('role','status');
  let project='',binding=null,doc=null,dirty=false,busy=false,generation=0,reviewGeneration=0,connectedOnce=false;
  const endpoint=()=>'/projects/'+encodeURIComponent(project)+'/document-vault';
  const query=()=>'?connection_id='+encodeURIComponent(binding.connection_id);
  function field(label,node){const wrap=el('div',undefined,'form-field'),lab=el('label',label);lab.htmlFor=node.id;wrap.append(lab,node);return wrap;}
  function icon(kind,label,handler){const n=button('',handler);window.actionIcon(n,kind,label);return n;}
  function report(message,error=false){status.textContent=message;status.classList.toggle('error',error);}
  async function request(path,method,body){const ticket=generation;const value=await api(path,method,body);if(ticket!==generation)throw Error('프로젝트가 변경되었습니다.');return value;}
  async function run(fn){if(busy)return;const ticket=generation;busy=true;panel.setAttribute('aria-busy','true');setDisabled(true);try{await fn();}catch(e){if(ticket===generation){if(dialog.open){editorStatus.textContent=e.message;editorStatus.classList.add('error');}else report(e.message,true);}}finally{busy=false;panel.setAttribute('aria-busy','false');setDisabled(false);}}
  const pick=icon('folder','산출물 폴더 선택',()=>run(async()=>{
    const data=await request('/workspace-folder','POST');if(data.path){report('폴더를 선택했습니다. 아직 저장 전입니다. 아래 연결 버튼을 눌러 적용하세요.');path.value=data.path;}
  }));
  const pathField=field('산출물 저장 위치',path),pathRow=el('div',undefined,'field-action-row');path.replaceWith(pathRow);pathRow.append(path,pick);
  const connect=icon('plug','문서함 생성 또는 연결',()=>setup.requestSubmit());connect.type='submit';connect.onclick=null;
  const modeField=field('연결 방법',mode),modeRow=el('div',undefined,'field-action-row');mode.replaceWith(modeRow);modeRow.append(mode,connect);
  setup.append(pathField,el('p','폴더 선택만으로는 저장되지 않습니다. 연결 방법 오른쪽의 연결 버튼을 눌러 적용하세요. 선택한 보관함 아래에 프로젝트 이름의 폴더를 만들고 내부 이력은 .codast-documents, 내보내기 위치는 exports로 구분합니다. 기존 문서함은 .codast-documents 폴더를 직접 선택해 연결할 수 있습니다. 다른 문서함에 연결해도 이전 자료는 이동하거나 삭제하지 않습니다.','hint'),modeField);
  const tools=el('div',undefined,'vault-heading'),list=el('div',undefined,'vault-list'),issues=el('div',undefined,'vault-issues');
  const create=icon('plus','새 산출물 작성',()=>openNew());
  const refresh=icon('restore','문서함 다시 읽기',()=>run(()=>loadList()));
  tools.append(el('h2','보관된 문서'),create,refresh);panel.append(intro,setup,status,tools,issues,list);
  window.settingsPage.register('documents','산출물 문서함',panel);

  const dialog=el('dialog',undefined,'session-drawer vault-editor');dialog.id='vault-editor';dialog.setAttribute('aria-labelledby','vault-editor-heading');
  const head=el('header'),heading=el('h2','새 산출물');heading.id='vault-editor-heading';
  const close=icon('close','산출물 편집 닫기',()=>{if(canClose())dialog.close();});head.append(heading,close);
  const meta=el('p',undefined,'hint'),editorStatus=el('p',undefined,'hint');editorStatus.id='vault-editor-status';editorStatus.setAttribute('role','status');
  const form=el('form',undefined,'modal-form'),title=el('input'),content=el('textarea'),reason=el('textarea');
  title.id='vault-title';title.required=true;title.maxLength=120;
  content.id='vault-content';content.maxLength=200000;content.rows=12;content.spellcheck=false;
  reason.id='vault-reason';reason.maxLength=2000;reason.rows=2;reason.placeholder='이번 내용을 검토해야 하는 이유를 입력하세요.';
  const actions=el('div',undefined,'vault-actions'),save=icon('save','문서 초안 저장',()=>{});save.type='submit';save.onclick=null;
  const submit=icon('send','저장된 초안 검토 요청',()=>run(async()=>{
    if(dirty)throw Error('먼저 초안을 저장한 뒤 검토를 요청하세요.');
    if(!reason.value.trim())throw Error('변경 이유를 입력하세요.');
    const result=await request(endpoint()+'/documents/'+doc.id+'/reviews','POST',{connection_id:binding.connection_id,expected_revision:doc.revision,reason:reason.value});
    renderDocument(result);await loadList();editorStatus.textContent='검토를 요청했습니다. 변경 전후를 확인하고 검토 결과를 입력하세요.';
  }));
  const upload=el('input');upload.type='file';upload.accept='.md,.txt';upload.hidden=true;
  const importFile=icon('importDocument','Markdown 또는 텍스트 불러오기',()=>upload.click());
  upload.onchange=()=>run(async()=>{
    const file=upload.files[0];if(!file)return;
    try{
      if(!/\.(md|txt)$/i.test(file.name)||file.size>800000)throw Error('UTF-8 형식의 MD 또는 TXT 파일을 800 KB 이하로 선택하세요.');
      const text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());
      if(text.length>200000)throw Error('본문은 200,000자 이하로 입력하세요.');
      if(!title.value)title.value=file.name.replace(/\.(md|txt)$/i,'').slice(0,120);
      content.value=text;dirty=true;editorStatus.textContent='내용을 불러왔습니다. 확인 후 초안을 저장하세요.';
    }finally{upload.value='';}
  });
  actions.append(importFile,upload,save,submit);form.append(field('문서 제목',title),field('문서 내용',content),field('변경 이유',reason),actions);
  const reviews=el('section',undefined,'vault-reviews'),select=el('select');select.id='vault-review-select';
  const comparison=el('div',undefined,'vault-comparison'),before=el('pre'),after=el('pre'),reviewInfo=el('p',undefined,'hint');
  const left=el('section'),right=el('section');left.append(el('h3','변경 전 승인본'),before);right.append(el('h3','검토에 제출한 내용'),after);comparison.append(left,right);
  const decisionForm=el('div',undefined,'modal-form'),comment=el('textarea');comment.id='vault-comment';comment.maxLength=2000;comment.rows=2;
  const approve=icon('check','선택한 버전 승인',()=>decide('approved')),reject=icon('close','선택한 버전 반려',()=>decide('rejected'));
  const decisionActions=el('div',undefined,'vault-actions');decisionActions.append(approve,reject);
  decisionForm.append(field('검토 결과',comment),decisionActions);
  const audit=el('details'),auditList=el('ol');audit.append(el('summary','변경 기록'),auditList);
  reviews.append(el('h3','버전별 검토 이력'),field('조회할 검토 버전',select),reviewInfo,comparison,decisionForm,audit);
  dialog.append(head,meta,editorStatus,form,reviews);document.body.append(dialog);
  for(const input of [title,content])input.addEventListener('input',()=>{dirty=true;setDisabled(busy);});
  function canClose(){return !busy&&(!dirty||window.confirm('저장하지 않은 수정 내용을 버리고 닫을까요?'));}
  dialog.addEventListener('cancel',event=>{if(!canClose())event.preventDefault();});
  dialog.addEventListener('close',()=>{dirty=false;doc=null;reviewGeneration++;});
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  function setDisabled(value){
    for(const n of [path,mode,pick,connect,refresh])n.disabled=value;
    create.disabled=value||!binding;
    for(const n of [title,content,importFile,save])n.disabled=value||Boolean(doc?.pending);
    reason.disabled=value||!doc||Boolean(doc?.pending);
    submit.disabled=value||!doc||Boolean(doc?.pending)||dirty;
    select.disabled=value;
    close.disabled=value;
    for(const n of [comment,approve,reject])n.disabled=value||!doc?.pending||Number(select.value)!==doc.pending;
  }
  function openNew(){
    if(!binding)return;doc=null;dirty=false;form.hidden=false;heading.textContent='새 산출물';title.value='';content.value='';reason.value='';
    meta.textContent='초안을 저장하면 CODAST 문서 번호가 부여됩니다.';editorStatus.textContent='';editorStatus.classList.remove('error');reviews.hidden=true;
    setDisabled(false);dialog.showModal();title.focus();
  }
  const labels={pending:'검토 대기',approved:'승인',rejected:'반려'};
  const stateText=d=>d.pending?'검토 대기':d.approved?'승인본 있음':'초안';
  function renderDocument(value){
    doc=value;dirty=false;form.hidden=Boolean(value.pending);dialog.scrollTop=0;heading.textContent=value.id;title.value=value.title;content.value=value.content;reason.value='';comment.value='';
    meta.textContent=stateText(value)+(value.approved?' · 승인 기준: 검토 버전 '+value.approved:' · 승인된 버전 없음');
    editorStatus.textContent='';editorStatus.classList.remove('error');reviews.hidden=!value.reviews.length;
    select.replaceChildren();for(const review of value.reviews)select.add(new Option('검토 버전 '+review.number+' — '+labels[review.decision],review.number));
    if(value.reviews.length)select.value=String(value.pending||value.reviews.length);
    auditList.replaceChildren();const names={created:'문서 등록',saved:'초안 저장',submitted:'검토 요청',approved:'승인',rejected:'반려'};
    for(const event of value.history.slice().reverse())auditList.append(el('li',names[event.action]+' · '+new Date(event.at).toLocaleString()+' · 로컬 사용자'));
    setDisabled(busy);if(value.reviews.length)loadReview();
  }
  async function loadReview(){
    const ticket=++reviewGeneration,id=doc.id,number=Number(select.value),b=endpoint(),v=binding.connection_id;
    decisionForm.hidden=true;before.textContent='불러오는 중…';after.textContent='';reviewInfo.textContent='';
    try{
      const data=await api(b+'/documents/'+id+'/reviews/'+number+'?connection_id='+v);
      if(ticket!==reviewGeneration||doc?.id!==id||b!==endpoint())return;
      before.textContent=data.review.base?data.before.title+'\n\n'+data.before.content:'이전 승인본이 없습니다.';
      after.textContent=data.after.title+'\n\n'+data.after.content;
      reviewInfo.textContent='변경 이유: '+data.review.reason+(data.review.comment?'\n검토 결과: '+data.review.comment:'')+'\n'+labels[data.review.decision]+' · '+new Date(data.review.decided_at||data.review.submitted_at).toLocaleString();
      decisionForm.hidden=doc.pending!==number;comment.value='';setDisabled(busy);
    }catch(e){if(ticket===reviewGeneration){before.textContent='';after.textContent='';editorStatus.textContent=e.message;}}
  }
  select.onchange=loadReview;
  function decide(decision){return run(async()=>{
    if(!comment.value.trim())throw Error('검토 결과를 입력하세요.');
    const number=Number(select.value);
    const result=await request(endpoint()+'/documents/'+doc.id+'/reviews/'+number+'/decision','POST',{connection_id:binding.connection_id,expected_revision:doc.revision,decision,comment:comment.value});
    renderDocument(result);await loadList();editorStatus.textContent=decision==='approved'?'이 버전을 승인 기준으로 기록했습니다.':'반려했습니다. 초안을 수정한 뒤 다시 검토를 요청할 수 있습니다.';
  });}
  form.onsubmit=event=>{event.preventDefault();run(async()=>{
    const payload={connection_id:binding.connection_id,title:title.value,content:content.value};
    if(doc)payload.expected_revision=doc.revision;
    const result=await request(endpoint()+'/documents'+(doc?'/'+doc.id:''),doc?'PUT':'POST',payload);
    renderDocument(result);await loadList();editorStatus.textContent='초안을 저장했습니다. 변경 이유를 입력하고 검토를 요청하세요.';
  });};
  async function loadList(){
    list.replaceChildren();issues.replaceChildren();if(!binding)return;
    const ticket=generation,b=endpoint(),v=binding.connection_id,data=await api(b+'/documents?connection_id='+v);
    if(ticket!==generation||binding?.connection_id!==v)return;
    for(const problem of data.issues)issues.append(el('p',problem.id+': '+problem.message,'error'));
    if(!data.documents.length)list.append(el('p',data.issues.length?'읽을 수 있는 문서가 없습니다. 백업을 확인하세요.':'아직 문서가 없습니다. + 버튼으로 첫 산출물을 작성하세요.','hint'));
    for(const row of data.documents){
      const card=el('article'),text=el('div');text.append(el('strong',row.title),el('p',row.id+' · '+stateText(row)+(row.approved?' · 승인 버전 '+row.approved:''),'hint'));
      const open=icon('file',row.id+' 열기',()=>run(async()=>{const value=await api(b+'/documents/'+row.id+'?connection_id='+v);if(ticket!==generation)return;renderDocument(value);dialog.showModal();}));
      card.append(text,open);list.append(card);
    }
    report(data.issues.length?'문서함에서 손상되거나 누락된 자료를 발견했습니다.':'연결됨: '+(binding.project_path||binding.path)+' — '+data.documents.length+'개 문서를 읽었습니다.',Boolean(data.issues.length));
  }
  setup.onsubmit=event=>{event.preventDefault();run(async()=>{
    const target=path.value.trim();
    if(binding&&(binding.base_path||binding.path)!==target&&!window.confirm('이전 자료는 그대로 두고 선택한 문서함으로 연결을 변경할까요?'))return;
    const result=await request(endpoint(),'PUT',{path:target,mode:mode.value,layout:'project',expected_connection_id:binding?.connection_id||null});
    binding=result.binding;path.value=binding.base_path||binding.path;mode.value='connect';await loadList();
  });};
  async function enter(){
    if(location.hash!=='#settings/documents')return;
    const selected=$('project').value;
    if(connectedOnce&&selected===project)return;
    project=selected;generation++;binding=null;doc=null;list.replaceChildren();issues.replaceChildren();setDisabled(true);
    if(!project){report('작업실에서 프로젝트를 먼저 선택하세요.');return;}
    const ticket=generation;
    try{const data=await api(endpoint());if(ticket!==generation)return;binding=data.binding;path.value=binding?.base_path||binding?.path||data.suggested_base_path;mode.value=binding?'connect':'create';connectedOnce=true;await loadList();if(!binding)report('저장 위치를 확인하고 새 문서함을 만드세요.');}
    catch(e){report(e.message,true);connectedOnce=false;}finally{if(ticket===generation)setDisabled(false);}
  }
  $('project').addEventListener('change',()=>{connectedOnce=false;generation++;reviewGeneration++;binding=null;});
  window.documentVault={projectReady:enter};
  window.addEventListener('hashchange',enter);window.addEventListener('load',enter);
  setDisabled(false);
})();
