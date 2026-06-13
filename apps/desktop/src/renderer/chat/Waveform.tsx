import { useEffect, useRef } from 'react'

// Live mic waveform drawn over the chat input while dictating, so it is unmistakable
// that recording has started. Purely decorative (aria-hidden) — the authoritative
// recording state stays the mic button's aria-pressed/label. Reads the analyser tap
// from lib/dictation (the SAME mic stream; never played back, never recorded). When
// the analyser is null (Web Audio unavailable / a test fake) it renders nothing, so
// recording keeps working with no waveform. Honours prefers-reduced-motion: a single
// static baseline instead of an animation loop.

interface WaveformProps {
  /** The live mic tap, or null when Web Audio is unavailable. */
  analyser: AnalyserNode | null
}

const STROKE = 2

export function Waveform({ analyser }: WaveformProps): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !analyser) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const data = new Uint8Array(analyser.fftSize)
    // The accent colour is theme-driven; read it once from the canvas's computed style.
    const accent =
      getComputedStyle(canvas).getPropertyValue('--accent').trim() || '#6aa0ff'

    let raf = 0

    function draw(): void {
      const c = canvasRef.current
      if (!c) return
      // Match the backing store to the on-screen size (DPR-aware) so the line is crisp.
      const dpr = window.devicePixelRatio || 1
      const w = c.clientWidth
      const h = c.clientHeight
      if (c.width !== w * dpr || c.height !== h * dpr) {
        c.width = w * dpr
        c.height = h * dpr
      }
      const g = ctx!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)

      if (analyser && !reduceMotion) analyser.getByteTimeDomainData(data)

      g.lineWidth = STROKE
      g.strokeStyle = accent
      g.lineJoin = 'round'
      g.beginPath()
      const mid = h / 2
      if (reduceMotion) {
        // Static baseline — no per-frame sampling, no animation.
        g.moveTo(0, mid)
        g.lineTo(w, mid)
      } else {
        const step = w / data.length
        for (let i = 0; i < data.length; i++) {
          // 128 is silence (centre); deviation scales to half the height.
          const y = mid + ((data[i] - 128) / 128) * mid
          if (i === 0) g.moveTo(0, y)
          else g.lineTo(i * step, y)
        }
      }
      g.stroke()

      if (!reduceMotion) raf = requestAnimationFrame(draw)
    }

    draw()
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
  }, [analyser])

  if (!analyser) return null
  return <canvas ref={canvasRef} className="dictation-waveform" aria-hidden />
}
