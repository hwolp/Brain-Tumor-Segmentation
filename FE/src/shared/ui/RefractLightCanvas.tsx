import * as React from 'react';
import { cn } from '@/shared/lib/cn';

export interface RefractLightCanvasProps {
  variant?: 'glass' | 'water';
  className?: string;
}

function drawGlassFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  phase: number,
) {
  ctx.clearRect(0, 0, width, height);

  const drift = Math.sin(phase * Math.PI * 2) * width * 0.045;
  const verticalDrift = Math.cos(phase * Math.PI * 2) * height * 0.025;

  // Sunlit glazed-window pane passing at low angle on the calm right/upper side
  ctx.save();
  ctx.translate(width * 0.62 + drift, height * 0.44 + verticalDrift);
  ctx.rotate((-19 * Math.PI) / 180);

  const spanW = width * 0.85;
  const spanH = height * 1.45;

  // Spectral glass dispersion bands (--spec-1..4 tinted softly over sunlit paper)
  const prism = ctx.createLinearGradient(-spanW * 0.48, -spanH * 0.25, spanW * 0.45, spanH * 0.25);
  prism.addColorStop(0.0, 'rgba(255, 255, 255, 0)');
  prism.addColorStop(0.24, 'rgba(249, 175, 132, 0.14)');
  prism.addColorStop(0.42, 'rgba(240, 232, 134, 0.14)');
  prism.addColorStop(0.58, 'rgba(130, 224, 206, 0.18)');
  prism.addColorStop(0.76, 'rgba(132, 168, 245, 0.16)');
  prism.addColorStop(1.0, 'rgba(255, 255, 255, 0)');

  ctx.fillStyle = prism;
  ctx.fillRect(-spanW * 0.5, -spanH * 0.5, spanW, spanH);

  // Secondary caustic highlight band
  const caustic = ctx.createLinearGradient(-spanW * 0.22, -spanH * 0.5, spanW * 0.34, spanH * 0.5);
  caustic.addColorStop(0.0, 'rgba(255, 255, 255, 0)');
  caustic.addColorStop(0.47, 'rgba(166, 224, 236, 0.14)');
  caustic.addColorStop(0.5, 'rgba(255, 255, 255, 0.58)');
  caustic.addColorStop(0.54, 'rgba(255, 255, 255, 0.22)');
  caustic.addColorStop(1.0, 'rgba(255, 255, 255, 0)');

  ctx.fillStyle = caustic;
  ctx.fillRect(-spanW * 0.5, -spanH * 0.5, spanW, spanH);

  // Sharp luminous white cusp along the pane edge
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.lineWidth = Math.max(1.5, width * 0.0022);
  ctx.beginPath();
  ctx.moveTo(-spanW * 0.04, -spanH * 0.48);
  ctx.lineTo(spanW * 0.16, spanH * 0.48);
  ctx.stroke();

  ctx.restore();
}

function drawWaterFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  phase: number,
) {
  ctx.clearRect(0, 0, width, height);

  const shade = ctx.createLinearGradient(width * 0.3, 0, width, height);
  shade.addColorStop(0, 'rgba(182, 229, 239, 0)');
  shade.addColorStop(0.55, 'rgba(182, 229, 239, 0.24)');
  shade.addColorStop(1, 'rgba(146, 209, 228, 0.36)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, width, height);

  // Gently curving bright water caustic filaments
  ctx.lineWidth = Math.max(1.5, width * 0.0024);
  for (let i = 0; i < 6; i += 1) {
    const offset = (i / 6) * height * 0.9 + height * 0.08;
    const wave = Math.sin((phase + i * 0.17) * Math.PI * 2) * 28;
    ctx.strokeStyle =
      i % 2 === 0
        ? 'rgba(255, 255, 255, 0.62)'
        : 'rgba(130, 224, 206, 0.26)';
    ctx.beginPath();
    ctx.moveTo(width * 0.28, offset + wave * 0.4);
    ctx.bezierCurveTo(
      width * 0.52,
      offset - wave,
      width * 0.76,
      offset + wave,
      width * 1.04,
      offset - wave * 0.5,
    );
    ctx.stroke();
  }
}

/**
 * Live Refract light canvas (`glass` or `water`), pauses offscreen/hidden
 * and stays completely static under `prefers-reduced-motion: reduce`.
 */
export function RefractLightCanvas({
  variant = 'glass',
  className,
}: RefractLightCanvasProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      return;
    }
    if (!ctx) return;

    const reducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let width = 1200;
    let height = 760;
    const syncSize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(320, Math.round(rect.width || window.innerWidth || 1200));
      height = Math.max(320, Math.round(rect.height || window.innerHeight || 760));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (phase: number) => {
      if (!ctx) return;
      if (variant === 'water') {
        drawWaterFrame(ctx, width, height, phase);
      } else {
        drawGlassFrame(ctx, width, height, phase);
      }
    };

    syncSize();
    draw(0.18);

    if (reducedMotion) {
      return;
    }

    let rafId = 0;
    let isVisible = !document.hidden;
    let isIntersecting = true;
    const periodMs = variant === 'water' ? 12000 : 60000;
    const start = performance.now();

    const tick = (now: number) => {
      if (!isVisible || !isIntersecting) {
        rafId = 0;
        return;
      }
      const phase = ((now - start) % periodMs) / periodMs;
      draw(phase);
      rafId = window.requestAnimationFrame(tick);
    };

    const ensureLoop = () => {
      if (isVisible && isIntersecting && rafId === 0) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    const onVisibilityChange = () => {
      isVisible = !document.hidden;
      if (isVisible) {
        ensureLoop();
      } else if (rafId !== 0) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
    };

    const onResize = () => {
      syncSize();
      const phase = ((performance.now() - start) % periodMs) / periodMs;
      draw(phase);
    };

    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver((entries) => {
        const entry = entries[0];
        isIntersecting = entry ? entry.isIntersecting : true;
        if (isIntersecting) {
          ensureLoop();
        } else if (rafId !== 0) {
          window.cancelAnimationFrame(rafId);
          rafId = 0;
        }
      });
      observer.observe(canvas);
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('resize', onResize, { passive: true });
    ensureLoop();

    return () => {
      if (rafId !== 0) {
        window.cancelAnimationFrame(rafId);
      }
      observer?.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('resize', onResize);
    };
  }, [variant]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn(
        'refract-light-mask pointer-events-none absolute inset-0 h-full w-full select-none',
        className,
      )}
    />
  );
}
