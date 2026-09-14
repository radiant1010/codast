"""A user-triggered folder dialog on the local Windows server desktop."""
import asyncio
import json
import os
import subprocess


def choose_folder():
    if os.name != 'nt':
        raise ValueError('폴더 선택 창은 현재 Windows 로컬 실행에서 지원합니다.')
    script = r'''
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$picker = New-Object System.Windows.Forms.FolderBrowserDialog
$picker.Description = 'Codast에서 사용할 워크스페이스 폴더를 선택하세요'
$picker.ShowNewFolderButton = $false
try {
    $result = $picker.ShowDialog()
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
        ConvertTo-Json -Compress -InputObject @{path=$picker.SelectedPath}
    } else { ConvertTo-Json -Compress -InputObject @{path=$null} }
} finally { $picker.Dispose() }
'''
    try:
        result = subprocess.run(['powershell.exe', '-NoProfile', '-STA', '-Command', script],
                                capture_output=True, encoding='utf-8', timeout=180,
                                creationflags=subprocess.CREATE_NO_WINDOW)
    except subprocess.TimeoutExpired as exc:
        raise ValueError('폴더 선택 시간이 지났습니다. 다시 선택하세요.') from exc
    if result.returncode:
        raise ValueError('폴더 선택 창을 열지 못했습니다. 로컬 데스크톱에서 서버를 실행했는지 확인하세요.')
    return json.loads(result.stdout.strip().lstrip('\ufeff'))['path']


class FolderPicker:
    def __init__(self):
        self.busy = False

    async def pick(self):
        if self.busy:
            raise FileExistsError('이미 폴더 선택 창이 열려 있습니다.')
        self.busy = True
        task = asyncio.create_task(asyncio.to_thread(choose_folder))
        task.add_done_callback(lambda _: setattr(self, 'busy', False))
        return await asyncio.shield(task)
