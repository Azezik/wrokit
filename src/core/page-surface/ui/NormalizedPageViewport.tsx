import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEventHandler,
  type ReactNode
} from 'react';

import type { NormalizedPage } from '../../contracts/normalized-page';
import {
  buildSurfaceTransform,
  getPageSurface,
  type DisplayRect,
  type ScreenPoint,
  type SurfaceTransform
} from '../page-surface';

import './normalized-page-viewport.css';

export interface NormalizedPageViewportHandle {
  measure(): void;
  getImageElement(): HTMLImageElement | null;
  getSurfaceTransform(): SurfaceTransform | null;
  pointerToImageRect(event: { clientX: number; clientY: number }): ScreenPoint | null;
}

export interface NormalizedPageViewportProps {
  page: NormalizedPage | null;
  className?: string;
  imageAlt?: string;
  overlayClassName?: string;
  overlayRole?: string;
  overlayAriaLabel?: string;
  interactive?: boolean;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  onPointerMove?: PointerEventHandler<HTMLDivElement>;
  onPointerUp?: PointerEventHandler<HTMLDivElement>;
  onPointerCancel?: PointerEventHandler<HTMLDivElement>;
  /**
   * Fired whenever the rendered image's measured rect changes (or the page
   * itself changes). Receives `null` when no page is loaded or the image has
   * not been laid out yet. Consumers use the transform to convert their saved
   * normalized rects into screen rects via `normalizedRectToScreen` —
   * positioning every overlay relative to the same plane.
   */
  onSurfaceTransformChange?: (transform: SurfaceTransform | null) => void;
  children?: ReactNode;
  emptyState?: ReactNode;
}

/**
 * Compute the absolute style that pins an overlay plane onto the rendered
 * image rect. Exposed so the invariant `image plane = overlay plane` is a
 * single, testable expression rather than scattered inline styles.
 */
export const overlayPlaneStyle = (displayRect: DisplayRect): CSSProperties => ({
  position: 'absolute',
  left: 0,
  top: 0,
  width: `${displayRect.width}px`,
  height: `${displayRect.height}px`
});

const measureImage = (image: HTMLImageElement | null): DisplayRect | null => {
  if (!image) {
    return null;
  }
  const rect = image.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return { width: rect.width, height: rect.height };
};

export const pointerToImageRect = (
  image: HTMLElement | null,
  event: { clientX: number; clientY: number }
): ScreenPoint | null => {
  if (!image) {
    return null;
  }
  const rect = image.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  return {
    x: Math.max(0, Math.min(rect.width, x)),
    y: Math.max(0, Math.min(rect.height, y))
  };
};

export const NormalizedPageViewport = forwardRef<
  NormalizedPageViewportHandle,
  NormalizedPageViewportProps
>(function NormalizedPageViewport(
  {
    page,
    className,
    imageAlt,
    overlayClassName,
    overlayRole,
    overlayAriaLabel,
    interactive = false,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onSurfaceTransformChange,
    children,
    emptyState = null
  },
  forwardedRef
) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [displayRect, setDisplayRect] = useState<DisplayRect | null>(null);

  const measure = useCallback(() => {
    const next = measureImage(imageRef.current);
    if (!next) {
      return;
    }
    setDisplayRect((prev) =>
      prev && prev.width === next.width && prev.height === next.height ? prev : next
    );
  }, []);

  const surfaceTransform = useMemo(() => {
    if (!page || !displayRect) {
      return null;
    }
    return buildSurfaceTransform(getPageSurface(page), displayRect);
  }, [page, displayRect]);

  useEffect(() => {
    onSurfaceTransformChange?.(surfaceTransform);
  }, [surfaceTransform, onSurfaceTransformChange]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      measure,
      getImageElement: () => imageRef.current,
      getSurfaceTransform: () => surfaceTransform,
      pointerToImageRect: (event) => pointerToImageRect(imageRef.current, event)
    }),
    [measure, surfaceTransform]
  );

  useEffect(() => {
    if (!imageRef.current || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(imageRef.current);
    measure();
    return () => observer.disconnect();
  }, [measure, page?.imageDataUrl]);

  // Reset measurement when the page identity changes so a stale rect from a
  // previous page can never feed an overlay transform on the new page.
  useEffect(() => {
    setDisplayRect(null);
  }, [page?.imageDataUrl]);

  const frameClassName = ['normalized-page-viewport', className].filter(Boolean).join(' ');
  const overlayClassNameFinal = [
    'normalized-page-viewport__overlay',
    interactive ? 'normalized-page-viewport__overlay--interactive' : null,
    overlayClassName
  ]
    .filter(Boolean)
    .join(' ');

  if (!page) {
    return <>{emptyState}</>;
  }

  return (
    <div className={frameClassName}>
      <img
        ref={imageRef}
        src={page.imageDataUrl}
        alt={imageAlt ?? `Normalized page ${page.pageIndex + 1}`}
        className="normalized-page-viewport__image"
        onLoad={measure}
        draggable={false}
      />
      {displayRect ? (
        <div
          className={overlayClassNameFinal}
          role={overlayRole}
          aria-label={overlayAriaLabel}
          style={overlayPlaneStyle(displayRect)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
});
