/* Search stored conversation text without running an agent. */
(()=>{
  const labels={codast:'CODAST',codex:'Codex',claude:'Claude'};
  const dialog=el('dialog',undefined,'session-drawer session-search');dialog.id='session-search';
  const header=el('header',undefined,'account-dialog-header'),heading=el('h2','이전 대화 검색');heading.id='session-search-title';
  dialog.setAttribute('aria-labelledby',heading.id);
  const close=button('',()=>dialog.close());window.actionIcon(close,'close','이전 대화 검색 닫기');header.append(heading,close);
  const scope=el('p',undefined,'hint'),form=el('form',undefined,'session-search-form');
  const input=el('input',undefined,'form-control');input.id='session-search-query';input.type='search';input.maxLength=200;input.placeholder='대화 내용으로 검색';input.setAttribute('aria-label','대화 검색어');
  const submit=el('button','검색');submit.type='submit';
  const refresh=button('기록 새로 읽기',async()=>{await updateIndex();});
  const status=el('p',undefined,'hint');status.id='session-search-status';status.setAttribute('role','status');
  const results=el('div');results.id='session-search-results';
  const pages=el('div',undefined,'action-row');
  const previous=button('앞 검색 결과',async()=>{resultOffset=Math.max(0,resultOffset-40);await search();});
  const next=button('다음 검색 결과',async()=>{resultOffset+=40;await search();});pages.append(previous,next);pages.hidden=true;
  const preview=el('section');preview.id='session-search-preview';preview.hidden=true;
  form.append(input,submit,refresh);dialog.append(header,scope,form,status,results,pages,preview);document.body.append(dialog);
  let project='',resultOffset=0,ticket=0,previewTicket=0,poll,debounce;
  const endpoint=()=>'/projects/'+encodeURIComponent(project)+'/session-search';
  const current=(selected,generation)=>dialog.open&&project===selected&&$('project').value===selected&&ticket===generation;
  function highlight(node,text){
    const terms=[...new Set(input.value.trim().split(/\s+/).filter(Boolean))].sort((a,b)=>b.length-a.length);
    if(!terms.length){node.textContent=text;return;}
    const pattern=new RegExp(terms.map(term=>term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'gi');
    let end=0;
    for(const match of text.matchAll(pattern)){node.append(document.createTextNode(text.slice(end,match.index)),el('mark',match[0]));end=match.index+match[0].length;}
    node.append(document.createTextNode(text.slice(end)));
  }
  async function search(){
    clearTimeout(poll);const selected=project,generation=++ticket;
    try{
      const data=await api(endpoint()+'?q='+encodeURIComponent(input.value)+'&offset='+resultOffset);
      if(!current(selected,generation))return;
      const info=data.status;refresh.disabled=info.indexing;
      status.textContent=(info.indexing?'기록을 읽는 중, 준비된 내용부터 검색합니다. ':info.updated_at?'기록 확인: '+new Date(info.updated_at).toLocaleString()+'. ':'아직 읽은 기록이 없습니다. ')+
        info.sessions+'개 세션. '+info.errors.map(error=>labels[error.source]+': '+error.message).join(' ');
      results.replaceChildren();
      for(const hit of data.results){
        const row=el('article',undefined,'session-search-result');
        row.append(el('p',labels[hit.source]+' / '+hit.title+' / '+(hit.role==='user'?'사용자':'답변'),'hint'));
        const excerpt=el('pre');highlight(excerpt,hit.snippet);
        row.append(excerpt,button('대화 보기',()=>showContext(hit)));results.append(row);
      }
      if(!data.results.length)results.append(el('p',input.value.trim()?'일치하는 대화가 없습니다.':'기억나는 단어나 문장을 입력하세요.','hint'));
      pages.hidden=!resultOffset&&!data.has_more;previous.disabled=!resultOffset;next.disabled=!data.has_more;
      if(info.indexing)poll=setTimeout(()=>act(search),1500);
    }catch(error){if(current(selected,generation)){status.textContent='검색 실패: '+error.message;refresh.disabled=false;}}
  }
  async function updateIndex(){
    const selected=project;refresh.disabled=true;status.textContent='저장된 대화를 읽는 중…';
    try{await api(endpoint()+'/refresh','POST');if(dialog.open&&project===selected)await search();}
    catch(error){if(dialog.open&&project===selected){status.textContent='기록 조회 실패: '+error.message;refresh.disabled=false;}}
  }
  async function showContext(hit,pageOffset){
    const selected=project,generation=++previewTicket;
    preview.hidden=false;preview.replaceChildren(el('p','대화를 불러오는 중…','hint'));
    try{
      const data=await api(endpoint()+'/'+hit.key+(pageOffset===undefined?'':'?offset='+pageOffset));
      if(!dialog.open||project!==selected||$('project').value!==selected||previewTicket!==generation)return;
      preview.replaceChildren(el('h3',labels[data.source]+' / '+data.title));
      const actions=el('div',undefined,'action-row');
      if(data.destination?.task){
        actions.append(button('이 채팅으로 이동',async()=>{
          if($('project').value!==selected)throw Error('프로젝트가 변경되었습니다. 다시 검색하세요.');
          if(!await switchChat(data.destination.task))return;
          if($('project').value!==selected)return;
          const b=base(),generation=epoch;offset=data.destination.offset;await conversation(b);
          if(!valid(b,generation))return;
          const card=[...$('messages').querySelectorAll('.message')].find(node=>node.dataset.messageId===data.destination.message_id);
          if(!card)throw Error('대화 위치가 변경되었습니다. 기록을 새로 읽어 다시 검색하세요.');
          dialog.close();card.tabIndex=-1;card.classList.add('search-target');card.focus();card.scrollIntoView({block:'center'});window.chatState.save();
        }));
      }else if(data.source!=='codast'){
        actions.append(button('이 세션 연결하기',async()=>{
          dialog.close();await window.openStoredSession(data.source,{id:data.identity,name:data.title},selected);
        }));
      }
      const older=button('앞 대화',()=>showContext(hit,Math.max(0,data.offset-20))),newer=button('뒤 대화',()=>showContext(hit,data.offset+20));
      older.disabled=data.offset===0;newer.disabled=!data.has_more;actions.append(older,newer);preview.append(actions);
      preview.append(el('p','색인에 저장된 대화입니다. 최신 내용을 확인하려면 기록을 새로 읽어 주세요.','hint'));
      for(const message of data.messages){
        const row=el('article',undefined,'session-search-message');row.dataset.ordinal=message.ordinal;
        row.classList.toggle('search-target',message.ordinal===data.ordinal);
        row.append(el('strong',(message.role==='user'?'사용자':'답변')+(message.ordinal===data.ordinal?' / 검색한 메시지':'')));
        const body=el('pre');highlight(body,message.text);row.append(body);preview.append(row);
      }
      const target=preview.querySelector('.search-target')||preview;target.tabIndex=-1;target.focus();target.scrollIntoView({block:'nearest'});
    }catch(error){if(dialog.open&&project===selected&&previewTicket===generation)preview.replaceChildren(el('p',error.message,'error'));}
  }
  form.onsubmit=event=>{event.preventDefault();clearTimeout(debounce);resultOffset=0;previewTicket++;preview.hidden=true;act(search);};
  input.oninput=()=>{clearTimeout(debounce);clearTimeout(poll);ticket++;previewTicket++;resultOffset=0;preview.hidden=true;debounce=setTimeout(()=>act(search),250);};
  dialog.addEventListener('close',()=>{clearTimeout(poll);clearTimeout(debounce);ticket++;previewTicket++;});
  $('project').addEventListener('change',()=>dialog.close());
  const open=button('대화 검색',async()=>{
    if(!projectReady||!$('project').value)throw Error('프로젝트를 먼저 불러와 주세요.');
    project=$('project').value;resultOffset=0;input.value='';results.replaceChildren();preview.hidden=true;pages.hidden=true;
    scope.textContent=project+' 프로젝트의 CODAST, Codex, Claude 대화를 이 컴퓨터에서 검색합니다.';
    dialog.showModal();input.focus();await updateIndex();
  });open.id='open-session-search';
  document.querySelector('.chat-navigation .new-chat').after(open);
})();
