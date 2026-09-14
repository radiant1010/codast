(()=>{
  let picking=false;
  const dialog=$('workspace-dialog');
  function open(){
    $('workspace-path').value='';$('workspace-name').value='';$('folder-status').textContent='폴더를 선택한 뒤 등록할 이름을 확인하세요.';$('register-folder').disabled=true;dialog.showModal();
  }
  $('add-workspace').onclick=open;$('choose-workspace').onclick=open;
  $('cancel-workspace').onclick=()=>{if(!picking)dialog.close();};
  dialog.addEventListener('cancel',event=>{if(picking)event.preventDefault();});
  $('pick-folder').onclick=async()=>{
    if(picking)return;picking=true;$('cancel-workspace').disabled=true;$('pick-folder').disabled=true;$('register-folder').disabled=true;
    $('folder-status').textContent='Windows 폴더 선택 창에서 폴더를 고르세요. 다른 창 뒤에 열렸다면 작업 표시줄을 확인하세요.';
    try{
      const data=await api('/workspace-folder','POST');
      if(!dialog.open)return;
      if(!data.path){$('folder-status').textContent='폴더 선택을 취소했습니다.';return;}
      $('workspace-path').value=data.path;
      if(!$('workspace-name').value){const leaf=data.path.split(/[\\/]/).filter(Boolean).pop()||'';$('workspace-name').value=leaf.replace(/[^a-zA-Z0-9_-]/g,'-').replace(/^[-_]+/,'').slice(0,64)||'my-workspace';}
      $('folder-status').textContent='폴더를 선택했습니다. 이름과 경로를 확인한 뒤 추가하세요.';
    }catch(error){$('folder-status').textContent=error.message;}
    finally{picking=false;$('cancel-workspace').disabled=false;$('pick-folder').disabled=false;$('register-folder').disabled=!$('workspace-path').value;}
  };
  $('register-workspace').onsubmit=async event=>{
    event.preventDefault();if(picking||!$('workspace-path').value)return;
    $('register-folder').disabled=true;
    try{const name=$('workspace-name').value;await api('/workspaces','POST',{name,path:$('workspace-path').value});dialog.close();await projects(name);await loadProject();notice('선택한 폴더를 연결했습니다. 실행 설정에서 권한과 에이전트를 확인하세요.');}
    catch(error){$('folder-status').textContent=error.message;}
    finally{$('register-folder').disabled=false;}
  };
})();
