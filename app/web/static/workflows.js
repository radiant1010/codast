/* A: prepare the sequence, review each result, explicitly dispatch the next step. */
(()=>{
  const roles=['요구사항','화면','테스트 케이스','기타 파일'];
  let project='',binding=null,current=null,locked=false,timer=null,creationId=null;
  const endpoint=()=>'/projects/'+encodeURIComponent(project)+'/workflows';
  const dialog=el('dialog',undefined,'session-drawer workflow-dialog');dialog.id='workflow-dialog';
  const head=el('header'),heading=el('h2','작업 순서 설정'),body=el('div'),status=el('p',undefined,'hint');status.setAttribute('role','status');
  function icon(kind,label,fn){const n=button('',fn);window.actionIcon(n,kind,label);return n;}
  function field(label,input){const wrap=el('div',undefined,'form-field'),lab=el('label',label);input.id=input.id||'wf-'+crypto.randomUUID();lab.htmlFor=input.id;wrap.append(lab,input);return wrap;}
  function select(values,value){const n=el('select');for(const v of values){const o=el('option',v);o.value=v;n.append(o);}n.value=value||values[0];return n;}
  function modeSelect(value){const n=select(['read-only','workspace-write'],value||'read-only');n.options[0].textContent='분석만 (읽기 전용)';n.options[1].textContent='구현, 테스트 (작업 폴더 수정 허용)';return n;}
  const resultDialog=el('dialog',undefined,'session-drawer workflow-dialog');resultDialog.id='workflow-result-dialog';const resultBody=el('div'),resultStatus=el('p',undefined,'hint');resultStatus.setAttribute('role','status');const resultHead=el('header');resultHead.append(el('h2','작업 결과 상세'),icon('close','결과 상세 닫기',()=>resultDialog.close()));resultDialog.append(resultHead,resultStatus,resultBody);document.body.append(resultDialog);
  const close=icon('close','워크플로 닫기',()=>dialog.close());head.append(heading,close);dialog.append(head,status,body);document.body.append(dialog);
  dialog.addEventListener('close',()=>clearTimeout(timer));
  async function safe(fn){if(locked)return;locked=true;const controls=[...body.querySelectorAll('button,input,select,textarea')].map(n=>[n,n.disabled]);controls.forEach(([n])=>n.disabled=true);try{status.textContent='처리 중…';await fn();status.textContent='';}catch(e){status.textContent=e.message;if(resultDialog.open)resultStatus.textContent=e.message;}finally{locked=false;controls.forEach(([n,d])=>{if(n.isConnected)n.disabled=d;});}}
  const launch=icon('route','워크플로 설정 및 진행',()=>safe(async()=>{
    if(!$('project').value)throw Error('먼저 프로젝트를 선택하세요.');
    project=$('project').value;current=null;heading.textContent=project+' ,  작업 순서와 결과';body.replaceChildren();dialog.showModal();
    const settings=await api('/projects/'+encodeURIComponent(project)+'/document-vault');binding=settings.binding;
    if(!binding){connectionSetup(settings.suggested_base_path);return;}
    await listing();
  }));
  const bar=el('div',undefined,'workflow-launch');bar.append(launch,el('span','자료와 작업 순서 설정','hint'));$('action-hint').before(bar);
  const menu=button('워크플로',()=>launch.click());menu.setAttribute('aria-label','워크플로 관리');document.querySelector('.workspace-menu').append(menu);
  function connectionSetup(suggested){
    body.replaceChildren();const form=el('form',undefined,'modal-form'),path=el('input'),mode=select(['create','connect'],'create');
    path.value=suggested;path.required=true;path.id='workflow-vault-path';
    mode.options[0].textContent='새 문서함 만들기';mode.options[1].textContent='기존 문서함 연결';
    const note=el('p','선택한 보관함 아래에 '+project+' 폴더를 만들고 이력(.codast-documents)과 내보내기 위치(exports)를 구분합니다. 폴더 선택 후 연결 버튼을 눌러 저장하세요.','hint');
    const pick=icon('folder','워크플로 산출물 폴더 선택',()=>safe(async()=>{
      const result=await api('/workspace-folder','POST');if(!result.path)return;
      path.value=result.path;
      note.textContent='폴더를 선택했습니다. 아직 연결 전입니다. 연결 방법을 확인하고 저장하세요.';
    }));
    const pathField=field('산출물 저장 위치',path),row=el('div',undefined,'field-action-row');path.replaceWith(row);row.append(path,pick);
    form.append(el('h3','이 프로젝트의 산출물 저장 위치 연결'),el('p',project+' 프로젝트에는 연결된 문서함이 없습니다. 작업 폴더와 산출물 저장 위치는 따로 관리합니다.','hint'),pathField,field('연결 방법',mode),note);
    const actions=el('div',undefined,'workflow-actions');actions.append(el('span','저장 위치 연결 후 계속'),icon('plug','산출물 저장 위치 연결',()=>form.requestSubmit()));form.append(actions);body.append(form);
    form.onsubmit=e=>{e.preventDefault();safe(async()=>{
      const result=await api('/projects/'+encodeURIComponent(project)+'/document-vault','PUT',{path:path.value.trim(),mode:mode.value,layout:'project',expected_connection_id:null});
      binding=result.binding;await listing();
    });};
  }
  async function listing(){
    clearTimeout(timer);current=null;const rows=await api(endpoint()+'?connection_id='+binding.connection_id);body.replaceChildren();
    const tools=el('div',undefined,'workflow-actions');tools.append(el('h3','보관된 워크플로'),icon('plus','새 워크플로',()=>safe(setup)),icon('route','새 병렬 설계와 테스트 정의',()=>safe(parallelSetup)));body.append(tools);
    if(!rows.length)body.append(el('p','자료와 단계별 담당을 정해 첫 작업을 준비하세요.','hint'));
    for(const row of rows)body.append(button(row.title+' — '+label(row.status),()=>safe(()=>load(row.id))));
  }
  function label(value){return {ready:'실행 준비',running:'실행 중 / 종료 확인 필요',review:'결과 검토',question:'질문 답변 필요',failed:'실행 실패',cancelled:'실행 취소',partial:'작업별 확인 필요',approved:'결과 승인',done:'모든 단계 승인 완료'}[value]||value;}
  function storageNotice(container,s,attempt){
    if(attempt.storage_status==='failed')container.append(el('p','결과 보관 실패: '+attempt.storage_error,'workflow-storage-error'),el('p','실행 기록의 결과를 표시합니다. 다시 보관은 AI를 재실행하지 않습니다. 보관 후 승인할 수 있습니다.','hint'));
    else if(attempt.storage_status==='missing')container.append(el('p','실행 기록이 없습니다. 복구할 결과를 찾을 수 없어 자동 재실행하지 않았습니다. 중단 기록을 보관하거나 필요한 작업만 새로 실행하세요. 새 실행은 AI를 호출합니다.','workflow-storage-error'));
    else if(attempt.storage_status==='saved')container.append(el('p','문서함 보관 완료','hint'));
  }
  function openResult(s,index,version){
    const step=s.steps[index],attempt=step.attempts.find(a=>a.version===version),latest=attempt===step.attempts.at(-1);
    resultBody.replaceChildren();resultStatus.textContent='';
    resultBody.append(el('h3',step.title+' / v'+version),el('p',label(attempt.status)+' / 실행 ID: '+attempt.run_id,'hint'));
    storageNotice(resultBody,s,attempt);
    resultBody.append(consoleOutput(attempt.output||attempt.error||'남아 있는 결과가 없습니다.'));
    if(['failed','cancelled'].includes(attempt.status)&&attempt.output)resultBody.append(el('p','중단되거나 실패한 실행의 미완성 출력입니다. 완성된 결과로 승인하지 않습니다.','hint'));
    const inputs=el('details');inputs.append(el('summary','입력과 지시, 실행 정보'),el('pre',JSON.stringify({inputs:attempt.inputs,directive:attempt.directive,metadata:attempt.metadata,error:attempt.error},null,2)));resultBody.append(inputs);
    const actions=el('div',undefined,'workflow-actions');
    if(['failed','missing'].includes(attempt.storage_status)&&latest)actions.append(button(attempt.storage_status==='missing'?'중단 기록 보관':'다시 보관',()=>safe(async()=>{
      current=await api(endpoint()+'/'+s.id+'/recapture','POST',{connection_id:binding.connection_id,expected_revision:s.revision,run_id:attempt.run_id});render();openResult(current,index,version);
    })));
    const canApprove=latest&&!step.approved&&attempt.status==='review'&&(s.kind==='parallel'||s.current===index);
    if(canApprove){
      const comment=el('textarea');comment.rows=2;comment.maxLength=2000;const key=s.id+'/'+index;comment.value=parallelDrafts.get(key)||'';comment.oninput=()=>parallelDrafts.set(key,comment.value);resultBody.append(field('승인 의견',comment));
      const approve=button('결과 승인',()=>safe(async()=>{
        if(s.kind==='parallel')await parallelAction(s,'approve',index,comment.value);
        else current=await api(endpoint()+'/'+s.id,'POST',{connection_id:binding.connection_id,expected_revision:s.revision,action:'approve',comment:comment.value});
        parallelDrafts.delete(key);await load(s.id);resultDialog.close();
      }));approve.disabled=['failed','missing'].includes(attempt.storage_status);actions.append(approve);
    }
    resultBody.append(actions);if(!resultDialog.open)resultDialog.showModal();
  }
  async function setup(){
    creationId=crypto.randomUUID().replaceAll('-','');body.replaceChildren();
    const form=el('form',undefined,'modal-form'),title=el('input'),materials=el('div'),steps=el('div');title.required=true;title.maxLength=120;title.id='wf-title';
    form.append(field('작업 이름',title),el('h3','입력 자료'),el('p','문서에 포함된 텍스트를 보호 설정에 따라 자동 검사하고 첨부합니다. TXT, MD, CSV, XLSX, DOCX, PPTX, PDF를 지원합니다. 스캔 이미지의 OCR은 지원하지 않습니다.','hint'),materials,el('h3','작업 순서'));
    const chosen=[];
    for(const role of roles){const row=el('div',undefined,'workflow-material-row'),files=el('div'),input=el('input');input.type='file';input.multiple=true;input.accept='.txt,.md,.csv,.xlsx,.docx,.pptx,.pdf';input.hidden=true;input.setAttribute('aria-label',role+' 파일');
      input.onchange=()=>safe(async()=>{for(const file of input.files){if(chosen.length>=10)throw Error('입력 자료는 총 10개까지 등록할 수 있습니다.');
        const response=await fetch('/api/projects/'+encodeURIComponent(project)+'/materials?filename='+encodeURIComponent(file.name),{method:'POST',body:file});const data=await response.json();if(!response.ok)throw Error(data.detail||'파일 검사 실패');
        const entry={id:data.id,role};if(data.status!=='ready')throw Error('차단된 자료입니다. 파일 보호 설정과 내용을 확인하세요.');chosen.push(entry);
        const item=el('div',undefined,'workflow-actions');item.append(el('span',data.label),icon('file','전달 내용 확인',()=>safe(async()=>{const preview=await api('/projects/'+encodeURIComponent(project)+'/materials/'+data.id);const pre=el('pre',preview.content,'console-output');item.append(pre);})),icon('close','워크플로 입력에서 제외',()=>{chosen.splice(chosen.indexOf(entry),1);item.remove();}));files.append(item);
      }input.value='';});
      row.append(el('strong',role),files,icon('paperclip',role+' 업로드',()=>input.click()),input);materials.append(row);
    }
    const drafts=[];
    function addStep(value={title:'새 단계',client:'codex',instruction:''}){
      if(drafts.length>=8)return;const row=el('section',undefined,'workflow-step modal-form'),name=el('input'),client=select(['codex','claude'],value.client),model=el('input'),instruction=el('textarea');name.value=value.title;name.required=true;name.maxLength=120;instruction.value=value.instruction;instruction.required=true;instruction.maxLength=4000;instruction.rows=3;model.placeholder='비우면 CLI 기본 모델';model.maxLength=200;
      const mode=modeSelect(value.mode);const entry={row,name,client,model,instruction,mode};drafts.push(entry);
      const actions=el('div',undefined,'workflow-actions');actions.append(icon('restore','이 단계를 위로 이동',()=>{const i=drafts.indexOf(entry);if(i>0){[drafts[i-1],drafts[i]]=[drafts[i],drafts[i-1]];steps.insertBefore(row,steps.children[i-1]);}}),icon('trash','단계 삭제',()=>{if(drafts.length>1){drafts.splice(drafts.indexOf(entry),1);row.remove();}}));
      row.append(field('단계 이름',name),field('실행 권한',mode),field('담당 AI',client),field('모델',model),field('작업 지시와 제출물',instruction),actions);steps.append(row);
    }
    addStep({title:'화면과 요구사항 연결',client:'codex',instruction:'제공한 화면 자료와 요구사항을 연결하라. 화면 ID, 요구사항 ID, 근거와 확인할 사항을 표로 제출하라. 구현과 테스트 실행은 하지 마라.'});
    addStep({title:'테스트 케이스 도출',client:'claude',instruction:'앞 단계의 승인된 결과와 기존 테스트를 검토하라. 정상, 오류, 경계 조건의 테스트 ID, 요구사항 ID, 절차, 기대 결과, 기존, 신규 구분을 제출하라. 실제 테스트 실행은 하지 마라.'});
    form.append(steps,icon('plus','단계 추가',()=>addStep()),el('p','기본은 읽기 전용입니다. 구현, 테스트 단계는 작업 폴더 수정을 허용하도록 선택하세요. 결과를 승인해도 다음 AI는 자동 실행되지 않습니다.','hint'));
    const footer=el('div',undefined,'workflow-actions'),save=icon('save','워크플로 저장',()=>form.requestSubmit());footer.append(el('span','순서를 저장하고 첫 지시 확인'),save,icon('back','워크플로 목록',()=>safe(listing)));form.append(footer);body.append(form);
    form.onsubmit=e=>{e.preventDefault();safe(async()=>{const result=await api(endpoint(),'POST',{connection_id:binding.connection_id,request_id:creationId,title:title.value,materials:chosen,steps:drafts.map(d=>({title:d.name.value,client:d.client.value,mode:d.mode.value,model:d.model.value.trim()||null,instruction:d.instruction.value}))});current=result;render();});};
  }
  async function load(id){current=await api(endpoint()+'/'+id+'?connection_id='+binding.connection_id);render();}
  function render(){
    if(current.kind==='parallel'){renderParallel();return;}
    clearTimeout(timer);body.replaceChildren();const s=current,tools=el('div',undefined,'workflow-actions');tools.append(el('h3',s.title),icon('back','워크플로 목록',()=>safe(listing)),icon('restore','워크플로 새로고침',()=>safe(()=>load(s.id))));body.append(tools,el('p',s.id+' ,  '+label(s.status),'hint'));
    const list=el('ol');s.steps.forEach((step,i)=>list.append(el('li',step.title+' — '+(step.approved?'승인 v'+step.approved:i===s.current?label(s.status):'대기'))));body.append(list);
    for(const [i,step] of s.steps.entries())for(const attempt of step.attempts){
      const card=el('details',undefined,'workflow-result');card.open=i===s.current&&attempt===step.attempts.at(-1);card.append(el('summary',step.title+' ,  v'+attempt.version+' ,  '+attempt.client+(step.approved===attempt.version?' ,  승인됨':'')));
      storageNotice(card,s,attempt);card.append(button('결과 상세 보기',()=>openResult(s,i,attempt.version)));
      const metadata=attempt.metadata||{},tokens=tokenCount(metadata.usage,attempt.client);
      card.append(el('p',label(attempt.status)+' ,  '+(metadata.execution_model||attempt.model||'모델 미수신')+' ,  '+(metadata.elapsed_seconds===undefined?'시간 미수신':metadata.elapsed_seconds+'초')+' ,  '+(tokens===null?'토큰 미수신':tokens.toLocaleString('ko-KR')+'토큰'),'hint'));
      card.append(consoleOutput(attempt.output||attempt.error||'실행 결과를 기다리고 있습니다.'));
      if(attempt.output&&attempt.error)card.append(el('p',attempt.error,'hint'));
      card.append(el('p',(attempt.mode||'read-only')==='workspace-write'?'작업 폴더 수정 허용':'읽기 전용','hint'));
      if(attempt.comment)card.append(el('p','수정 의견 / 답변: '+attempt.comment));
      if(attempt.approval_comment)card.append(el('p','승인 의견: '+attempt.approval_comment));
      if(attempt.directive){const directive=el('details');directive.append(el('summary','전달한 작업 지시서'),el('pre',attempt.directive));card.append(directive);}
      const inputs=el('details');inputs.append(el('summary','이 실행에 전달한 이전 결과'),el('pre',JSON.stringify(attempt.inputs,null,2)));card.append(inputs);body.append(card);
    }
    if(s.status==='done'){
      body.append(el('p','모든 결과를 승인했습니다. 승인된 단계별 문서와 버전 목록, 수정, 승인 이력을 ZIP으로 내려받을 수 있습니다. 이력에는 전달한 자료의 가공본도 포함됩니다.','hint'),icon('save','승인 산출물과 이력 내려받기',()=>safe(async()=>{
        const response=await fetch('/api'+endpoint()+'/'+s.id+'/export?connection_id='+binding.connection_id);
        if(!response.ok){const error=await response.json();throw Error(error.detail||'내려받기 실패');}
        const url=URL.createObjectURL(await response.blob()),link=el('a');link.href=url;link.download=s.id+'.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      })));
      return;
    }
    const step=s.steps[s.current];
    if(s.status==='running'){
      const attempt=step.attempts.at(-1);body.append(icon('close',s.cancellable===false?'프로세스 종료 확인 후 기록 정리':'현재 단계 실행 취소',()=>safe(async()=>{if(s.cancellable===false&&!confirm('다른 서버나 CLI 프로세스가 종료된 것을 확인했나요? 기록만 중단으로 정리합니다.'))return;await api('/projects/'+encodeURIComponent(project)+'/runs/'+attempt.run_id+(s.cancellable===false?'/reconcile':'/cancel'),'POST');await load(s.id);})),el('p','일반 대화의 실행 기록에서도 과정과 종료 상태를 확인할 수 있습니다.','hint'));
      function poll(){if(!dialog.open)return;if(locked){timer=setTimeout(poll,1500);return;}const top=dialog.scrollTop;safe(async()=>{await load(s.id);dialog.scrollTop=top;});}
      timer=setTimeout(poll,1500);return;
    }
    const form=el('form',undefined,'modal-form'),mode=modeSelect(step.mode),client=select(['codex','claude'],step.client),model=el('input'),instruction=el('textarea'),comment=el('textarea');model.value=step.model||'';model.placeholder='CLI 기본 모델';instruction.value=step.instruction;instruction.rows=4;instruction.required=true;instruction.maxLength=4000;comment.rows=3;comment.maxLength=2000;const draftKey=s.id+'/'+s.current;comment.value=parallelDrafts.get(draftKey)||'';comment.oninput=()=>parallelDrafts.set(draftKey,comment.value);
    form.append(el('h3',s.status==='ready'?'다음 작업 지시 확인':'검토와 수정'),field('실행 권한',mode),field('담당 AI',client),field('모델',model),field('작업 지시',instruction),field(s.status==='question'?'AI 질문에 대한 답변':'수정 대상과 의견',comment));
    if(s.status==='failed'&&!parallelDrafts.has(draftKey))comment.value=step.attempts.at(-1)?.comment||'';
    if(s.status==='question'){
      const question=step.attempts.at(-1)?.metadata?.question;
      if(question){const choices=el('div',undefined,'workflow-actions');form.append(el('p',question.question));for(const choice of question.choices||[])choices.append(button(choice,()=>{comment.value=choice;parallelDrafts.set(draftKey,choice);comment.focus();}));form.append(choices,el('p','선택한 답변을 수정하거나 직접 입력한 후 다시 실행하세요.','hint'));}
    }
    const preview=el('details'),pre=el('pre');preview.append(el('summary','다음 실행에 포함할 자료'),pre);pre.textContent=s.materials.map(m=>m.role+': '+m.id).concat(s.steps.slice(0,s.current).map(p=>p.title+' ,  승인 v'+p.approved)).join('\n')||'작업 지시만 전달합니다.';form.append(preview);
    const actions=el('div',undefined,'workflow-actions'),send=icon('send',s.status==='ready'?'현재 단계 실행':'의견을 반영해 다시 실행',()=>form.requestSubmit());send.disabled=step.attempts.at(-1)?.storage_status==='failed';actions.append(send);
    if(s.status==='review'&&step.attempts.at(-1)?.storage_status!=='failed')actions.append(icon('check','현재 결과 승인',()=>safe(async()=>{current=await api(endpoint()+'/'+s.id,'POST',{connection_id:binding.connection_id,expected_revision:s.revision,action:'approve',comment:comment.value});render();})));
    form.append(actions);body.append(form);
    form.onsubmit=e=>{e.preventDefault();safe(async()=>{current=await api(endpoint()+'/'+s.id,'POST',{connection_id:binding.connection_id,expected_revision:s.revision,action:'run',mode:mode.value,client:client.value,model:model.value.trim()||null,instruction:instruction.value,comment:comment.value});render();});};
  }
  const parallelDrafts=new Map();
  async function contentHash(text){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');}
  async function parallelSetup(){
    creationId=crypto.randomUUID().replaceAll('-','');body.replaceChildren();
    const form=el('form',undefined,'modal-form'),title=el('input'),choice=el('select'),preview=el('pre'),sources=[];title.required=true;title.maxLength=120;title.value='설계와 요구사항 테스트케이스';
    const docbase='/projects/'+encodeURIComponent(project)+'/document-vault/documents';
    const documents=await api(docbase+'?connection_id='+binding.connection_id);
    for(const summary of documents.documents){
      const doc=await api(docbase+'/'+summary.id+'?connection_id='+binding.connection_id);
      for(const review of doc.reviews.filter(r=>r.decision==='approved')){
        const snapshot=await api(docbase+'/'+doc.id+'/reviews/'+review.number+'?connection_id='+binding.connection_id);
        sources.push({label:doc.title+' / 승인 v'+review.number,content:snapshot.after.content,ref:{kind:'document',identity:doc.id,version:review.number,expected_revision:doc.revision,sha256:await contentHash(snapshot.after.content)}});
      }
    }
    for(const row of await api(endpoint()+'?connection_id='+binding.connection_id)){
      const flow=await api(endpoint()+'/'+row.id+'?connection_id='+binding.connection_id);if(flow.kind==='parallel')continue;
      for(const [i,step] of flow.steps.entries())if(step.approved){const content=step.attempts[step.approved-1].output;sources.push({label:flow.title+' / '+step.title+' / 승인 v'+step.approved,content,ref:{kind:'workflow',identity:flow.id,step:i,version:step.approved,expected_revision:flow.revision,sha256:await contentHash(content)}});}
    }
    for(const [i,source] of sources.entries()){const option=el('option',source.label);option.value=String(i);choice.append(option);}
    choice.onchange=()=>{preview.textContent=sources[Number(choice.value)]?.content||'';};choice.onchange();
    form.append(field('작업 이름',title),field('공통 승인 입력',choice),el('p','같은 승인 버전으로 Codex 두 세션이 설계 작성과 요구사항 기반 테스트케이스 정의를 동시에 수행합니다. 테스트케이스는 설계 결과를 기다리지 않으며 설계 결정이 필요한 조건을 미확정으로 표시합니다.','hint'),preview,el('p','읽기 전용으로 실행합니다. OS 수준의 완전한 격리 보장은 아닙니다. 저장 후 입력을 확인하고 실행하세요.','hint'));
    const save=icon('save','병렬 작업 저장',()=>form.requestSubmit());save.disabled=!sources.length;
    if(!sources.length)form.append(el('p','문서함에서 요구사항 또는 분석 결과를 검토, 승인하거나 순차 워크플로 결과를 먼저 승인하세요.','hint'));
    form.append(save,icon('back','워크플로 목록',()=>safe(listing)));body.append(form);
    form.onsubmit=e=>{e.preventDefault();safe(async()=>{const source=sources[Number(choice.value)];if(!source)throw Error('승인 입력을 선택하세요.');current=await api(endpoint()+'/parallel','POST',{connection_id:binding.connection_id,request_id:creationId,title:title.value,source:source.ref});render();});};
  }
  async function parallelAction(s,action,role,comment=''){
    await api(endpoint()+'/'+s.id+'/parallel','POST',{connection_id:binding.connection_id,expected_revision:s.revision,action,role,comment});await load(s.id);
  }
  function renderParallel(){
    clearTimeout(timer);body.replaceChildren();const s=current,tools=el('div',undefined,'workflow-actions');tools.append(el('h3',s.title),icon('back','워크플로 목록',()=>safe(listing)),icon('restore','워크플로 새로고침',()=>safe(()=>load(s.id))));body.append(tools,el('p',label(s.status),'hint'));
    const input=el('details');input.append(el('summary','공통 승인 입력: '+s.source.title+' / v'+s.source.version),el('p',s.source.identity+' / SHA-256 '+s.source.sha256,'hint'),consoleOutput(s.source.content));body.append(input,el('p',s.fixed_at?'시작 시 고정한 입력을 유지합니다. 원본이 변경돼도 재실행 입력을 자동 교체하지 않습니다.':'저장 후 원본이 변경되면 시작을 거절합니다. 입력을 다시 선택해 새 작업을 만드세요.','hint'));
    if(!s.fixed_at)body.append(icon('send','두 Codex 작업 동시 실행',()=>safe(()=>parallelAction(s,'start',null))));
    for(const [i,step] of s.steps.entries()){
      const card=el('section',undefined,'workflow-step modal-form');card.dataset.role=String(i);const stateLabel=el('p','● '+label(step.status),'parallel-state');stateLabel.dataset.state=step.status;card.append(el('h3',step.title),stateLabel);
      for(const attempt of step.attempts){
        const result=el('details',undefined,'workflow-result');result.open=attempt===step.attempts.at(-1);result.append(el('summary','v'+attempt.version+' / '+label(attempt.status)),consoleOutput(attempt.output||attempt.error||'결과를 기다리고 있습니다.'));
        if(attempt.output&&attempt.error)result.append(el('p',attempt.error,'hint'));
        result.append(el('p','실행 ID: '+attempt.run_id,'hint'));
        storageNotice(result,s,attempt);result.append(button('결과 상세 보기',()=>openResult(s,i,attempt.version)));
        const details=el('details');details.append(el('summary','이 실행의 입력, 지시, 실행 정보'),el('pre',JSON.stringify({inputs:attempt.inputs,directive:attempt.directive,comment:attempt.comment,approval_comment:attempt.approval_comment,metadata:attempt.metadata},null,2)));result.append(details);card.append(result);
      }
      if(step.status==='running'){
        const rid=step.attempts.at(-1).run_id,detached=step.cancellable===false;
        card.append(icon('close',detached?step.title+' 프로세스 종료 확인 후 기록 정리':step.title+' 실행 취소',()=>safe(async()=>{if(detached&&!confirm('해당 외부 프로세스가 종료된 것을 확인했나요? 이 작업의 기록만 정리합니다.'))return;await api('/projects/'+encodeURIComponent(project)+'/runs/'+rid+(detached?'/reconcile':'/cancel'),'POST');await load(s.id);})),el('p',detached?'현재 서버가 소유하지 않은 실행입니다. 자동으로 재실행하거나 완료 처리하지 않습니다.':'다른 작업의 상태와 관계없이 이 작업만 취소합니다.','hint'));
      }else if(s.fixed_at&&!step.approved){
        const key=s.id+'/'+i,comment=el('textarea');comment.rows=3;comment.maxLength=2000;comment.value=parallelDrafts.get(key)||'';comment.oninput=()=>parallelDrafts.set(key,comment.value);
        const question=step.attempts.at(-1)?.metadata?.question;
        if(step.status==='question'&&question){card.append(el('p',question.question));const choices=el('div',undefined,'workflow-actions');for(const value of question.choices||[])choices.append(button(value,()=>{comment.value=value;parallelDrafts.set(key,value);comment.focus();}));card.append(choices);}
        card.append(field(step.title+' 답변 또는 수정 의견',comment));
        const actions=el('div',undefined,'workflow-actions');const retry=icon('send',step.title+'만 다시 실행',()=>safe(async()=>{await parallelAction(s,'retry',i,comment.value);parallelDrafts.delete(key);}));retry.disabled=step.attempts.at(-1)?.storage_status==='failed';actions.append(retry);if(step.status==='review'&&step.attempts.at(-1)?.storage_status!=='failed')actions.append(icon('check',step.title+' 결과 승인',()=>safe(()=>parallelAction(s,'approve',i,comment.value))));card.append(actions);
      }
      body.append(card);
    }
    if(s.status==='done')body.append(icon('save','승인 산출물과 이력 내려받기',()=>safe(async()=>{const response=await fetch('/api'+endpoint()+'/'+s.id+'/export?connection_id='+binding.connection_id);if(!response.ok)throw Error('내려받기 실패');const url=URL.createObjectURL(await response.blob()),link=el('a');link.href=url;link.download=s.id+'.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);})));
    if(s.status==='running')timer=setTimeout(function poll(){if(!dialog.open)return;if(locked){timer=setTimeout(poll,1500);return;}const top=dialog.scrollTop;safe(async()=>{await load(s.id);dialog.scrollTop=top;});},1500);
  }
})();
