/* Only selected extracted attachments pass this guard. Raw files never enter drafts. */
(()=>{
  const levels={strong:'강력',medium:'중간',low:'낮음',allow:'보호하지 않음 (키도 그대로 전송)'},
    kinds={secret:'비밀 키와 비밀번호',private_key:'인증용 개인 키',identity:'주민번호 등 식별정보',name:'이름',phone:'전화번호',email:'이메일',user_id:'사용자 ID'},
    actions={raw:'그대로 보냄',masked:'일부 가림',redacted:'전체 가림',blocked:'전송 차단',pseudonymized:'가상 값으로 변경'},
    privacyModes={replace:'완전 변경',partial:'일부 마스킹 (qwe***)',raw:'원본 그대로'};
  const privacyValue=prefs=>prefs.privacy_mode||(prefs.level==='medium'?'partial':['low','allow'].includes(prefs.level)?'raw':'replace');
  let project='',selected=new Set(),rows=[],options=null,generation=0,contextVersion=0,uploading=false;
  const page=el('section'),intro=el('p','첨부한 파일에서 개인정보와 비밀 키를 찾아 가립니다. 메시지, 이전 대화, 작업 규칙이나 에이전트가 직접 읽는 파일에는 적용되지 않습니다. 이미 보낸 정보는 이 설정을 바꿔도 되돌릴 수 없습니다.','hint');
  const badge=el('span',undefined,'hint'),toolbar=el('div',undefined,'attachment-toolbar'),chips=el('div',undefined,'attachment-chips');chips.id='attachment-chips';
  function icon(kind,label,fn){const b=button(label,fn);window.actionIcon(b,kind,label);return b;}
  $('text').closest('.command-entry').before(chips);$('action-hint').before(toolbar);
  const form=el('form',undefined,'modal-form'),levelLabel=el('label','비밀 키와 비밀번호'),level=el('select');level.id='guard-level';levelLabel.htmlFor=level.id;
  for(const [value,label] of Object.entries({strong:'가리기 (개인키 첨부 차단)',allow:'원본 그대로 전송'})){const opt=el('option',label);opt.value=value;level.append(opt);}
  const privacyLabel=el('label','개인정보 처리 방식'),privacy=el('select'),privacyHint=el('p',undefined,'hint');privacy.id='guard-privacy-mode';privacyLabel.htmlFor=privacy.id;
  for(const [value,label] of Object.entries(privacyModes)){const opt=el('option',label);opt.value=value;privacy.append(opt);}
  const warning=el('p',undefined,'hint'),fields=el('div',undefined,'modal-form');
  function fieldRow(value='',kind='name'){
    const row=el('div',undefined,'field-action-row'),input=el('input'),select=el('select');input.value=value;input.maxLength=60;input.placeholder='예: 담당자명';input.setAttribute('aria-label','보호할 열 또는 항목 이름');
    for(const [key,label] of Object.entries(kinds))if(key!=='private_key'){const option=el('option',label);option.value=key;select.append(option);}select.value=kind;select.setAttribute('aria-label','정보 유형');
    row.append(input,select,icon('trash','보호할 항목 삭제',()=>row.remove()));fields.append(row);
  }
  const save=icon('save','파일 보호 설정 저장',()=>form.requestSubmit());
  const saveStatus=el('p',undefined,'hint');saveStatus.id='guard-save-status';saveStatus.setAttribute('role','status');
  const excel=el('details'),excelBody=el('div',undefined,'modal-form'),sheetRows=el('div',undefined,'modal-form');sheetRows.id='guard-excel-sheets';let sheetSerial=0;
  function columnName(value){let label='';while(value){value--;label=String.fromCharCode(65+value%26)+label;value=Math.floor(value/26);}return label;}
  function sheetRow(value={sheet:1,columns:[]}){
    const row=el('div',undefined,'modal-form'),number=el('input'),columns=el('input');
    number.type='number';number.min='1';number.max='1000';number.required=true;number.value=value.sheet;number.dataset.sheet='';
    columns.value=(value.columns||[]).map(columnName).join(', ');columns.placeholder='예: A, C, D (비우면 모든 열)';columns.maxLength=5000;columns.dataset.columns='';
    const serial=++sheetSerial;
    for(const [input,title,key] of [[number,'시트 번호','sheet'],[columns,'보낼 열','columns']]){
      input.id='guard-excel-'+key+'-'+serial;
      const field=el('div',undefined,'form-field'),label=el('label',title);label.htmlFor=input.id;field.append(label);
      if(key==='sheet'){const line=el('div',undefined,'field-action-row');line.append(input,icon('trash','엑셀 시트 선택 삭제',()=>row.remove()));field.append(line);}else field.append(input);
      row.append(field);
    }
    sheetRows.append(row);
  }
  function excelSelection(){
    const seen=new Set();return Array.from(sheetRows.children).map(row=>{
      const sheet=Number(row.querySelector('[data-sheet]').value),text=row.querySelector('[data-columns]').value.trim();
      if(!Number.isInteger(sheet)||sheet<1||sheet>1000||seen.has(sheet))throw Error('시트 번호는 1부터 1000까지 중복 없이 입력하세요.');seen.add(sheet);
      const columns=text?text.split(',').map(item=>{const name=item.trim().toUpperCase();if(!/^[A-Z]{1,3}$/.test(name))throw Error('열은 A, C, D처럼 쉼표로 구분하세요. 범위 표기는 지원하지 않습니다.');const value=Array.from(name).reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);if(value>1000)throw Error('열은 A부터 ALL까지 지정할 수 있습니다.');return value;}):[];
      return {sheet,columns:Array.from(new Set(columns)).sort((a,b)=>a-b)};
    });
  }
  excel.append(el('summary','엑셀에서 보낼 시트와 열 선택'),excelBody);
  excelBody.append(el('p','이 프로젝트에 올리는 XLSX 파일에 적용합니다. 선택을 추가하지 않으면 숨기지 않은 모든 시트와 열을 읽습니다. 선택을 추가하면 지정한 시트와 열만 보냅니다. 시트 번호는 숨김 시트를 포함한 파일 안의 순서이며 1부터 시작합니다. 숨김 시트는 보낼 수 없습니다.','hint'),sheetRows,icon('plus','엑셀 시트 선택 추가',()=>{if(sheetRows.children.length<50)sheetRow({sheet:sheetRows.children.length+1,columns:[]});}),el('p','예: 시트 번호 1, 보낼 열 A, C. 선택한 셀에는 위 개인정보 처리 방식을 적용합니다. 첫 번째 행을 열 이름으로 사용하며 수식은 제외합니다. 다른 파일 형식에는 이 선택이 적용되지 않습니다. 설정을 저장한 후 파일을 첨부하세요.','hint'));
  form.append(privacyLabel,privacy,privacyHint,levelLabel,level,warning,el('p','추가로 가릴 항목이 있나요? 예를 들어 엑셀에 “담당자명” 열이 있다면, 아래에 담당자명을 입력하고 정보 유형을 이름으로 선택하세요. “담당자명: 홍길동”처럼 적힌 내용에도 적용됩니다.','hint'),fields,icon('plus','보호할 항목 추가',()=>{if(fields.children.length<30)fieldRow();}),excel,save);
  const picker=el('input');picker.type='file';picker.id='attachment-picker';picker.multiple=true;picker.accept='.txt,.md,.csv,.xlsx,.docx,.pptx';picker.hidden=true;
  const testLabel=el('label',undefined,'check'),test=el('input');test.type='checkbox';test.id='guard-test-data';testLabel.append(test,document.createTextNode('테스트용 자료로 표시 (보호 설정은 그대로 적용)'));
  const upload=icon('paperclip','파일 첨부',()=>{if(!project)throw Error('프로젝트를 선택하세요.');picker.click();});
  const hint=el('span','파일을 놓아 첨부','hint attachment-drop-hint');
  toolbar.append(upload,hint,badge,picker);
  const list=el('div');list.id='guard-materials';const error=el('p',undefined,'error');
  const saveRow=el('div',undefined,'field-action-row');saveRow.append(save,saveStatus);form.append(testLabel,saveRow);
  page.append(intro,form);
  const dialog=el('dialog',undefined,'session-drawer'),header=el('div',undefined,'account-dialog-header');dialog.id='attachment-dialog';dialog.setAttribute('aria-label','첨부 자료');
  header.append(el('h2','첨부 자료'),icon('close','첨부 자료 닫기',()=>dialog.close()));
  dialog.append(header,el('p','텍스트, Markdown, CSV, 엑셀, 워드, PowerPoint 파일을 지원합니다. 파일당 최대 8 MiB입니다. 아래에서 실제로 보낼 내용을 확인하세요. 보호 설정을 바꿨다면 파일을 다시 올려 주세요.','hint'),list);document.body.append(dialog);
  const historyDialog=el('dialog',undefined,'session-drawer'),historyHeader=el('div',undefined,'account-dialog-header'),historyTitle=el('h2'),historyInfo=el('p',undefined,'hint'),historyReport=el('div'),historyContent=el('pre');
  historyDialog.id='sent-attachment-dialog';historyDialog.setAttribute('aria-label','보낸 첨부 내용');let historyTicket=0;
  historyHeader.append(historyTitle,icon('close','보낸 첨부 닫기',()=>historyDialog.close()));
  historyDialog.append(historyHeader,historyInfo,historyReport,historyContent);document.body.append(historyDialog);
  historyDialog.addEventListener('close',()=>{historyTicket++;});
  async function openHistory(report,audit,b){
    const ticket=++historyTicket,owner=contextVersion;
    historyTitle.textContent=report.label;historyContent.textContent='첨부 내용을 불러오는 중…';
    historyInfo.textContent='이 요청에 첨부한 가공본입니다. 원본 파일은 보관하지 않습니다. '+(audit.state==='dispatch_attempted'?'에이전트 전달을 시도한 자료입니다.':'실행 준비 시 연결한 자료이며 전달 여부는 확인되지 않았습니다.');
    historyReport.replaceChildren(reportCard(report));if(!historyDialog.open)historyDialog.showModal();
    try{const result=await api(b+'/materials/'+encodeURIComponent(report.id));
      if(ticket===historyTicket&&owner===contextVersion&&historyDialog.open)historyContent.textContent=result.content||'표시할 내용이 없습니다.';
    }catch(e){if(ticket===historyTicket&&owner===contextVersion&&historyDialog.open)historyContent.textContent='첨부 내용을 불러오지 못했습니다. 자료가 삭제되었거나 서버에 연결할 수 없습니다. 닫은 뒤 다시 열어 주세요.';}
  }
  error.setAttribute('role','status');$('composer').append(error);
  window.settingsPage.register('materials','첨부 파일 보호',page);
  function url(){if(!project)throw Error('프로젝트를 선택하세요.');return '/projects/'+encodeURIComponent(project);}
  function describe(){
    privacyHint.textContent=privacy.value==='replace'?'찾은 개인정보를 원문이 드러나지 않는 가상 값으로 바꿉니다. 같은 프로젝트에서는 같은 값이 파일이나 시트가 달라도 동일하게 바뀝니다. 전화번호나 이름의 원래 형식은 유지하지 않습니다.':privacy.value==='partial'?'찾은 개인정보의 앞부분을 최대 세 글자 남기고 나머지를 ***로 가립니다. 예: qwerty → qwe***. 짧은 값도 최소 한 글자는 가립니다.':'찾은 개인정보를 가리지 않고 저장하고 전달합니다. 비밀 키와 비밀번호는 아래 설정을 따릅니다.';
    if(options&&!options.privacy_mode)privacyHint.textContent+=' 현재 저장된 설정은 이전 '+levels[options.level]+' 방식입니다. 저장하면 위에서 선택한 새 방식으로 적용합니다.';
    privacyHint.classList.toggle('error',privacy.value==='raw');
    warning.textContent=level.value==='allow'?'비밀 키와 비밀번호도 원본 그대로 저장하고 전달합니다. 개인정보는 위에서 선택한 방식으로 처리합니다.':'찾은 비밀 키와 비밀번호는 가립니다. 인증용 개인 키가 있는 첨부는 차단합니다. 개인정보 처리 방식과 별도로 적용합니다.';
    warning.classList.toggle('error',level.value==='allow');
  }
  level.onchange=describe;privacy.onchange=describe;
  function policyLabel(prefs){return prefs.privacy_mode?'개인정보: '+privacyModes[prefs.privacy_mode]+', 키: '+(prefs.level==='allow'?'원본':'가림'):levels[prefs.level];}
  function reportCard(report){
    const detail=el('details');detail.append(el('summary',report.label+', '+policyLabel(report)+', '+(report.status==='blocked'?'차단':report.stale?'다시 첨부해 주세요':'검사 완료')));
    detail.append(el('p',report.rule_version+(report.test_data?', 테스트용 자료':''),'hint'));
    const counts=new Map();for(const f of report.findings){const key=f.location+': '+kinds[f.kind]+' ('+actions[f.action]+')';counts.set(key,(counts.get(key)||0)+f.count);}
    detail.append(el('pre',Array.from(counts,([key,count])=>key+' '+count+'건').join('\n')||'가릴 정보를 찾지 못했습니다. 놓친 개인정보가 없는지 전송할 내용을 확인해 주세요.'));
    if(report.omissions?.length)detail.append(el('p',report.omissions.join(' / '),'hint'));
    return detail;
  }
  function render(){
    badge.textContent=options?.level==='allow'&&!options.privacy_mode?'보호 꺼짐: 키도 그대로 보냅니다':options?'파일 보호: '+policyLabel(options):'파일 보호 설정을 확인해 주세요';badge.classList.toggle('error',options?.level==='allow'||options?.privacy_mode==='raw');badge.hidden=!selected.size&&options?.level!=='allow'&&options?.privacy_mode!=='raw';
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
      options=prefs;rows=result.materials;test.checked=!!prefs.test_data;level.value=prefs.level==='allow'?'allow':'strong';privacy.value=privacyValue(prefs);fields.replaceChildren();for(const item of prefs.fields||[])fieldRow(item.field,item.kind);sheetRows.replaceChildren();for(const item of prefs.excel_sheets||[])sheetRow(item);describe();render();return true;
    }catch(e){if(g===generation){options=null;rows=[];render();error.textContent=e.message;}return false;}
  }
  form.onsubmit=e=>{e.preventDefault();if(save.disabled)return;act(async()=>{const b=url(),g=generation;
    save.disabled=true;saveStatus.classList.remove('error');saveStatus.textContent='저장 중…';
    try{
    const extra=Array.from(fields.children).map(row=>({field:row.querySelector('input').value.trim(),kind:row.querySelector('select').value}));
    await api(b+'/guard','PUT',{level:level.value,privacy_mode:privacy.value,test_data:test.checked,fields:extra,excel_sheets:excelSelection()});if(g!==generation)return;
    const owner=contextVersion,loaded=await refresh();if(owner!==contextVersion)return;
    saveStatus.textContent=loaded?'파일 보호 설정을 저장했습니다. 다음에 첨부하는 파일부터 적용됩니다.':'저장은 완료됐지만 결과를 다시 불러오지 못했습니다. 화면을 새로고침해 주세요.';
    notice(saveStatus.textContent);
    }catch(e){if(g===generation){saveStatus.textContent=e.message;saveStatus.classList.add('error');}throw e;}finally{save.disabled=false;}
  });};
  let uploadController=null;
  const progress=el('div',undefined,'attachment-progress field-action-row'),progressText=el('span');
  progress.id='attachment-progress';progress.hidden=true;progressText.setAttribute('role','status');
  const cancelUpload=icon('close','첨부 처리 취소',()=>{uploadController?.abort();cancelUpload.disabled=true;progressText.textContent='취소 중…';});
  progress.append(progressText,cancelUpload);toolbar.after(progress);
  async function uploadFiles(files){
    if(!files.length)return;
    if(uploading)throw Error('현재 첨부 자료를 검사 중입니다.');
    const b=url(),owner=contextVersion;
    if(files.length+selected.size>10)throw Error('자료는 최대 10개 첨부할 수 있습니다.');
    uploading=true;upload.disabled=true;error.textContent='';progress.hidden=false;let completed=0;
    try{
      for(const [index,file] of files.entries()){
        if(owner!==contextVersion)break;
        uploadController=new AbortController();const controller=uploadController;cancelUpload.disabled=false;
        progressText.textContent=(index+1)+' / '+files.length+' 파일 전달 및 검사 중…';
        try{
          if(file.size>8*1024*1024)throw Error('파일은 8 MiB 이하만 지원합니다.');
          const response=await fetch('/api'+b+'/material-preparations?filename='+encodeURIComponent(file.name)+'&test_data='+test.checked,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file,signal:controller.signal});
          const prepared=await response.json();if(!response.ok)throw Error(typeof prepared.detail==='string'?prepared.detail:'자료 업로드에 실패했습니다.');
          if(controller.signal.aborted||owner!==contextVersion){await api(b+'/material-preparations/'+prepared.token,'DELETE');break;}
          cancelUpload.disabled=true;progressText.textContent=(index+1)+' / '+files.length+' 검사 완료, 저장 중…';
          const result=await api(b+'/material-preparations/'+prepared.token+'/commit','POST');
          completed++;
          if(owner!==contextVersion)break;
          await refresh();if(owner!==contextVersion)break;
          const current=rows.find(row=>row.id===result.id);
          if(current?.status==='ready'&&!current.stale){if(selected.size>=10)throw Error('자료는 보관했지만 첨부 한도 10개에 도달했습니다. 기존 첨부를 제거하세요.');selected.add(result.id);render();window.chatState.save();error.textContent='';}
          else{error.textContent=current?.status==='blocked'?'개인키가 포함된 자료를 차단했습니다. 해당 정보를 제거한 파일로 다시 첨부하세요.':'보호 설정이 바뀌었거나 검사 결과를 불러오지 못했습니다. 파일을 다시 첨부해 주세요.';break;}
        }catch(e){if(owner===contextVersion)error.textContent=controller.signal.aborted?'첨부 처리를 취소했습니다. 이미 완료한 '+completed+'개 파일은 유지합니다.':e.message;break;}
      }
    }finally{uploadController=null;uploading=false;upload.disabled=false;progress.hidden=true;}
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
  window.materialGuard={historyAttachments(audit,b){const attachments=el('div',undefined,'attachment-chips sent-attachments');attachments.setAttribute('aria-label','이 메시지의 첨부');
      for(const report of audit.materials||[]){const chip=el('div',undefined,'attachment-chip'),open=icon('file',report.label+' 내용 보기',()=>openHistory(report,audit,b));chip.append(open,button(report.label,()=>openHistory(report,audit,b),'attachment-title'));attachments.append(chip);}return attachments;},
    consumed(ids){for(const id of ids)selected.delete(id);render();},selected:()=>Array.from(selected),isUploading:()=>uploading,restore(name,ids){uploadController?.abort();contextVersion++;dialog.close();historyDialog.close();historyTicket++;error.textContent='';saveStatus.textContent='';project=name;selected=new Set(ids);options=null;rows=[];render();if(name)void refresh();else generation++;},
    auditCard(audit){const card=el('details');card.append(el('summary','첨부 파일 보호 내역'+((audit.materials||[]).some(r=>r.level==='allow')?', 비밀 키 원본 전송':'')+', '+(audit.state==='dispatch_attempted'?'전달 시도':'실행 준비')));for(const report of audit.materials||[])card.append(reportCard(report));return card;}};
  describe();
})();
