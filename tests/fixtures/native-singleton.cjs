// Exercise the unmodified Electron 43 ProcessSingleton used by v0.1.15.
const {app} = require('electron')
const fs = require('node:fs')
const [profile, report] = process.argv.slice(2)
app.setName('codex-token-overlay')
app.setPath('userData', profile)
const acquired = app.requestSingleInstanceLock()
fs.writeFileSync(report, JSON.stringify({acquired, electron: process.versions.electron}))
if (!acquired) app.quit()
else app.whenReady().then(() => {
  const timer = setInterval(() => {
    if (fs.existsSync(`${report}.quit`)) { clearInterval(timer); app.quit() }
  }, 100)
})
