// Print the key figures of one start: node summarize.mjs <stem>
import { readFileSync } from 'node:fs'
const j = JSON.parse(readFileSync(process.argv[2] + '.json', 'utf8'))
const t = j.timings
console.log('argv', j.argv)
console.log('before', JSON.stringify(j.before.nvidia_smi), 'probe:', j.before.list_devices.split('\n')[1]?.trim())
console.log('load_ms', j.load_ms, 'after_load', JSON.stringify(j.after_load.nvidia_smi), 'probe loaded:', j.after_load.list_devices.split('\n')[1]?.trim())
console.log('peak', JSON.stringify(j.peak_nvidia_smi), 'after_stop', JSON.stringify(j.after_stop.nvidia_smi), 'exit', JSON.stringify(j.after_stop.exit), 'leak', j.prompt_text_in_log, 'errs', j.request_errors.length)
console.log('timings', JSON.stringify(t))
console.log('heaps', JSON.stringify(j.heap_samples.map((s) => [s.phase, s.heaps[0].budget_mib, s.heaps[2].usage_mib, s.heaps[2].budget_mib])))
console.log('--offload'); console.log(j.fit.offloaded.join('\n'))
console.log('--buffers'); console.log(j.fit.buffers.map((l) => l.replace(/^\S+ I /, '')).join('\n'))
console.log('--fit'); console.log(j.fit.fit.filter((l) => /fit_impl|fit_params|n_slots|n_parallel/.test(l)).map((l) => l.replace(/^\S+ I /, '')).join('\n'))
console.log('--kv'); console.log(j.fit.kv.filter((l) => /n_parallel|n_seq_max|n_ubatch|n_batch|recurrent: size|kv_cache: size|KV self/.test(l)).map((l) => l.replace(/^\S+ I /, '')).join('\n'))
console.log('--spec'); console.log(j.fit.spec.filter((l) => /estimated|acceptance|n_max=/.test(l)).map((l) => l.replace(/^\S+ I /, '')).join('\n'))
console.log('excerpt lines', j.excerpt.length)
