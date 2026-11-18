@echo off
setlocal
cd /d "%~dp0"
title Viral Radar - setup

echo ==========================================
echo   Viral Radar
echo ==========================================
echo.

REM Lan dau: tu cai moi truong + thu vien + Chrome cho Playwright + ngrok, hoi mat khau va token.
REM Cac lan sau: bo qua phan da cai, chay server roi mo tunnel ngrok.
REM Them thu vien moi vao requirements.txt thi chi can chay lai file nay, no tu cai phan con thieu.

if not defined ENV_FILE set "ENV_FILE=%CD%\.env"
set "DEFAULT_DOMAIN=repulsive-neon-datebook.ngrok-free.dev"
set "VPY=.venv\Scripts\python.exe"

REM ---------- [1/6] Python ----------
set "PY="
where py >nul 2>&1 && py -3 -c "import sys;sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>&1 && set "PY=py -3"
if not defined PY where python >nul 2>&1 && python -c "import sys;sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>&1 && set "PY=python"
if not defined PY if exist "%LocalAppData%\Programs\Python\Python311\python.exe" set PY="%LocalAppData%\Programs\Python\Python311\python.exe"
if not defined PY if exist "%ProgramFiles%\Python311\python.exe" set PY="%ProgramFiles%\Python311\python.exe"
if exist "%VPY%" goto :python_ok
if defined PY goto :python_ok

echo [1/6] May chua co Python 3.10 tro len. Dang tu dong tai va cai dat Python 3.11...
echo       Dang tai bo cai tu python.org, khoang 25 MB...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe', 'python-3.11.exe')" >nul 2>&1
if not exist "python-3.11.exe" where curl >nul 2>&1 && curl.exe -L "https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe" -o python-3.11.exe >nul 2>&1
if not exist "python-3.11.exe" goto :cai_python_loi

echo       Dang cai dat Python 3.11 ngam, vui long doi giay lat...
start /wait "" python-3.11.exe /quiet InstallAllUsers=0 PrependPath=1 Include_test=0
del /f /q python-3.11.exe >nul 2>&1

if exist "%LocalAppData%\Programs\Python\Python311\python.exe" set PY="%LocalAppData%\Programs\Python\Python311\python.exe"
if not defined PY if exist "%ProgramFiles%\Python311\python.exe" set PY="%ProgramFiles%\Python311\python.exe"
if not defined PY where py >nul 2>&1 && py -3 -c "import sys;sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>&1 && set "PY=py -3"
if not defined PY where python >nul 2>&1 && python -c "import sys;sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>&1 && set "PY=python"

if defined PY goto :python_ok

:cai_python_loi
echo LOI: Khong the tu dong cai dat Python.
echo      Vui long tai bo cai thu cong tai: https://www.python.org/downloads/windows/
echo      Khi cai NHO TICH o Add python.exe to PATH, roi chay lai file nay.
echo.
if not defined NO_PAUSE pause
exit /b 1

:python_ok
if defined PY (for /f "delims=" %%v in ('%PY% --version 2^>nul') do echo [1/6] %%v - OK) else (echo [1/6] Python trong .venv - OK)

REM ---------- [2/6] Moi truong + thu vien ----------
if not exist "%VPY%" (
  echo [2/6] Dang tao moi truong Python .venv...
  %PY% -m venv .venv
  if errorlevel 1 (
    echo LOI: khong tao duoc .venv.
    if not defined NO_PAUSE pause
    exit /b 1
  )
)
REM So requirements.txt voi ban da cai lan truoc: giong nhau thi bo qua pip, khac thi cai them.
fc /b requirements.txt ".venv\requirements.installed" >nul 2>&1
if errorlevel 1 (
  echo [2/6] Dang cai thu vien, lan dau mat vai phut...
  "%VPY%" -m pip install --upgrade pip -q
  "%VPY%" -m pip install -r requirements.txt -q
  if errorlevel 1 (
    echo.
    echo LOI: cai thu vien that bai. Kiem tra ket noi mang roi chay lai.
    if not defined NO_PAUSE pause
    exit /b 1
  )
  copy /y requirements.txt ".venv\requirements.installed" >nul
  echo       Cai thu vien xong.
) else (
  echo [2/6] Thu vien da co - bo qua.
)

REM ---------- [3/6] Trinh duyet cho TikTok ----------
REM Tool uu tien Google Chrome cai san tren may; khong co thi dung Chromium cua Playwright.
if not exist ".venv\chromium.installed" (
  echo [3/6] Dang tai Chromium cho Playwright, khoang 150 MB...
  "%VPY%" -m playwright install chromium
  if errorlevel 1 (
    echo       CANH BAO: khong tai duoc Chromium. Neu may co Google Chrome thi van chay duoc.
  ) else (
    echo ok> ".venv\chromium.installed"
  )
) else (
  echo [3/6] Trinh duyet - OK
)

REM ---------- [4/6] ngrok ----------
REM Lay thang ban stable tu ngrok: ban tren winget/choco cu, khong hieu co --url.
if exist "ngrok.exe" goto :ngrok_san_sang
where ngrok >nul 2>&1
if not errorlevel 1 goto :ngrok_san_sang
echo [4/6] Chua co ngrok - dang tai ve...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip' -OutFile 'ngrok.zip'; Expand-Archive -Path 'ngrok.zip' -DestinationPath '.' -Force; Remove-Item 'ngrok.zip' -Force"
if exist "ngrok.exe" (
  echo       Tai xong ngrok.
  set "VUA_TAI_NGROK=1"
) else (
  echo       LOI: khong tai duoc ngrok. Tai tay tai https://ngrok.com/download
  echo            roi giai nen ngrok.exe vao thu muc nay.
)
:ngrok_san_sang
set "NGROK_CMD=%~dp0ngrok.exe"
if not exist "%NGROK_CMD%" set "NGROK_CMD=ngrok.exe"
if not exist "%NGROK_CMD%" set "NGROK_CMD=ngrok"
if not "%VUA_TAI_NGROK%"=="1" echo [4/6] ngrok - OK

REM ---------- [5/6] Cau hinh .env ----------
if exist "%ENV_FILE%" goto :doc_cau_hinh
echo [5/6] Lan dau chay - can 2 thong tin:
echo.
set "NEW_TOKEN="
set "OTHER_ENV=..\tiktok-facebook-reuploader\.env"
if exist "%OTHER_ENV%" for /f "delims=" %%v in ('.venv\Scripts\python.exe tools\env_tool.py copy-token "%OTHER_ENV%"') do set "OTHER_TOKEN=%%v"
if defined OTHER_TOKEN (
  choice /c YN /m "      Dung lai NGROK_AUTHTOKEN cua project tiktok-facebook-reuploader"
  if not errorlevel 2 set "NEW_TOKEN=%OTHER_TOKEN%"
)
if not defined NEW_TOKEN (
  echo      Lay ngrok authtoken tai https://dashboard.ngrok.com/get-started/your-authtoken
  set /p "NEW_TOKEN=      Dan ngrok authtoken roi Enter: "
)
:hoi_mat_khau
echo.
echo      Dat mat khau dang nhap web (nhan Enter de mo cong khai, khong can mat khau).
echo      Tranh dung cac ky tu  ^& ^| ^< ^> ^^ %% ! trong mat khau.
set "NEW_PASSWORD="
set /p "NEW_PASSWORD=      Mat khau (Enter de bo qua): "
set "NEW_USER=admin"
if "%NEW_PASSWORD%"=="" set "NEW_USER="
set "NEW_PORT=8000"
set "NEW_DOMAIN=%DEFAULT_DOMAIN%"
"%VPY%" tools\env_tool.py init
echo       Ten dang nhap: admin. Doi mat khau, token, domain: sua file .env roi chay lai.
echo.

:doc_cau_hinh
for /f "delims=" %%v in ('.venv\Scripts\python.exe tools\env_tool.py get PORT 8000') do set "PORT=%%v"
for /f "delims=" %%v in ('.venv\Scripts\python.exe tools\env_tool.py get VR_USER admin') do set "VR_USER=%%v"
for /f "delims=" %%v in ('.venv\Scripts\python.exe tools\env_tool.py get VR_PASSWORD') do set "VR_PASSWORD=%%v"
for /f "delims=" %%v in ('.venv\Scripts\python.exe tools\env_tool.py get NGROK_AUTHTOKEN') do set "NGROK_AUTHTOKEN=%%v"
for /f "delims=" %%v in ('.venv\Scripts\python.exe tools\env_tool.py get NGROK_DOMAIN %DEFAULT_DOMAIN%') do set "NGROK_DOMAIN=%%v"
echo [5/6] Cau hinh: cong %PORT%, dang nhap "%VR_USER%", domain %NGROK_DOMAIN%

REM ---------- [6/6] Khoi dong ----------
REM Server da chay roi (bam file nay lan nua) thi khong mo them cua so thu hai.
powershell -NoProfile -Command "try{Invoke-WebRequest 'http://127.0.0.1:%PORT%/' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0}catch{if($_.Exception.Response){exit 0}else{exit 1}}" >nul 2>&1
if not errorlevel 1 (
  echo [6/6] Server da dang chay tai cong %PORT% - khong mo them.
  goto :tunnel
)
echo [6/6] Dang khoi dong server...
start "Viral Radar Server" cmd /k ".venv\Scripts\python.exe server.py"
REM Cho server len that su roi moi mo tunnel. 401 = server da len, chi la doi dang nhap.
powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){try{Invoke-WebRequest 'http://127.0.0.1:%PORT%/' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0}catch{if($_.Exception.Response){exit 0}}; Start-Sleep -Milliseconds 750}; exit 1" >nul 2>&1
if errorlevel 1 (
  echo       LOI: server khong len sau 30 giay. Xem loi trong cua so "Viral Radar Server".
  if not defined NO_PAUSE pause
  exit /b 1
)
echo       Server da len.

:tunnel
if defined SKIP_NGROK goto :khong_co_tunnel
if "%NGROK_AUTHTOKEN%"=="" (
  echo       Chua co NGROK_AUTHTOKEN trong .env - bo qua tunnel.
  goto :khong_co_tunnel
)
if "%VR_PASSWORD%"=="" (
  echo       Che do: CONG KHAI (khong dat mat khau, ai co link ngrok deu xem duoc).
)
if "%VUA_TAI_NGROK%"=="1" if not exist "ngrok.exe" (
  echo.
  echo CANH BAO: ngrok.exe vua tai xong nhung bi xoa ngay, gan nhu chac chan do phan mem diet virus.
  echo           Mo PowerShell quyen Administrator va chay:
  echo             Add-MpPreference -ExclusionPath "%~dp0"
  echo.
  goto :khong_co_tunnel
)
if not exist "%NGROK_CMD%" where ngrok >nul 2>&1 || (
  echo       LOI: Khong tim thay ngrok.exe de mo tunnel.
  goto :khong_co_tunnel
)

REM Tunnel dang chay roi thi thoi.
powershell -NoProfile -Command "try{$t=(Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2).tunnels; if(($t | Where-Object { $_.public_url -like '*%NGROK_DOMAIN%*' }).Count -gt 0){exit 0}else{exit 1}}catch{exit 1}" >nul 2>&1
if not errorlevel 1 (
  echo       Tunnel ngrok da dang chay.
  goto :da_xong
)
REM Truyen token bang co dong lenh: may tung chay "ngrok config add-authtoken" cua tai khoan khac
REM thi file config do se lan at, gay loi ERR_NGROK_320 vi domain khong thuoc tai khoan.
echo       Dang mo tunnel ngrok tai %NGROK_DOMAIN%...
start "Viral Radar Tunnel" cmd /k ""%NGROK_CMD%" http %PORT% --url https://%NGROK_DOMAIN% --authtoken %NGROK_AUTHTOKEN%"
"%SystemRoot%\System32\timeout.exe" /t 6 /nobreak >nul 2>&1
powershell -NoProfile -Command "try{$t=(Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 5).tunnels; if($t.Count -gt 0){Write-Host ('      Tunnel OK: ' + $t[0].public_url)}else{throw 'x'}}catch{Write-Host '      TUNNEL CHUA LEN - xem cua so Viral Radar Tunnel. Hay gap:'; Write-Host '        ERR_NGROK_108: tai khoan ngrok free chi chay 1 tunnel 1 luc - tat tunnel cua app khac truoc.'; Write-Host '        ERR_NGROK_320: domain khong thuoc tai khoan cua token trong .env.'}"
goto :da_xong

:khong_co_tunnel
echo.
echo       Khong mo tunnel. Web van dung duoc tai http://localhost:%PORT%

:da_xong
echo.
echo ==========================================
echo   Da khoi dong xong.
echo   Tai may nay:  http://localhost:%PORT%
if not defined SKIP_NGROK if not "%NGROK_AUTHTOKEN%"=="" echo   Tu xa:        https://%NGROK_DOMAIN%
if not "%VR_PASSWORD%"=="" (echo   Dang nhap:    %VR_USER%  /  mat khau trong file .env) else (echo   Che do:       Cong khai (ai co link deu vao duoc, khong hoi mat khau))
echo   Tat: dong 2 cua so "Viral Radar Server" va "Viral Radar Tunnel".
echo ==========================================
echo.
if not defined NO_PAUSE pause
