(()=>{
  let picking=false;
  const dialog=$('workspace-dialog');
  function open(){
    $('workspace-path').value='';$('workspace-name').value='';$('folder-status').textContent='기존 폴더를 선택하거나 전체 경로를 입력하고, 목록에 표시할 프로젝트 이름을 지정할 수 있습니다.';$('register-folder').disabled=true;dialog.showModal();
  }
  $('workspace-path').oninput=()=>{$('register-folder').disabled=picking||!$('workspace-path').value.trim();};
  $('add-workspace').onclick=open;$('choose-workspace').onclick=open;
  $('cancel-workspace').onclick=()=>{if(!picking)dialog.close();};
  dialog.addEventListener('cancel',event=>{if(picking)event.preventDefault();});
  $('pick-folder').onclick=async()=>{
    if(picking)return;picking=true;$('cancel-workspace').disabled=true;$('pick-folder').disabled=true;$('register-folder').disabled=true;
    $('folder-status').textContent='Windows 폴더 선택 창을 여는 중입니다. 최대 60초 후 자동으로 대기를 종료합니다.';
    try{
      const data=await api('/workspace-folder','POST');
      if(!dialog.open)return;
      if(!data.path){$('folder-status').textContent='폴더 선택을 취소했습니다.';return;}
      $('workspace-path').value=data.path;
      if(!$('workspace-name').value){const leaf=data.path.split(/[\\/]/).filter(Boolean).pop()||'';$('workspace-name').value=leaf.replace(/[^a-zA-Z0-9가-힣ㄱ-ㅣ\u1100-\u11ff_-]/g,'-').replace(/^[-_]+/,'').slice(0,64)||'my-workspace';}
      $('folder-status').textContent='폴더를 선택했습니다. 이름과 경로를 확인한 뒤 추가 버튼으로 등록할 수 있습니다.';
    }catch(error){$('folder-status').textContent=error.message;}
    finally{picking=false;$('cancel-workspace').disabled=false;$('pick-folder').disabled=false;$('register-folder').disabled=!$('workspace-path').value;}
  };
  $('register-workspace').onsubmit=async event=>{
    event.preventDefault();if(picking||!$('workspace-path').value)return;
    $('register-folder').disabled=true;
    try{const name=$('workspace-name').value;await api('/workspaces','POST',{name,path:$('workspace-path').value.trim()});dialog.close();await projects(name);await loadProject();notice('선택한 폴더를 연결했습니다. 실행 권한과 에이전트는 실행 설정에서 확인할 수 있습니다.',false,{success:true});}
    catch(error){$('folder-status').textContent=error.message;}
    finally{$('register-folder').disabled=false;}
  };
  const renameDialog=$('rename-project-dialog'),renameInput=$('rename-project-name'),renameStatus=$('rename-project-status');
  let renameTarget='',renaming=false;
  renameInput.pattern=$('workspace-name').pattern;
  function openRename(){
    if(renaming)return;
    renameTarget=$('project').value;if(!renameTarget){notice('프로젝트를 선택하세요.',true);return;}
    renameInput.value=projectLabel(renameTarget);renameStatus.textContent='';renameDialog.showModal();renameInput.focus();renameInput.select();
  }
  $('rename-project').onclick=openRename;$('manage-project-name').onclick=openRename;
  $('cancel-project-name').onclick=()=>{if(!renaming)renameDialog.close();};
  renameDialog.addEventListener('cancel',event=>{if(renaming)event.preventDefault();});
  renameInput.oninvalid=event=>{event.preventDefault();renameStatus.textContent=projectNameError;renameInput.focus();};
  renameInput.oninput=()=>{renameStatus.textContent='';};
  $('rename-project-form').onsubmit=async event=>{
    event.preventDefault();if(renaming||!renameTarget)return;
    const target=renameTarget;renaming=true;renameStatus.textContent='저장 중…';
    for(const id of ['rename-project-name','save-project-name','cancel-project-name'])$(id).disabled=true;
    try{
      const result=await api('/projects/'+encodeURIComponent(target),'PATCH',{name:renameInput.value});
      projectNames[target]=result.display_name;
      for(const option of $('project').options)if(option.value===target)option.textContent=result.display_name;
      window.dispatchEvent(new Event('project-names-changed'));renameDialog.close();notice('프로젝트 이름을 변경했습니다.',false,{success:true});
    }catch(error){renameStatus.textContent=error.message;}
    finally{renaming=false;for(const id of ['rename-project-name','save-project-name','cancel-project-name'])$(id).disabled=false;}
  };
})();
