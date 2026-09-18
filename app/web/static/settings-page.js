/* Settings navigation preserves the live workspace and its running streams. */
(()=>{
  const pages=new Map(),shell=el('section',undefined,'settings-page');shell.id='settings-page';shell.hidden=true;
  const header=el('header'),back=button('← 작업실',()=>window.settingsPage.close()),brand=el('strong','CODAST');
  header.append(brand,el('span','설정'),back);
  const layout=el('div',undefined,'settings-layout'),nav=el('nav'),content=el('main'),heading=el('h1');
  nav.setAttribute('aria-label','설정 메뉴');content.append(heading);layout.append(nav,content);shell.append(header,layout);document.body.append(shell);
  const context=el('p',undefined,'settings-context');nav.append(context);
  let workspaceScroll=0,last='execution',wasOpen=false,statusHome=null;
  function render(){
    const match=location.hash.match(/^#settings\/([a-z-]+)$/),selected=match&&pages.get(match[1]);
    if(!selected){
      if(wasOpen){shell.hidden=true;$('workspace').style.removeProperty('display');
        statusHome?.parent.insertBefore($('status'),statusHome.next);$('messages').scrollTop=workspaceScroll;back.blur();$('open-settings').focus();wasOpen=false;}
      return;
    }
    if(!wasOpen){window.chatState.save();workspaceScroll=$('messages').scrollTop;statusHome={parent:$('status').parentNode,next:$('status').nextSibling};shell.append($('status'));}
    wasOpen=true;last=match[1];$('workspace').style.display='none';shell.hidden=false;
    context.textContent=$('project').value?'프로젝트 · '+$('project').value:'프로젝트 선택 전';heading.textContent=selected.label;heading.tabIndex=-1;
    for(const [key,page] of pages){page.node.hidden=key!==last;page.link.setAttribute('aria-current',key===last?'page':'false');}
    if(selected.node.tagName==='DETAILS')selected.node.open=true;
    if(last==='history'&&$('project').value)act(()=>history());
    content.scrollTop=0;heading.focus();
  }
  window.settingsPage={
    register(key,label,node){const link=el('a',label);link.href='#settings/'+key;nav.append(link);node.classList.add('settings-content');node.hidden=true;content.append(node);pages.set(key,{label,node,link});},
    open(key=last){const hash='#settings/'+key;if(location.hash===hash)render();else location.hash=hash;},
    close(){if(wasOpen){location.hash='';}},
  };
  window.addEventListener('hashchange',render);
  window.addEventListener('load',render);
})();
