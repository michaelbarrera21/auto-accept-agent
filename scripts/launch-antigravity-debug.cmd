@echo off
REM Wrapper script to launch portable Antigravity with CDP port enabled
REM Uses C:\Users\puppy\AppData\Local\Programs\Antigravity as the installation directory
REM Uses a separate user-data-dir to avoid conflicts with main instance
REM Passes through all additional arguments (like --extensionDevelopmentPath)

start "" "C:\Users\puppy\AppData\Local\Programs\Antigravity\Antigravity.exe" --remote-debugging-port=9000 --user-data-dir="D:\antigravity-temp-user-data" %*
