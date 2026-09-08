import { openSync, readSync, closeSync, statSync } from 'node:fs'
const file = process.argv[2]
const limitMs = Number(process.argv[3] ?? 15000)
const size = statSync(file).size
const fd = openSync(file, 'r')
const buf = Buffer.allocUnsafe(8 * 1024 * 1024)
let total = 0, pos = 0
const t0 = performance.now()
let lastT = t0, lastB = 0
const marks = []
while (pos < size) {
  const n = readSync(fd, buf, 0, buf.length, pos)
  if (n <= 0) break
  pos += n; total += n
  const now = performance.now()
  if (now - lastT >= 5000) { marks.push(((total - lastB) / 1e6 / ((now - lastT) / 1000)).toFixed(1)); lastT = now; lastB = total }
  if (now - t0 > limitMs) break
}
closeSync(fd)
const s = (performance.now() - t0) / 1000
console.log(JSON.stringify({ file, fileGB: (size / 1e9).toFixed(2), readMB: (total / 1e6).toFixed(0), seconds: s.toFixed(1), avgMBps: (total / 1e6 / s).toFixed(1), per5sMBps: marks }))
