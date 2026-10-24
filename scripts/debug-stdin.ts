/** Does ssh relay stdin progressively to a remote PowerShell, or only the initial burst? */
import { spawn } from 'node:child_process'

const host = process.argv[2]!
const extra = process.argv.slice(3)
const started = Date.now()
const stamp = () => `${String(Date.now() - started).padStart(6)}ms`

const remote = 'powershell -NoProfile -NonInteractive -Command "while($true){$l=[Console]::In.ReadLine(); if($null -eq $l){Write-Output EOF;break}; Write-Output (\'GOT:\'+$l); [Console]::Out.Flush()}"'
const child = spawn('ssh', ['-o', 'BatchMode=yes', ...extra, host, remote], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
child.stdout!.on('data', (c) => console.log(`${stamp()} OUT ${JSON.stringify(c.toString('utf8'))}`))
child.stderr!.on('data', (c) => console.log(`${stamp()} ERR ${JSON.stringify(c.toString('utf8'))}`))
child.on('close', (code, sig) => { console.log(`${stamp()} CLOSE ${code}/${sig}`); process.exit(0) })

const send = (text: string) => { console.log(`${stamp()} IN  ${text}`); child.stdin!.write(`${text}\n`) }
send('first')
setTimeout(() => send('second-at-3s'), 3000)
setTimeout(() => send('third-at-6s'), 6000)
setTimeout(() => { console.log(`${stamp()} EOF`); child.stdin!.end() }, 10000)
setTimeout(() => child.kill(), 14000)
