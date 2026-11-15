/* Shared per-file upload choices. Raw bytes stay in memory until commit. */
(()=>{
  const dialog=el('dialog',undefined,'session-drawer'),title=el('h2','파일별 첨부 방식'),list=el('div',undefined,'modal-form');
  dialog.id='attachment-mode-dialog';title.id='attachment-mode-title';dialog.setAttribute('aria-labelledby',title.id);
  const notice='원본 파일은 개인정보와 비밀 키를 가리지 않으며, 엑셀 시트와 열 선택도 적용하지 않습니다.';
  let finish=null,entries=[],choiceOwner=null;
  const accept=button('선택한 방식으로 첨부',()=>{const done=finish;finish=null;const result=entries.map(({file,select})=>({file,mode:select.value}));dialog.close();done?.(result);});
  accept.id='attachment-mode-confirm';
  dialog.append(title,el('p',notice+' 텍스트 변환을 선택하면 저장한 보호 설정을 적용합니다.','hint'),list,accept,button('취소',()=>dialog.close()));
  dialog.addEventListener('close',()=>{if(dialog.open)return;const done=finish;finish=null;entries=[];choiceOwner=null;list.replaceChildren();done?.([]);});document.body.append(dialog);
  const label=report=>!report?'확인 중':report.mode==='original'?'원본 파일':'텍스트 변환';
  async function choose(files,owner='chat'){
    if(finish)throw Error('첨부 방식을 선택 중입니다.');
    if(!files.length)return [];
    list.replaceChildren();
    choiceOwner=owner;entries=files.map(file=>{
      const row=el('div',undefined,'form-field'),name=el('label',file.name),select=el('select');
      select.id='attachment-mode-'+crypto.randomUUID();name.htmlFor=select.id;
      for(const [value,text] of [['original','원본 파일'],['text','텍스트 변환 (보호 설정 적용)']]){const option=el('option',text);option.value=value;select.append(option);}
      select.value='original';row.append(name,select);list.append(row);return {file,select};
    });
    const result=new Promise(resolve=>{finish=resolve;});dialog.showModal();return result;
  }
  async function download(base,id){
    const response=await fetch('/api'+base+'/materials/'+encodeURIComponent(id)+'/original');
    if(!response.ok){let error;try{error=await response.json();}catch{}throw Error(error?.detail||'원본 파일을 내려받지 못했습니다.');}
    const blob=await response.blob(),url=URL.createObjectURL(blob),link=el('a');link.href=url;
    link.download=/filename="([^"]+)"/.exec(response.headers.get('Content-Disposition')||'')?.[1]||'attachment';
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  window.attachmentFiles={choose,label,notice,download,cancelChoice:(owner='chat')=>{if(choiceOwner===owner&&finish)dialog.close();}};
})();
