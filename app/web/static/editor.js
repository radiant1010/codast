(()=>{
  let paths=[],loadedPath='',loadedText='',ticket=0,saving=false;
  const dialog=$('document-panel');
  function dirty(){return loadedText!==$('content').value;}
  function report(message,error=false){$('editor-status').textContent=message;$('editor-status').classList.toggle('error',error);}
  function mayDiscard(){return !dirty()||confirm('저장하지 않은 문서 수정이 있습니다. 수정을 버리고 계속할까요?');}
  function show(){base();$('editor-project').textContent=$('project').value+' · 파일 열기는 참고자료 첨부 선택을 바꾸지 않습니다.';if(!dialog.open)dialog.showModal();}
  function draw(){
    $('editor-tree').replaceChildren();const query=$('editor-filter').value.toLowerCase(),markdown=$('markdown-only').checked;
    const visible=paths.filter(path=>(!markdown||/\.(md|markdown)$/i.test(path))&&path.toLowerCase().includes(query));
    const folders=new Map([['',$('editor-tree')]]);
    for(const path of visible){const parts=path.split('/');let key='',parent=$('editor-tree');for(const part of parts.slice(0,-1)){key+=(key?'/':'')+part;if(!folders.has(key)){const folder=el('details'),summary=el('summary',part);folder.open=true;folder.append(summary);parent.append(folder);folders.set(key,folder);}parent=folders.get(key);}
      const entry=button(parts.at(-1),async()=>window.openDocument(path));entry.title=path;entry.className='editor-file'+(path===loadedPath?' selected':'');if(path===loadedPath)entry.setAttribute('aria-current','page');parent.append(entry);
    }
    if(!visible.length)$('editor-tree').append(el('p','표시할 문서가 없습니다. 필터를 바꾸거나 경로를 입력해 새 문서를 저장하세요.','hint'));
  }
  window.setEditorFiles=value=>{paths=value;draw();};
  window.resetEditor=()=>{ticket++;loadedPath='';loadedText='';paths=[];draw();report('문서를 선택하세요.');};
  window.openDocument=async path=>{
    show();if(saving||!mayDiscard())return;$('content').value=loadedText;
    const b=base(),request=++ticket;report('문서를 읽고 있습니다…');
    try{const data=await api(b+'/file?path='+encodeURIComponent(path));if(!valid(b)||request!==ticket)return;loadedPath=path;$('path').value=path;$('content').value=data.content;loadedText=$('content').value;draw();report(path+' · 불러옴');}
    catch(error){report(error.message,true);}
  };
  async function save(){
    if(saving)return;const b=base(),path=$('path').value.trim(),content=$('content').value;
    if(!path){report('저장할 상대 경로를 입력하세요.',true);return;}
    if(new TextEncoder().encode(content).length>65536){report('파일은 UTF-8 기준 64 KiB까지 저장할 수 있습니다.',true);return;}
    if(loadedPath&&path!==loadedPath){report('현재 문서 경로를 바꾸어 덮어쓰지 않도록, 먼저 열기로 대상 파일을 확인하세요.',true);return;}
    saving=true;$('write').disabled=true;
    try{
      let latest;try{latest=await api(b+'/file?path='+encodeURIComponent(path));}catch(error){if(error.status!==404||loadedPath)throw error;}
      if(!loadedPath&&latest){report('같은 경로에 파일이 있습니다. 먼저 열어서 확인하세요.',true);return;}
      if(latest&&latest.content.replace(/\r\n?/g,'\n')!==loadedText){report('다른 작업에서 파일이 변경되었습니다. 수정 내용을 복사해 두고 다시 열어 비교하세요.',true);return;}
      await api(b+'/file','PUT',{path,content});if(!valid(b))return;loadedPath=path;loadedText=content;report(path+' · 저장됨');await filesAndRules(b);
    }catch(error){report(error.message,true);}finally{saving=false;$('write').disabled=false;}
  }
  function close(){if(!saving&&mayDiscard()){ticket++;$('content').value=loadedText;dialog.close();}}
  $('new-document').onclick=()=>{if(saving||!mayDiscard())return;ticket++;loadedPath='';loadedText='';$('path').value='';$('content').value='';draw();report('새 문서 · 경로와 내용을 입력하고 저장하세요.');$('path').focus();};
  $('open-editor').onclick=()=>act(async()=>{show();await filesAndRules();});
  $('close-editor').onclick=close;dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  $('read').onclick=()=>act(()=>window.openDocument($('path').value.trim()));$('write').onclick=()=>act(save);
  $('content').oninput=()=>report(dirty()?'수정됨 · 아직 저장하지 않았습니다.':loadedPath+' · 변경 없음');
  dialog.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();act(save);}});
  $('editor-filter').oninput=draw;$('markdown-only').onchange=draw;
})();
