@echo off
rem Publishes rein-wallet to npm and redeploys the site, in one command, on
rem Windows: scripts\release.cmd  (from the rein folder). npm asks for its
rem own login and one-time code if needed; nothing else is asked.
setlocal
set BRANCH=claude/testable-mvp-vcuibn
cd /d "%~dp0.." || exit /b 1

echo == Getting the latest %BRANCH%
git fetch origin %BRANCH% || exit /b 1
git checkout %BRANCH% || (echo Commit or stash local changes first, then run this again. & exit /b 1)
git pull --ff-only origin %BRANCH% || (echo This copy of %BRANCH% has its own commits; tell Claude in the Rein thread. & exit /b 1)

for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set VERSION=%%v
call npm view rein-wallet@%VERSION% version >nul 2>&1 && (echo rein-wallet %VERSION% is already on npm; skipping the publish.) && goto deploy

echo == Publishing rein-wallet %VERSION%
call npm whoami >nul 2>&1 || call npm login || exit /b 1
call npm publish --access public || exit /b 1

:deploy
echo == Redeploying rein-nine.vercel.app
cd web || exit /b 1
call vercel --prod --yes || exit /b 1
cd ..

echo.
echo Done: rein-wallet %VERSION% is on npm and the site is redeployed.
echo Type "published" in the Rein thread.
