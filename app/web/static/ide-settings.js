(()=>{
  const panel=el('section'),status=el('p'),fields=el('fieldset'),paths=el('div');
  panel.id='ide-settings';status.setAttribute('role','status');
  const projectName=el('p',undefined,'hint'),projectIde=el('select');
  projectIde.id='project-ide';
  const projectLabel=el('label','현재 프로젝트 IDE');projectLabel.htmlFor=projectIde.id;
  const projectRow=el('div',undefined,'client-path-row'),projectField=el('div',undefined,'form-field');
  const saveProject=button('저장',()=>run(async()=>{
    const project=$('project').value;if(!project||!projectIde.value)return;
    const data=await api('/projects/'+encodeURIComponent(project)+'/ide','PUT',{ide:projectIde.value});
    window.dispatchEvent(new CustomEvent('project-ide-changed',{detail:{project,ide:data.ide}}));
    await load('프로젝트 IDE를 저장했습니다.');
  }));
  saveProject.setAttribute('aria-label','현재 프로젝트 IDE 저장');
  projectRow.append(projectIde,saveProject);projectField.append(projectLabel,projectName,projectRow);
  const refresh=button('다시 읽기',()=>run(()=>load()));
  fields.append(projectField,paths,refresh);
  panel.append(el('p','IDE 열기는 CODAST 서버와 같은 PC에서, 일반 실행(codast.cmd start)으로 켠 경우에 동작합니다. 격리된 실행 환경에서 켠 서버는 IntelliJ에 요청을 넘기지 못할 수 있습니다.','hint'),status,fields);
  window.settingsPage.register('ides','IDE 연결',panel);
  let ticket=0,busy=false;
  async function run(action){
    if(busy)return;
    busy=true;fields.disabled=true;status.textContent='저장 중입니다.';
    try{await action();}catch(error){status.textContent=error.message;}
    finally{busy=false;fields.disabled=false;}
  }
  function icon(kind,label,action){
    const node=button('',()=>run(action));window.actionIcon(node,kind,label);return node;
  }
  async function load(message=''){
    const t=++ticket,project=$('project').value;
    fields.disabled=true;status.textContent='IDE 연결을 확인하는 중입니다.';
    try{
      const [data,selected]=await Promise.all([api('/ides'),project?api('/projects/'+encodeURIComponent(project)+'/ide'):Promise.resolve({ide:null})]);
      if(t!==ticket||project!==$('project').value)return;
      projectName.textContent=project?$('project').selectedOptions[0].textContent:'프로젝트를 먼저 선택하세요.';
      projectIde.replaceChildren(new Option('IDE 선택',''));
      projectIde.options[0].disabled=true;
      for(const row of data.ides){
        const option=new Option(row.label,row.ide);option.disabled=!row.path;projectIde.append(option);
      }
      projectIde.value=selected.ide||'';projectIde.disabled=!project;
      saveProject.disabled=!project||!projectIde.value;paths.replaceChildren();
      for(const row of data.ides)renderPath(row);
      status.textContent=message;
    }catch(error){if(t===ticket)status.textContent=error.message;}
    finally{if(t===ticket)fields.disabled=busy;}
  }
  function renderPath(row){
    const section=el('section',undefined,'ide-path-settings'),url='/ides/'+row.ide;
    const state={configured:'저장된 경로',detected:'자동 검색으로 찾음',multiple:'여러 실행 파일을 찾았습니다. 사용할 경로를 선택하세요.',missing:'설치 안 됨, 실행 파일 경로를 지정하세요.'};
    section.append(el('h2',row.label),el('p',state[row.state],'hint'));
    if(row.path)section.append(el('p',row.path,'ide-path'));
    const input=el('input',undefined,'form-control');input.id='ide-path-'+row.ide;input.value=row.path||'';
    input.placeholder='자동 검색 또는 실행 파일의 전체 경로';input.spellcheck=false;
    const label=el('label',row.label+' 실행 파일');label.htmlFor=input.id;
    const pathRow=el('div',undefined,'client-path-row'),field=el('div',undefined,'form-field');
    pathRow.append(input,icon('folder',row.label+' 실행 파일 선택',async()=>{
      status.textContent='파일 선택 창에서 '+row.label+' 실행 파일을 선택하세요.';
      const chosen=await api(url+'/executable-picker','POST');
      if(!chosen.path){status.textContent='파일 선택을 취소했습니다. 기존 경로는 유지됩니다.';return;}
      await api(url,'PUT',{path:chosen.path});await load(row.label+' 경로를 저장했습니다.');
    }));
    field.append(label,pathRow);section.append(field);
    if(row.candidates.length){
      const candidates=el('select'),candidateLabel=el('label','검색된 실행 파일');
      candidates.id='ide-candidates-'+row.ide;candidateLabel.htmlFor=candidates.id;
      candidates.append(new Option('후보 경로 선택',''));
      for(const path of row.candidates)candidates.append(new Option(path,path));
      candidates.value=row.path||'';candidates.onchange=()=>{if(candidates.value)input.value=candidates.value;};
      section.append(candidateLabel,candidates);
    }
    const controls=el('div',undefined,'client-path-row');
    controls.append(icon('restore',row.label+' 자동 검색',async()=>{
      await api(url,'PUT',{path:''});await load(row.label+' 자동 검색을 완료했습니다.');
    }),icon('check',row.label+' 경로 저장',async()=>{
      await api(url,'PUT',{path:input.value.trim()});await load(row.label+' 경로를 저장했습니다.');
    }));
    section.append(el('p','자동 검색은 PATH와 기본 설치 위치를 확인합니다. 후보를 고르거나 직접 입력한 뒤 경로 저장을 누르세요.','hint'),controls);paths.append(section);
  }
  projectIde.onchange=()=>{saveProject.disabled=!projectIde.value;};
  panel.addEventListener('settings-open',()=>{void load();});
  $('project').addEventListener('change',()=>{if(!panel.hidden)void load();});
})();
