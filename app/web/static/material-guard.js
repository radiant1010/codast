/* Only selected extracted attachments pass this guard. Raw files never enter drafts. */
(()=>{
  const levels={strong:'강력',medium:'중간',low:'낮음',allow:'보호하지 않음 (키도 그대로 전송)'},
    kinds={secret:'비밀 키와 비밀번호',private_key:'인증용 개인 키',identity:'주민번호 등 식별정보',name:'이름',phone:'전화번호',email:'이메일',user_id:'사용자 ID'},
    actions={raw:'그대로 보냄',masked:'일부 가림',redacted:'전체 가림',blocked:'전송 차단'};
  let project='',selected=new Set(),rows=[],options=null,generation=0,contextVersion=0,uploading=false;
  const page=el('section'),intro=el('p','첨부한 파일에서 개인정보와 비밀 키를 찾아 가립니다. 메시지, 이전 대화, 작업 규칙이나 에이전트가 직접 읽는 파일에는 적용되지 않습니다. 이미 보낸 정보는 이 설정을 바꿔도 되돌릴 수 없습니다.','hint');
  const badge=el('span',undefined,'hint'),toolbar=el('div',undefined,'attachment-toolbar'),chips=el('div',undefined,'attachment-chips');chips.id='attachment-chips';
  function icon(kind,label,fn){const b=button(label,fn);window.actionIcon(b,kind,label);return b;}
  $('text').closest('.command-entry').before(chips);$('action-hint').before(toolbar);
  const form=el('form',undefined,'modal-form'),levelLabel=el('label','보호 수준'),level=el('select');level.id='guard-level';levelLabel.htmlFor=level.id;
  for(const [value,label] of Object.entries(levels)){const opt=el('option',label);opt.value=value;level.append(opt);}
  const warning=el('p',undefined,'hint'),fields=el('div',undefined,'modal-form');
  function fieldRow(value='',kind='name'){
    const row=el('div',undefined,'field-action-row'),input=el('input'),select=el('select');input.value=value;input.maxLength=60;input.placeholder='예: 담당자명';input.setAttribute('aria-label','보호할 열 또는 항목 이름');
    for(const [key,label] of Object.entries(kinds))if(key!=='private_key'){const option=el('option',label);option.value=key;select.append(option);}select.value=kind;select.setAttribute('aria-label','정보 유형');
    row.append(input,select,icon('trash','보호할 항목 삭제',()=>row.remove()));fields.append(row);
  }
  const save=icon('save','파일 보호 설정 저장',()=>form.requestSubmit());
  form.append(levelLabel,level,warning,el('p','추가로 가릴 항목이 있나요? 예를 들어 엑셀에 “담당자명” 열이 있다면, 아래에 담당자명을 입력하고 정보 유형을 이름으로 선택하세요. “담당자명: 홍길동”처럼 적힌 내용에도 적용됩니다.','hint'),fields,icon('plus','보호할 항목 추가',()=>{if(fields.children.length<30)fieldRow();}),save);
  const picker=el('input');picker.type='file';picker.id='attachment-picker';picker.multiple=true;picker.accept='.txt,.md,.csv,.xlsx,.docx,.pptx';picker.hidden=true;
  const testLabel=el('label',undefined,'check'),test=el('input');test.type='checkbox';test.id='guard-test-data';testLabel.append(test,document.createTextNode('테스트용 자료로 표시 (보호 설정은 그대로 적용)'));
  const upload=icon('paperclip','파일 첨부',()=>{if(!project)throw Error('프로젝트를 선택하세요.');picker.click();});
  const hint=el('span','파일을 놓아 첨부','hint attachment-drop-hint');
  toolbar.append(upload,hint,badge,picker);
  const list=el('div');list.id='guard-materials';const error=el('p',undefined,'error');
  page.append(intro,form,testLabel);
  const dialog=el('dialog',undefined,'session-drawer'),header=el('div',undefined,'account-dialog-header');dialog.id='attachment-dialog';dialog.setAttribute('aria-label','첨부 자료');
  header.append(el('h2','첨부 자료'),icon('close','첨부 자료 닫기',()=>dialog.close()));
  dialog.append(header,el('p','텍스트, Markdown, CSV, 엑셀, 워드, PowerPoint 파일을 지원합니다. 파일당 최대 8 MiB입니다. 아래에서 실제로 보낼 내용을 확인하세요. 보호 설정을 바꿨다면 파일을 다시 올려 주세요.','hint'),list);document.body.append(dialog);
  error.setAttribute('role','status');$('composer').append(error);
  window.settingsPage.register('materials','첨부 파일 보호',page);
  function url(){if(!project)throw Error('프로젝트를 선택하세요.');return '/projects/'+encodeURIComponent(project);}
  function describe(){
    warning.textContent=level.value==='allow'?'개인정보와 비밀 키를 가리지 않습니다. 파일에서 읽은 내용은 이 컴퓨터에 그대로 저장되며, 메시지를 보내면 에이전트에도 전달됩니다.':level.value==='low'?'찾은 비밀 키, 비밀번호와 주민번호 등 식별정보는 모두 가립니다. 이름, 연락처와 사용자 ID는 그대로 보냅니다.':level.value==='medium'?'찾은 비밀 키, 비밀번호와 주민번호 등 식별정보는 모두 가립니다. 이름, 연락처와 사용자 ID는 일부만 보여 줍니다. 예: 홍*동, 010-****-2324.':'찾은 개인정보와 비밀 키를 모두 가립니다. 인증용 개인 키가 들어 있는 파일은 보내지 않습니다. 놓치는 정보가 있을 수 있으니 첨부한 파일을 눌러 전송할 내용을 확인해 주세요.';
    warning.classList.toggle('error',level.value==='allow');
  }
  level.onchange=describe;
  function reportCard(report){
    const detail=el('details');detail.append(el('summary',report.label+', '+levels[report.level]+', '+(report.status==='blocked'?'차단':report.stale?'다시 첨부해 주세요':'검사 완료')));
    detail.append(el('p',report.rule_version+(report.test_data?', 테스트용 자료':''),'hint'));
    const counts=new Map();for(const f of report.findings){const key=f.location+': '+kinds[f.kind]+' ('+actions[f.action]+')';counts.set(key,(counts.get(key)||0)+f.count);}
    detail.append(el('pre',Array.from(counts,([key,count])=>key+' '+count+'건').join('\n')||'가릴 정보를 찾지 못했습니다. 놓친 개인정보가 없는지 전송할 내용을 확인해 주세요.'));
    if(report.omissions?.length)detail.append(el('p',report.omissions.join(' / '),'hint'));
    return detail;
  }
  function render(){
    badge.textContent=options?.level==='allow'?'보호 꺼짐: 키도 그대로 보냅니다':options?'파일 보호: '+levels[options.level]:'파일 보호 설정을 확인해 주세요';badge.classList.toggle('error',options?.level==='allow');badge.hidden=!selected.size&&options?.level!=='allow';
    chips.replaceChildren();
    for(const id of selected){const row=rows.find(r=>r.id===id),chip=el('div',undefined,'attachment-chip');
      const title=row?.label||'첨부 자료',state=row?.stale?', 다시 첨부해 주세요':row?.status==='blocked'?', 차단':'';
      const show=button(title+state,()=>{dialog.showModal();const detail=document.getElementById('material-'+id);if(detail){detail.open=true;detail.scrollIntoView({block:'nearest'});}});
      show.className='attachment-title';chip.append(show,icon('close',title+' 첨부 제거',()=>{selected.delete(id);render();window.chatState.save();}));chips.append(chip);
    }
    list.replaceChildren();for(const row of rows.filter(row=>selected.has(row.id))){
      const card=el('article',undefined,'message');
      const detail=reportCard(row),preview=el('pre');detail.id='material-'+row.id;
      card.append(detail,icon('file','전송할 내용 보기',async()=>{const b=url(),g=generation;const result=await api(b+'/materials/'+row.id);if(g===generation)preview.textContent=result.content||'차단되어 전달할 내용이 없습니다.';}),preview);list.append(card);
    }
  }

  async function refresh(){
    const b=url(),g=++generation;error.textContent='';
    try{const [prefs,result]=await Promise.all([api(b+'/guard'),api(b+'/materials')]);if(g!==generation)return;
      if(!levels[prefs.level]||!Array.isArray(result.materials))throw Error('파일 보호 설정을 불러오지 못했습니다.');
      options=prefs;rows=result.materials;level.value=prefs.level;fields.replaceChildren();for(const item of prefs.fields||[])fieldRow(item.field,item.kind);describe();render();
    }catch(e){if(g===generation){options=null;rows=[];render();error.textContent=e.message;}}
  }
  form.onsubmit=e=>{e.preventDefault();act(async()=>{const b=url(),g=generation;
    const extra=Array.from(fields.children).map(row=>({field:row.querySelector('input').value.trim(),kind:row.querySelector('select').value}));
    await api(b+'/guard','PUT',{level:level.value,fields:extra});if(g!==generation)return;await refresh();notice('파일 보호 설정을 저장했습니다. 이전에 첨부한 파일은 바뀐 설정을 적용하려면 다시 올려 주세요.');});};
  async function uploadFiles(files){
    if(!files.length)return;
    if(uploading)throw Error('현재 첨부 자료를 검사 중입니다.');
    const b=url(),owner=contextVersion;
    if(files.length+selected.size>10)throw Error('자료는 최대 10개 첨부할 수 있습니다.');
    uploading=true;upload.disabled=true;error.textContent='첨부 자료 검사 중…';
    try{
      for(const file of files){
        if(owner!==contextVersion)break;
        try{
          if(file.size>8*1024*1024)throw Error('파일은 8 MiB 이하만 지원합니다.');
          const response=await fetch('/api'+b+'/materials?filename='+encodeURIComponent(file.name)+'&test_data='+test.checked,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
          const result=await response.json();if(!response.ok)throw Error(typeof result.detail==='string'?result.detail:'자료 업로드에 실패했습니다.');
          if(owner!==contextVersion)break;
          await refresh();if(owner!==contextVersion)break;
          const current=rows.find(row=>row.id===result.id);
          if(current?.status==='ready'&&!current.stale){if(selected.size>=10)throw Error('자료는 보관했지만 첨부 한도 10개에 도달했습니다. 기존 첨부를 제거하세요.');selected.add(result.id);render();window.chatState.save();error.textContent='';}
          else{error.textContent=current?.status==='blocked'?'개인키가 포함된 자료를 차단했습니다. 해당 정보를 제거한 파일로 다시 첨부하세요.':'보호 설정이 바뀌었거나 검사 결과를 불러오지 못했습니다. 파일을 다시 첨부해 주세요.';break;}
        }catch(e){if(owner===contextVersion)error.textContent=e.message;break;}
      }
    }finally{uploading=false;upload.disabled=false;}
  }
  picker.onchange=()=>{const files=Array.from(picker.files);picker.value='';act(()=>uploadFiles(files));};
  const composer=$('composer');let dragDepth=0;
  const hasFiles=event=>Array.from(event.dataTransfer?.types||[]).includes('Files');
  composer.addEventListener('dragenter',event=>{if(!hasFiles(event))return;event.preventDefault();dragDepth++;composer.classList.add('attachment-dragover');});
  composer.addEventListener('dragover',event=>{if(!hasFiles(event))return;event.preventDefault();event.dataTransfer.dropEffect=uploading?'none':'copy';});
  composer.addEventListener('dragleave',event=>{if(!hasFiles(event))return;if(--dragDepth<=0){dragDepth=0;composer.classList.remove('attachment-dragover');}});
  composer.addEventListener('drop',event=>{if(!hasFiles(event))return;event.preventDefault();dragDepth=0;composer.classList.remove('attachment-dragover');act(()=>uploadFiles(Array.from(event.dataTransfer.files)));});
  // Dropping outside the input must not navigate away and lose the draft.
  document.addEventListener('dragover',event=>{if(hasFiles(event))event.preventDefault();});
  document.addEventListener('drop',event=>{if(hasFiles(event))event.preventDefault();});
  window.materialGuard={selected:()=>Array.from(selected),isUploading:()=>uploading,restore(name,ids){contextVersion++;dialog.close();error.textContent='';project=name;selected=new Set(ids);options=null;rows=[];render();if(name)void refresh();else generation++;},
    auditCard(audit){const card=el('details');card.append(el('summary','첨부 파일 보호 내역'+((audit.materials||[]).some(r=>r.level==='allow')?', 보호하지 않고 전송':'')+', '+(audit.state==='dispatch_attempted'?'전달 시도':'실행 준비')));for(const report of audit.materials||[])card.append(reportCard(report));return card;}};
  describe();
})();
