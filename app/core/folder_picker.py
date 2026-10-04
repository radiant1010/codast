"""A user-triggered folder dialog on the local Windows server desktop."""
import asyncio
import json
import os
import subprocess
import shutil


def choose_folder(executable=False):
    if os.name != 'nt':
        raise ValueError('폴더 선택 창은 현재 Windows 로컬 실행에서 지원합니다.')
    script = r'''
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$owner = New-Object System.Windows.Forms.Form
$owner.Text = 'Codast 경로 선택'
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Width = 320
$owner.Height = 100
$owner.StartPosition = 'CenterScreen'
$picker = New-Object System.Windows.Forms.FolderBrowserDialog
$picker.Description = 'Codast에서 사용할 워크스페이스 폴더를 선택하세요'
$picker.ShowNewFolderButton = $false
try {
    $owner.Show()
    $owner.Activate()
    $result = $picker.ShowDialog($owner)
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
        ConvertTo-Json -Compress -InputObject @{path=$picker.SelectedPath}
    } else { ConvertTo-Json -Compress -InputObject @{path=$null} }
} finally { $picker.Dispose(); $owner.Close(); $owner.Dispose() }
'''
    if executable:
        script = script.replace("$picker = New-Object System.Windows.Forms.FolderBrowserDialog\n$picker.Description = 'Codast에서 사용할 워크스페이스 폴더를 선택하세요'\n$picker.ShowNewFolderButton = $false", "$picker = New-Object System.Windows.Forms.OpenFileDialog\n$picker.Title = 'CLI 실행 파일을 선택하세요'\n$picker.Filter = '실행 파일 (*.exe)|*.exe'\n$picker.CheckFileExists = $true\n$picker.Multiselect = $false")
        script = script.replace('$picker.SelectedPath', '$picker.FileName')
    try:
        # Do not inherit SW_HIDE from a background-launched server.
        startup = subprocess.STARTUPINFO()
        startup.lpDesktop = 'winsta0\\default'
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = 1  # SW_SHOWNORMAL; CREATE_NO_WINDOW still hides the console.
        result = subprocess.run([shutil.which('pwsh.exe') or 'powershell.exe', '-NoProfile', '-NonInteractive', '-STA', '-Command', script],
                                capture_output=True, encoding='utf-8', timeout=60, startupinfo=startup,
                                creationflags=subprocess.CREATE_NO_WINDOW)
    except subprocess.TimeoutExpired as exc:
        raise ValueError('선택 창 대기 시간이 지났습니다. 다시 선택하거나 경로를 직접 입력하세요.') from exc
    except OSError as exc:
        raise ValueError('Windows 선택 창을 시작하지 못했습니다. 경로를 직접 입력하세요.') from exc
    if result.returncode:
        raise ValueError('Windows 선택 창을 열지 못했습니다. 경로를 직접 입력하거나 로컬 데스크톱에서 서버를 실행하세요.')
    return json.loads(result.stdout.strip().lstrip('\ufeff'))['path']


class FolderPicker:
    def __init__(self):
        self.busy = False

    async def pick(self, *, executable=False):
        if self.busy:
            raise FileExistsError('이미 폴더 선택 창이 열려 있습니다.')
        self.busy = True
        task = asyncio.create_task(asyncio.to_thread(choose_folder, True) if executable else asyncio.to_thread(choose_folder))
        task.add_done_callback(lambda _: setattr(self, 'busy', False))
        return await asyncio.shield(task)
