(()=>{
  const extensions=new Set('java kt kts groovy scala py js mjs cjs ts tsx jsx vue svelte go rs c h cc cpp hpp cs rb php swift m sh ps1 bat cmd sql html htm css scss less json yaml yml toml ini cfg conf xml properties gradle md txt'.split(' '));
  function parseReference(text,spaces=false){
    if(typeof text!=='string'||!text||/[\u0000-\u001f\u007f]/.test(text)||(!spaces&&/\s/.test(text)))return null;
    let path=text,line=null,endLine=null,column=null;
    const suffix=text.match(/(?::(\d+)(?::(\d+)|-(\d+))?|#L(\d+)(?:C(\d+)|-L(\d+))?)$/);
    if(suffix){
      path=text.slice(0,suffix.index);line=Number(suffix[1]||suffix[4]);
      column=suffix[2]||suffix[5]?Number(suffix[2]||suffix[5]):null;
      endLine=suffix[3]||suffix[6]?Number(suffix[3]||suffix[6]):null;
      if(!Number.isSafeInteger(line)||line<1||(column!==null&&(!Number.isSafeInteger(column)||column<1))||(endLine!==null&&(!Number.isSafeInteger(endLine)||endLine<line)))return null;
      if(endLine===line)endLine=null;
    }
    const withoutDrive=path.replace(/^[a-z]:[\\/]/i,'');
    if(!path||/[:?#<>|"\s]$/.test(path)||/[:?#<>|"]/.test(withoutDrive)||/^\d+$/.test(path)||path.startsWith('//'))return null;
    if(!line&&!/[\\/]/.test(path)&&!(path.includes('.')&&extensions.has(path.split('.').pop().toLowerCase()))&&!['Dockerfile','Makefile'].includes(path))return null;
    return {path,line,endLine,column};
  }
  function fromHref(href){
    if(typeof href!=='string'||!href||href.startsWith('#')||/^(?:https?|mailto):/i.test(href))return null;
    if(/^file:/i.test(href)){
      if(!/^file:\/\/\//i.test(href))return null;
      href=href.slice(7).replace(/^\/([a-z]:\/)/i,'$1');
    }
    try{return parseReference(decodeURIComponent(href),true);}catch{return null;}
  }
  function decorate(fragment){
    for(const node of fragment.querySelectorAll('a[href],code')){
      if(node.closest('pre,button')||node.tagName==='CODE'&&node.closest('a'))continue;
      const reference=node.tagName==='CODE'?parseReference(node.textContent):fromHref(node.getAttribute('href'));
      if(!reference)continue;
      const label=node.textContent,control=button(label,()=>window.codeViewer?.open(reference,control),'code-ref');
      control.setAttribute('aria-label','코드 보기 '+label);node.replaceWith(control);
    }
  }
  window.codeReferences={parse:parseReference,fromHref,decorate};

  window.addEventListener('load',()=>{
    const panel=el('aside'),heading=el('h2'),encoding=el('span',undefined,'code-encoding');
    panel.id='code-viewer';panel.hidden=true;panel.setAttribute('aria-label','코드 보기');
    const header=el('header'),toolbar=el('div',undefined,'code-toolbar'),body=el('div',undefined,'code-body');
    const tree=el('nav'),code=el('div',undefined,'code-content'),status=el('p',undefined,'code-status');
    tree.id='code-tree';tree.setAttribute('aria-label','프로젝트 폴더');
    code.tabIndex=0;code.setAttribute('role','region');code.setAttribute('aria-label','파일 내용');
    status.setAttribute('role','status');heading.tabIndex=-1;
    let project=$('project').value,generation=0,revision=0,current=null,lastReference=null,opener=null;
    let folders=new Map(),files=new Map();
    const wide=matchMedia('(min-width:1100px)'),narrow=matchMedia('(max-width:759px)');
    const endpoint=()=>'/projects/'+encodeURIComponent(project)+'/code/';
    const active=(g,r=revision)=>g===generation&&r===revision&&project===$('project').value;
    const ideLabels={vscode:'VS Code',intellij:'IntelliJ IDEA'};
    let projectIde=null,ideLoaded=false,ideTicket=0,openingIde=false,dialogTicket=0,dialogOpener=null;
    const ideEndpoint=()=>'/projects/'+encodeURIComponent(project)+'/ide';
    async function run(action){
      const g=generation,r=revision;
      try{await action();}catch(error){if(active(g,r))status.textContent=error.message;}
    }
    function control(label,action,icon){
      const node=button(label,()=>run(action));
      if(icon)window.actionIcon(node,icon,label);
      return node;
    }
    function setTree(open){
      tree.hidden=!open;treeToggle.textContent=open?'트리 접기':'트리 펼치기';
      treeToggle.setAttribute('aria-label',open?'폴더 트리 접기':'폴더 트리 펼치기');
      treeToggle.setAttribute('aria-expanded',String(open));
    }
    const treeToggle=control('폴더 트리 접기',()=>setTree(tree.hidden));
    treeToggle.setAttribute('aria-controls','code-tree');
    const refresh=control('새로고침',async()=>{
      const g=generation,r=revision;
      await api(endpoint()+'refresh','POST');if(!active(g,r))return;
      resetTree();
      if(lastReference)await open(lastReference);else await run(()=>loadFolder(''));
    },'restore');
    const expand=control('넓히기',()=>{
      const expanded=panel.classList.toggle('is-expanded');
      expand.textContent=expanded?'원래 크기':'넓히기';expand.setAttribute('aria-pressed',String(expanded));
    });
    expand.classList.add('code-expand');expand.setAttribute('aria-pressed','false');
    const insert=control('참조를 입력창에 넣기',()=>insertReference(current?.line||1,current?.endLine));
    insert.disabled=true;
    const openIde=control('IDE에서 열기',async()=>{
      if(projectIde)await requestIde();else await chooseIde(true,openIde);
    });
    const changeIde=control('다른 IDE 선택',()=>chooseIde(false,changeIde));
    function updateIde(){
      openIde.textContent=(ideLabels[projectIde]||'IDE')+'에서 열기';
      openIde.disabled=!current||!ideLoaded||openingIde;changeIde.disabled=!project||openingIde;
    }
    async function loadIde(){
      const g=generation,ticket=++ideTicket;
      const data=await api(ideEndpoint());
      if(g!==generation||ticket!==ideTicket||project!==$('project').value)return;
      projectIde=data.ide||null;ideLoaded=true;updateIde();
    }
    async function requestIde(){
      if(!current||openingIde)return;
      const g=generation,r=revision,file=current;
      openingIde=true;updateIde();status.textContent='IDE에 열기 요청을 보내는 중입니다.';
      try{
        const data=await api(ideEndpoint()+'/open','POST',{path:file.path,line:file.ideWithoutPosition?null:file.line??null,column:file.ideWithoutPosition?null:file.column??null});
        if(active(g,r)&&data.state==='requested')status.textContent='IDE에 열기 요청을 보냈습니다. IDE가 꺼져 있었다면 켜지는 데 시간이 걸리고, 다른 프로젝트면 IDE가 열 창을 물어볼 수 있습니다. IDE 창을 확인하세요.';
      }finally{openingIde=false;updateIde();}
    }
    const ideDialog=el('dialog',undefined,'session-drawer ide-dialog'),ideList=el('fieldset'),ideStatus=el('p');
    ideDialog.setAttribute('aria-label','IDE 선택');ideStatus.setAttribute('role','status');
    const ideHead=el('div',undefined,'account-dialog-header');
    ideHead.append(el('h2','IDE 선택'),button('닫기',()=>ideDialog.close()));
    ideDialog.append(ideHead,ideStatus,ideList);document.body.append(ideDialog);
    ideDialog.addEventListener('close',()=>{
      dialogTicket++;if(!panel.hidden&&dialogOpener?.isConnected)dialogOpener.focus();
    });
    async function chooseIde(openAfter,source){
      const g=generation,r=revision,ticket=++dialogTicket,url=ideEndpoint();
      const valid=()=>active(g,r)&&ticket===dialogTicket&&ideDialog.open;
      dialogOpener=source;ideList.replaceChildren();ideList.disabled=false;ideStatus.textContent='IDE를 찾는 중입니다.';ideDialog.showModal();
      async function action(fn){
        if(ideList.disabled||!valid())return;
        ideList.disabled=true;ideStatus.textContent='처리 중입니다.';
        try{await fn();}catch(error){if(valid())ideStatus.textContent=error.message;}
        finally{if(valid())ideList.disabled=false;}
      }
      async function render(){
        const data=await api('/ides');if(!valid())return;
        ideList.replaceChildren();ideStatus.textContent='이 프로젝트에서 사용할 IDE를 선택하세요.';
        for(const row of data.ides){
          const item=el('div',undefined,'ide-option'),select=button(row.label,()=>action(async()=>{
            await api(url,'PUT',{ide:row.ide});if(!valid())return;
            projectIde=row.ide;ideLoaded=true;ideTicket++;updateIde();ideDialog.close();
            if(openAfter)await run(requestIde);
          }));
          select.disabled=!row.path;
          const detail=el('span',row.path?'찾음, '+row.path:row.state==='multiple'?'여러 실행 파일을 찾았습니다. IDE 연결에서 후보를 선택하거나 경로를 지정하세요.':'설치 안 됨, 실행 파일 경로를 지정하세요.','ide-path');
          select.append(detail);
          const pick=button('경로 지정',()=>action(async()=>{
            ideStatus.textContent='파일 선택 창에서 '+row.label+' 실행 파일을 선택하세요.';
            const chosen=await api('/ides/'+row.ide+'/executable-picker','POST');if(!valid())return;
            if(!chosen.path){ideStatus.textContent='파일 선택을 취소했습니다.';return;}
            await api('/ides/'+row.ide,'PUT',{path:chosen.path});if(!valid())return;
            await render();if(valid())ideList.querySelector('button:not(:disabled)')?.focus();
          }));
          pick.setAttribute('aria-label',row.label+' 경로 지정');item.append(select,pick);ideList.append(item);
        }
      }
      try{await render();}catch(error){if(valid())ideStatus.textContent=error.message;}
    }
    function close(restoreFocus=true){
      if(ideDialog.open)ideDialog.close();
      revision++;panel.hidden=true;
      if(restoreFocus&&opener?.isConnected)opener.focus();
    }
    const closeButton=control('코드 보기 닫기',close,'close');
    toolbar.append(openIde,changeIde,treeToggle,refresh,expand,insert,closeButton);updateIde();
    header.append(heading,encoding,toolbar);body.append(tree,code);panel.append(header,status,body);
    $('console').after(panel);setTree(wide.matches);
    wide.addEventListener('change',()=>setTree(wide.matches));
    window.addEventListener('hashchange',()=>{if(location.hash.startsWith('#settings/'))close(false);});
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&!panel.hidden&&!document.querySelector('dialog[open]')){event.preventDefault();close();}
      if(event.key==='Tab'&&!panel.hidden&&narrow.matches&&!document.querySelector('dialog[open]')){
        const controls=[...panel.querySelectorAll('button:not(:disabled),[tabindex="0"]')].filter(node=>node.getClientRects().length);
        const first=controls[0],last=controls.at(-1);
        if(!controls.includes(document.activeElement)){event.preventDefault();(event.shiftKey?last:first).focus();}
        else if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
      }
    });
    function clearCode(){
      current=null;heading.textContent='코드 보기';encoding.textContent='';code.replaceChildren();insert.disabled=true;
      updateIde();
      for(const node of files.values())node.removeAttribute('aria-current');
    }
    function insertReference(line,endLine){
      if(!current)return;
      const input=$('text'),text=current.path+':'+line+(endLine&&endLine!==line?'-'+endLine:'');
      input.setRangeText(text,input.selectionStart,input.selectionEnd,'end');
      input.dispatchEvent(new Event('input',{bubbles:true}));
      if(narrow.matches)close();
      else if(panel.classList.contains('is-expanded'))expand.click();
      input.focus();status.textContent='참조를 입력창에 넣었습니다.';
    }
    const copyPath=control('파일 경로 복사',async()=>{
      try{await navigator.clipboard.writeText(current.path);status.textContent='파일 경로를 복사했습니다.';}
      catch{status.textContent='경로를 복사하지 못했습니다. 파일 경로를 선택해 복사하세요.';}
    });
    copyPath.setAttribute('aria-label','파일 경로 복사');copyPath.title='파일 경로 복사';
    function resetTree(){
      folders=new Map();files=new Map();tree.replaceChildren();
      const list=el('ul');tree.append(list);folders.set('',{list,loaded:false});
    }
    async function loadFolder(path){
      const folder=folders.get(path);if(!folder)return;
      if(folder.loading)return folder.loading;
      if(folder.loaded)return;
      const g=generation,url=endpoint()+'tree?path='+encodeURIComponent(path);
      folder.loading=(async()=>{
        const data=await api(url);if(g!==generation||folders.get(path)!==folder)return;
        folder.list.replaceChildren();
        for(const entry of data.entries){
          const full=path?path+'/'+entry.name:entry.name,item=el('li');
          if(entry.type==='dir'){
            const list=el('ul'),node=control(entry.name,async()=>{
              if(node.getAttribute('aria-expanded')==='true'){node.setAttribute('aria-expanded','false');list.hidden=true;return;}
              await loadFolder(full);if(g!==generation)return;
              node.setAttribute('aria-expanded','true');list.hidden=false;
            });
            node.setAttribute('aria-expanded','false');list.hidden=true;
            folders.set(full,{list,node,loaded:false});item.append(node,list);
          }else{
            const node=control(entry.name,()=>open({path:full,line:null,endLine:null,column:null},null,true));
            if(current?.path===full)node.setAttribute('aria-current','true');
            files.set(full,node);item.append(node);
          }
          folder.list.append(item);
        }
        if(data.truncated)folder.list.append(el('li','항목이 많아 일부만 표시합니다.','code-tree-note'));
        if(!data.entries.length)folder.list.append(el('li','빈 폴더입니다.','code-tree-note'));
        folder.loaded=true;
      })();
      try{await folder.loading;}finally{folder.loading=null;}
    }
    async function reveal(path,g,r){
      await loadFolder('');
      const parts=path.split('/');parts.pop();let folderPath='';
      for(const part of parts){
        if(!active(g,r))return;
        folderPath=folderPath?folderPath+'/'+part:part;
        const folder=folders.get(folderPath);if(!folder)break;
        await loadFolder(folderPath);if(!active(g,r))return;
        folder.node.setAttribute('aria-expanded','true');folder.list.hidden=false;
      }
    }
    tree.addEventListener('keydown',event=>{
      const node=event.target.closest('button');if(!node)return;
      const nodes=[...tree.querySelectorAll('button')].filter(item=>item.getClientRects().length),index=nodes.indexOf(node);
      let target;
      if(event.key==='ArrowDown')target=nodes[index+1];
      if(event.key==='ArrowUp')target=nodes[index-1];
      if(event.key==='Home')target=nodes[0];
      if(event.key==='End')target=nodes.at(-1);
      if(event.key==='ArrowRight'){
        if(node.getAttribute('aria-expanded')==='false')node.click();else target=node.nextElementSibling?.querySelector('button');
      }
      if(event.key==='ArrowLeft'){
        if(node.getAttribute('aria-expanded')==='true')node.click();else target=node.closest('ul')?.previousElementSibling;
      }
      if(['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();target?.focus();}
    });
    async function showFile(path,reference,g,r){
      current={...reference,path};copyPath.textContent=path;heading.replaceChildren(copyPath);updateIde();
      const data=await api(endpoint()+'file?path='+encodeURIComponent(path));if(!active(g,r))return;
      let treeError='';
      try{await reveal(data.path,g,r);}catch(error){treeError='폴더를 불러오지 못했습니다. '+error.message;}
      if(!active(g,r))return;
      clearCode();current={...reference,path:data.path};copyPath.textContent=data.path;heading.replaceChildren(copyPath);
      updateIde();
      encoding.textContent=data.encoding==='utf-8'?'':data.encoding.toUpperCase();insert.disabled=false;
      files.get(data.path)?.setAttribute('aria-current','true');
      const lines=data.content?data.content.replace(/\r\n/g,'\n').split('\n'):[];
      if(lines.at(-1)==='')lines.pop();
      const content=document.createDocumentFragment(),start=reference.line,end=reference.endLine||start;
      for(let index=0;index<lines.length;index++){
        const number=index+1,row=el('div',undefined,'code-line');row.dataset.line=String(number);
        const lineButton=control(String(number),()=>insertReference(number));lineButton.classList.add('line-number');
        lineButton.setAttribute('aria-label',number+'줄 참조를 입력창에 넣기');
        row.append(lineButton,el('span',lines[index],'line-text'));
        if(start&&number>=start&&number<=end)row.classList.add('is-target');
        content.append(row);
      }
      code.replaceChildren(content);code.scrollTop=0;code.scrollLeft=0;
      status.textContent=start>lines.length||end>lines.length?'요청한 '+start+(end!==start?'-'+end:'')+'줄이 파일 범위를 벗어납니다. 전체 '+lines.length+'줄입니다.':lines.length?'':'빈 파일입니다.';
      if(treeError)status.textContent+=' '+treeError;
      requestAnimationFrame(()=>{
        if(!active(g,r))return;
        const targets=code.querySelectorAll('.is-target');if(!targets.length)return;
        const first=targets[0].getBoundingClientRect(),last=targets[targets.length-1].getBoundingClientRect();
        code.scrollTop+=(first.top+last.bottom)/2-(code.getBoundingClientRect().top+code.clientHeight/2);
      });
    }
    async function open(reference,source=null,resolved=false){
      if(project!==$('project').value)projectChanged();
      const g=generation,r=++revision;lastReference=reference;if(source)opener=source;
      panel.hidden=false;clearCode();heading.focus({preventScroll:true});
      if(!project){status.textContent='프로젝트를 선택하세요.';return;}
      status.textContent='파일을 불러오는 중입니다.';
      if(!ideLoaded)void run(loadIde);
      await run(async()=>{
        const result=resolved?{path:reference.path}:await api(endpoint()+'resolve?ref='+encodeURIComponent(reference.path));
        if(!active(g,r))return;
        if(result.pending){status.textContent='파일 목록을 만드는 중입니다. 잠시 뒤 새로고침을 눌러 주세요.';await loadFolder('');return;}
        if(result.path){await showFile(result.path,reference,g,r);return;}
        const candidates=el('ul',undefined,'code-candidates');candidates.setAttribute('aria-label','같은 이름의 파일');
        for(const path of result.candidates||[]){
          const item=el('li');item.append(control(path,()=>open({...reference,path,ideWithoutPosition:true},null,true)));candidates.append(item);
        }
        code.replaceChildren(candidates);status.textContent=result.truncated?'후보가 많아 일부만 표시합니다. 파일을 선택하세요.':'같은 이름의 파일이 있습니다. 파일을 선택하세요.';
        await loadFolder('');
      });
    }
    function projectChanged(){
      if(ideDialog.open)ideDialog.close();
      generation++;revision++;project=$('project').value;lastReference=null;opener=null;
      projectIde=null;ideLoaded=false;ideTicket++;
      clearCode();resetTree();status.textContent=project?'파일을 선택하세요.':'프로젝트를 선택하세요.';
      if(!panel.hidden&&project){void run(()=>loadFolder(''));void run(loadIde);}
    }
    window.addEventListener('project-ide-changed',event=>{
      if(event.detail.project!==project)return;
      projectIde=event.detail.ide;ideLoaded=true;ideTicket++;updateIde();
    });
    resetTree();window.codeViewer={open,projectChanged};
  });
})();
