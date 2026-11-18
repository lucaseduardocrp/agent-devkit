import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { fitBounds, type CanvasBounds, type WorkflowViewport } from './workflow-graph.js';

// Low enough for a long flow to be fitted whole, so the whole flow is visible without scrolling.
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 1.6;
export const ZOOM_STEP = 0.15;
/** Breathing room, in pixels, between the fitted content and the edge of the canvas. */
export const FIT_PADDING = 32;

export type CanvasViewport = WorkflowViewport;

const INITIAL_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(zoom.toFixed(2))));
}

/**
 * The pan and zoom of a canvas that always starts with all of its content in view, with no
 * scrolling: it is framed as soon as the canvas has a size (a modal can be laid out a moment after
 * it mounts), again whenever the canvas is resized (a rotated tablet, a smaller window) and again
 * when `refitKey` changes (a node added or removed). Once the person pans or zooms, their view is
 * left alone until they reset it.
 *
 * @param getBounds The rectangle to keep in view, in canvas space; null while there is none.
 * @param refitKey A value that changes whenever the content to frame changes.
 * @param padding Pixels kept free between the framed content and the edge of the canvas.
 */
export function useCanvasViewport(
  getBounds: () => CanvasBounds | null,
  refitKey: unknown,
  padding: number = FIT_PADDING,
) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<CanvasViewport>(INITIAL_VIEWPORT);
  /** Whether the person framed the view themselves, which the canvas then leaves alone. */
  const adjusted = useRef(false);
  const boundsRef = useRef(getBounds);
  boundsRef.current = getBounds;

  /** Frames all the content in the canvas; null until the canvas has been laid out. */
  const fitView = useCallback((): CanvasViewport | null => {
    const bounds = boundsRef.current();
    if (!bounds) return null;
    // Only called after mount, when the surface exists. The layout size is used, not the
    // bounding box: a modal that is still animating in is drawn smaller than it is laid out.
    const surface = surfaceRef.current!;
    return fitBounds(
      bounds,
      { width: surface.clientWidth, height: surface.clientHeight },
      { padding, minZoom: MIN_ZOOM },
    );
  }, [padding]);

  const zoomBy = (delta: number) => {
    adjusted.current = true;
    setViewport((current) => ({ ...current, zoom: clampZoom(current.zoom + delta) }));
  };

  const panBy = (deltaX: number, deltaY: number) => {
    adjusted.current = true;
    setViewport((current) => ({ ...current, x: current.x + deltaX, y: current.y + deltaY }));
  };

  const resetView = () => {
    adjusted.current = false;
    setViewport(fitView() ?? INITIAL_VIEWPORT);
  };

  /** Ctrl + wheel zooms, a plain wheel is left to the page. */
  const handleWheel = (event: { readonly ctrlKey: boolean; readonly deltaY: number }) => {
    if (!event.ctrlKey) return;
    zoomBy(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  };

  /** Frames the content, unless the person already panned or zoomed it themselves. */
  const frameView = useCallback(() => {
    if (adjusted.current) return;
    const view = fitView();
    if (view) setViewport(view);
  }, [fitView]);

  useLayoutEffect(() => frameView(), [frameView, refitKey]);
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(frameView);
    observer.observe(surfaceRef.current!);
    return () => observer.disconnect();
  }, [frameView]);

  return { surfaceRef, viewport, zoomBy, panBy, resetView, handleWheel };
}
