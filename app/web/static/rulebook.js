(()=>{
  const panel=$('rules-panel'),preview=$('rules'),dialog=panel.closest('dialog');
  $('reload-rules').remove();
  panel.querySelector('.hint').textContent='드래그하여 폴더로 이동하거나 룰북 순서를 바꾸세요. 필요한 룰북만 체크하세요. 이 프로젝트의 다음 요청부터 적용됩니다.';
  let books=[],folders=[],selected=null,defaults='',loadedProject='',original='',busy=true;
  const status=el('p','프로젝트를 선택하세요.','hint');status.setAttribute('role','status');
  const fieldset=el('fieldset');fieldset.className='rulebook-library';fieldset.disabled=true;
  const navigation=el('nav');navigation.className='rulebook-navigation';navigation.setAttribute('aria-label','룰북 목록');
  const toolbar=el('div',undefined,'rulebook-toolbar'),tree=el('div');tree.id='rulebook-tree';
  const editor=el('section',undefined,'rulebook-editor');
  const name=el('input');name.id='rulebook-name';name.maxLength=80;
  const folder=el('select');folder.id='rulebook-folder';
  const content=el('textarea');content.id='rulebook-content';content.rows=14;content.maxLength=24000;content.spellcheck=false;
  const empty=el('p','룰북을 선택하거나 추가하세요.','hint');
  const fields=el('div');
  for(const [text,node] of [['이름',name],['폴더',folder],['내용',content]]){const label=el('label',text);label.htmlFor=node.id;fields.append(label,node);}
  const filePicker=el('input');filePicker.type='file';filePicker.accept='.md,.txt';filePicker.multiple=true;filePicker.hidden=true;filePicker.id='rulebook-import-files';
  const importFiles=button('',async()=>filePicker.click());window.actionIcon(importFiles,'importDocument','룰북 파일 추가');
  const importRow=el('div',undefined,'rulebook-import-row');importRow.append(importFiles,el('span','나만의 룰북 파일을 추가해 주세요.','hint'),filePicker);
  filePicker.onchange=async()=>{
    const chosen=[...filePicker.files],project=loadedProject;filePicker.value='';if(!chosen.length)return;
    if(books.length+chosen.length>40){status.textContent='룰북은 휴지통을 포함해 최대 40개까지 추가할 수 있습니다.';return;}
    busy=true;fieldset.disabled=true;
    try{
      const imported=[];
      for(const file of chosen){
        if(!/\.(md|txt)$/i.test(file.name)||file.size>96000)throw Error('96KB 이하의 Markdown 또는 텍스트 파일을 선택하세요.');
        const text=await file.text();if(text.length>24000||text.includes('\0'))throw Error('파일 내용은 24,000자 이내의 텍스트여야 합니다.');
        imported.push({id:'file-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8),name:file.name.slice(0,80),folder:current()?.folder||'',enabled:false,content:text});
      }
      if(project!==$('project').value)return;books.push(...imported);selected=imported[0].id;renderTree();renderEditor();dirty();status.textContent='파일 내용을 추가했습니다. 적용할 룰북을 체크하고 저장하세요. 원본 파일은 변경하지 않습니다.';
    }catch(error){status.textContent='파일 추가 실패, '+error.message;}finally{busy=false;fieldset.disabled=false;}
  };
  function payload(){return {include_project_rules:false,folders:[...folders],books:books.map(b=>({...b}))};}
  const signature=()=>JSON.stringify(payload());
  function dirty(){status.textContent='저장하지 않은 변경사항이 있습니다.';}
  function icon(kind,label,fn){const node=button('',fn);window.actionIcon(node,kind,label);return node;}
  function current(){return books.find(b=>b.id===selected&&!b.trashed);}
  function renderEditor(){const book=current();empty.hidden=!!book;fields.hidden=!book;remove.disabled=!book;
    if(!book)return;name.value=book.name;folder.replaceChildren(new Option('폴더 없음',''),...folders.map(f=>new Option(f,f)));folder.value=book.folder;content.value=book.content??defaults;
  }
  let dragging=null;
  function draggable(node,item){node.draggable=true;node.addEventListener('dragstart',event=>{if(busy){event.preventDefault();return;}dragging=item;event.dataTransfer.setData('text/plain',item.value);event.dataTransfer.effectAllowed='move';});node.addEventListener('dragend',()=>{dragging=null;tree.querySelectorAll('.drop-target').forEach(n=>n.classList.remove('drop-target'));});}
  function dropTarget(node,destination,before=null){
    node.addEventListener('dragover',event=>{if(!dragging||busy)return;event.preventDefault();event.stopPropagation();node.classList.add('drop-target');event.dataTransfer.dropEffect='move';});
    node.addEventListener('dragleave',()=>node.classList.remove('drop-target'));
    node.addEventListener('drop',event=>{
      event.preventDefault();event.stopPropagation();node.classList.remove('drop-target');if(!dragging||busy)return;
      const item=dragging;dragging=null;
      if(item.kind==='book'){
        const book=books.find(b=>b.id===item.value);if(!book||before===book.id)return;
        book.folder=destination;
        if(before){books=books.filter(b=>b!==book);books.splice(books.findIndex(b=>b.id===before),0,book);}
      }else{
        const source=item.value;if(destination===source||destination.startsWith(source+'/')){status.textContent='자기 자신이나 하위 폴더로 옮길 수 없습니다.';return;}
        const next=(destination?destination+'/':'')+source.split('/').at(-1);if(next===source)return;
        const affected=folders.filter(f=>f===source||f.startsWith(source+'/'));
        const candidate=folders.map(f=>affected.includes(f)?next+f.slice(source.length):f);
        if(!validFolders(candidate)){status.textContent='이동할 수 없습니다. 중복 이름 또는 최대 3단계를 확인하세요.';return;}
        folders=candidate;books.forEach(b=>{if(affected.includes(b.folder))b.folder=next+b.folder.slice(source.length);});
      }
      dirty();renderTree();renderEditor();
      const target=[...tree.querySelectorAll('details')].find(n=>n.dataset.folder===destination);if(target)target.open=true;
    });
  }
  function renderTree(){
    const open=new Map([...tree.querySelectorAll('details')].map(n=>[n.dataset.folder,n.open]));tree.replaceChildren();const root=el('div','최상위로 이동','rulebook-root-drop');root.title='폴더나 룰북을 여기에 놓으세요.';dropTarget(root,'');tree.append(root);
    function row(book,parent){const line=el('div',undefined,'rulebook-row');const checked=el('input');checked.type='checkbox';checked.checked=book.enabled;checked.setAttribute('aria-label',book.name+' 적용');checked.onchange=()=>{book.enabled=checked.checked;dirty();};
      const select=button(book.name,async()=>{selected=book.id;renderTree();renderEditor();},'rulebook-select');select.setAttribute('aria-pressed',String(selected===book.id));line.dataset.book=book.id;draggable(select,{kind:'book',value:book.id});dropTarget(line,book.folder,book.id);line.append(checked,select);parent.append(line);}
    for(const book of books.filter(b=>!b.trashed&&!b.folder))row(book,tree);
    function branch(parent,target){
      for(const f of folders.filter(v=>parentOf(v)===parent)){
        const group=el('details');group.dataset.folder=f;group.open=open.get(f)??!parentOf(f);const summary=el('summary',f.split('/').at(-1));draggable(summary,{kind:'folder',value:f});dropTarget(summary,f);group.append(summary);
        const actions=el('div',undefined,'rulebook-folder-actions');
        const add=icon('folderPlus',f+' 하위 폴더 추가',async()=>addFolder(f));add.disabled=f.split('/').length>=3;
        actions.append(add,icon('edit',f+' 폴더 이름 변경',async()=>{
          const next=prompt('폴더 경로 (최대 3단계, /로 구분)',f)?.trim();if(!next||next===f)return;
          const affected=folders.filter(v=>v===f||v.startsWith(f+'/'));
          const moved=affected.map(v=>next+v.slice(f.length));const remaining=folders.filter(v=>!affected.includes(v));
          const candidate=[...remaining,...moved];
          if(!validFolders(candidate)){status.textContent='상위 폴더와 이름을 확인하세요. 이름이 겹치거나 폴더 깊이가 3단계를 넘으면 저장할 수 없습니다.';return;}
          folders=folders.map(v=>affected.includes(v)?next+v.slice(f.length):v);
          books.forEach(book=>{if(affected.includes(book.folder))book.folder=next+book.folder.slice(f.length);});dirty();renderTree();renderEditor();
        }),icon('trash',f+' 폴더 삭제',async()=>{
          if(!confirm('하위 폴더까지 삭제할까요? 룰북은 폴더 없음으로 옮겨집니다.'))return;
          const affected=folders.filter(v=>v===f||v.startsWith(f+'/'));folders=folders.filter(v=>!affected.includes(v));books.forEach(book=>{if(affected.includes(book.folder))book.folder='';});dirty();renderTree();renderEditor();
        }));actions.addEventListener('click',event=>event.preventDefault());summary.append(actions);for(const book of books.filter(book=>!book.trashed&&book.folder===f))row(book,group);branch(f,group);target.append(group);
      }
    }
    branch('',tree);renderTrash();
  }
  function parentOf(path){return path.split('/').slice(0,-1).join('/');}
  function validFolders(values){return values.length<=40&&new Set(values).size===values.length&&values.every(v=>{const parts=v.split('/');return parts.length<=3&&parts.every(p=>p.trim()===p&&p.length>0&&p.length<=80&&p!=='.'&&p!=='..'&&!p.includes('\\'))&&(!parentOf(v)||values.includes(parentOf(v)));});}
  function addFolder(parent=''){
    const value=prompt(parent?'하위 폴더 이름':'인덱스 폴더 이름')?.trim();if(!value)return;
    const path=parent?parent+'/'+value:value;
    if(value.includes('/')||!validFolders([...folders,path])){status.textContent='폴더 이름이 겹치는지 확인하세요. 폴더는 최대 3단계까지 만들 수 있습니다.';return;}
    folders.push(path);dirty();renderTree();renderEditor();
  }
  toolbar.append(icon('folderPlus','룰북 폴더 추가',async()=>addFolder()),icon('plus','룰북 추가',async()=>{
    if(books.length>=40){status.textContent='룰북은 휴지통을 포함해 최대 40개까지 만들 수 있습니다.';return;}
    const book={id:'book-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8),name:'새 룰북',folder:current()?.folder||'',enabled:true,content:''};books.push(book);selected=book.id;dirty();renderTree();renderEditor();name.focus();name.select();
  }));
  const trash=el('details');trash.id='rulebook-trash';const trashTitle=el('summary','삭제한 룰북'),trashList=el('div');trash.append(trashTitle,trashList);
  function renderTrash(){
    const deleted=books.filter(b=>b.trashed);trashTitle.textContent='삭제한 룰북, '+deleted.length;trashList.replaceChildren();
    if(!deleted.length)trashList.append(el('p','삭제한 룰북이 없습니다.','hint'));
    for(const book of deleted){const row=el('div',undefined,'rulebook-trash-row');row.append(el('span',book.name),icon('restore',book.name+' 룰북 복원',async()=>{
      book.trashed=false;book.enabled=false;if(book.folder&&!folders.includes(book.folder))book.folder='';selected=book.id;dirty();renderTree();renderEditor();
      for(const node of tree.querySelectorAll('details'))if(book.folder===node.dataset.folder||book.folder.startsWith(node.dataset.folder+'/'))node.open=true;
      status.textContent='복원했습니다. 적용하려면 체크하고 저장하세요.';
    }));trashList.append(row);}
  }
  const remove=icon('trash','선택한 룰북 삭제',async()=>{const book=current();if(!book||!confirm(book.name+' 룰북을 휴지통으로 옮길까요? 저장 후에도 복원할 수 있습니다.'))return;book.trashed=true;selected=books.find(b=>!b.trashed)?.id||null;dirty();renderTree();renderEditor();});
  const save=icon('save','룰북 저장',async()=>{
    if(busy||!loadedProject||loadedProject!==$('project').value)return;
    if(books.some(b=>!b.name.trim())){status.textContent='룰북 이름을 입력하세요.';return;}
    const b=base(),project=loadedProject;busy=true;fieldset.disabled=true;
    try{await api(b+'/rules','PUT',payload());if(project!==$('project').value)return;original=signature();status.textContent='저장했습니다. 다음 요청부터 적용됩니다.';}
    catch(error){status.textContent='저장 실패, '+error.message;}
    finally{busy=false;fieldset.disabled=false;}
  });save.id='save-rulebook';
  name.oninput=()=>{if(current()){current().name=name.value;dirty();}};name.onchange=renderTree;
  folder.onchange=()=>{if(current()){current().folder=folder.value;dirty();renderTree();}};
  content.oninput=()=>{if(current()){current().content=content.value;dirty();}};
  const actions=el('div',undefined,'rulebook-actions');actions.append(remove,save);
  const listHeader=el('div',undefined,'rulebook-list-header');listHeader.append(el('h3','룰북'),toolbar);
  navigation.append(listHeader,tree,trash);editor.append(empty,fields);fieldset.append(navigation,editor,importRow,actions);panel.append(fieldset,status);preview.hidden=true;
  window.renderRulebook=data=>{
    defaults=data.default_content||'';loadedProject=$('project').value;const settings=data.settings||{};
    folders=[...(settings.folders||[])];books=settings.books!==null&&settings.books!==undefined?settings.books.map(b=>({...b})):[{id:'default',name:'내 기본 룰셋',folder:'',enabled:settings.enabled!==false,content:settings.content??null}];
    if(!books.some(b=>b.id===selected&&!b.trashed))selected=books.find(b=>!b.trashed)?.id||null;
    original=signature();tree.replaceChildren();renderTree();renderEditor();
  };
  window.openRulebook=async()=>{
    busy=true;fieldset.disabled=true;
    if(!$('project').value){books=[];folders=[];selected=null;original='';renderTree();renderEditor();status.textContent='프로젝트를 먼저 선택하세요.';busy=false;loadedProject='';return;}
    status.textContent='룰북을 불러오는 중…';try{await loadRules();busy=false;fieldset.disabled=false;status.textContent='변경 후 저장 버튼을 누르세요.';}catch(error){status.textContent='조회 실패, '+error.message;}finally{busy=false;}
  };
  function guard(event){if(original&&signature()!==original&&!confirm('저장하지 않은 변경사항을 닫을까요?')){event.preventDefault();event.stopImmediatePropagation();}}
  dialog.addEventListener('cancel',guard);dialog.querySelector('header button').addEventListener('click',guard,true);
})();
