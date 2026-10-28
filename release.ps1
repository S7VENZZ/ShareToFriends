# Publishes a new version:  .\release.ps1 2.0.2
# Sets the version, commits, tags and pushes. GitHub Actions then builds the installer and creates the release;
# installed apps pick it up as an automatic update.
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (git status --porcelain) { throw 'Es gibt uncommittete Änderungen. Bitte erst committen (oder verwerfen).' }
if (git tag --list "v$Version") { throw "Das Tag v$Version gibt es schon." }

Push-Location app
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.version='$Version';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
if (Test-Path package-lock.json) {
  node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package-lock.json','utf8'));p.version='$Version';if(p.packages&&p.packages['']){p.packages[''].version='$Version'}fs.writeFileSync('package-lock.json',JSON.stringify(p,null,2)+'\n')"
}
npm test
if ($LASTEXITCODE -ne 0) { throw 'Die Tests sind fehlgeschlagen - es wurde nichts veröffentlicht.' }
Pop-Location

git add -A
git commit -m "Release v$Version"
git tag "v$Version"
git push
git push origin "v$Version"

Write-Host "v$Version wurde gepusht. Der Installer wird jetzt von GitHub gebaut (ca. 5 Minuten): Actions -> Release."
