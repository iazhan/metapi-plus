import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type TooltipSide = 'top' | 'bottom';
type TooltipAlign = 'start' | 'center' | 'end';
export type StructuredTooltipTone =
  | 'default'
  | 'muted'
  | 'info'
  | 'accent'
  | 'success'
  | 'warning';

export type StructuredTooltipDetail = {
  title: string;
  sections: Array<{
    title?: string;
    rows: Array<{
      label: string;
      value: string;
      tone?: StructuredTooltipTone;
    }>;
  }>;
};

type ActiveTooltip = {
  target: HTMLElement;
  text: string;
  detail: StructuredTooltipDetail | null;
  side: TooltipSide;
  align: TooltipAlign;
};

type TooltipPosition = {
  left: number;
  top: number;
  arrowLeft: number;
  side: TooltipSide;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const STRUCTURED_TOOLTIP_TONES = new Set<StructuredTooltipTone>([
  'default',
  'muted',
  'info',
  'accent',
  'success',
  'warning',
]);

function readNonEmptyText(value: unknown, maxLength = 240): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

export function parseStructuredTooltipDetail(
  raw: string | null,
): StructuredTooltipDetail | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    const title = readNonEmptyText(candidate.title, 80);
    if (!title || !Array.isArray(candidate.sections)) return null;

    const sections = candidate.sections.slice(0, 8).flatMap((sectionValue) => {
      if (
        !sectionValue
        || typeof sectionValue !== 'object'
        || Array.isArray(sectionValue)
      ) return [];
      const section = sectionValue as Record<string, unknown>;
      if (!Array.isArray(section.rows)) return [];
      const rows = section.rows.slice(0, 30).flatMap((rowValue) => {
        if (
          !rowValue
          || typeof rowValue !== 'object'
          || Array.isArray(rowValue)
        ) return [];
        const row = rowValue as Record<string, unknown>;
        const label = readNonEmptyText(row.label, 80);
        const value = readNonEmptyText(row.value);
        if (!label || !value) return [];
        const tone = STRUCTURED_TOOLTIP_TONES.has(
          row.tone as StructuredTooltipTone,
        )
          ? row.tone as StructuredTooltipTone
          : 'default';
        return [{ label, value, tone }];
      });
      if (rows.length === 0) return [];
      const sectionTitle = readNonEmptyText(section.title, 80);
      return [{
        ...(sectionTitle ? { title: sectionTitle } : {}),
        rows,
      }];
    });

    return sections.length > 0 ? { title, sections } : null;
  } catch {
    return null;
  }
}

function readTooltipSide(target: HTMLElement): TooltipSide {
  return target.getAttribute('data-tooltip-side') === 'bottom' ? 'bottom' : 'top';
}

function readTooltipAlign(target: HTMLElement): TooltipAlign {
  const align = target.getAttribute('data-tooltip-align');
  if (align === 'start' || align === 'end') return align;
  return 'center';
}

function resolveTooltipTarget(eventTarget: EventTarget | null): HTMLElement | null {
  if (!(eventTarget instanceof Element)) return null;
  const target = eventTarget.closest<HTMLElement>('[data-tooltip]');
  if (!target) return null;
  const text = target.getAttribute('data-tooltip');
  return text && text.trim() ? target : null;
}

export default function TooltipLayer() {
  const [activeTooltip, setActiveTooltip] = useState<ActiveTooltip | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const cancelFrame = useCallback(() => {
    if (rafRef.current === null || typeof window === 'undefined') return;
    window.cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const hideTooltip = useCallback(() => {
    cancelFrame();
    setActiveTooltip(null);
    setPosition(null);
  }, [cancelFrame]);

  const showTooltipForTarget = useCallback((target: HTMLElement | null) => {
    if (!target) {
      hideTooltip();
      return;
    }
    const text = target.getAttribute('data-tooltip')?.trim();
    if (!text) {
      hideTooltip();
      return;
    }

    setActiveTooltip({
      target,
      text,
      detail: parseStructuredTooltipDetail(
        target.getAttribute('data-tooltip-detail'),
      ),
      side: readTooltipSide(target),
      align: readTooltipAlign(target),
    });
  }, [hideTooltip]);

  const refreshPosition = useCallback(() => {
    if (!activeTooltip || !bubbleRef.current || typeof window === 'undefined') return;
    if (!activeTooltip.target.isConnected) {
      hideTooltip();
      return;
    }

    const targetRect = activeTooltip.target.getBoundingClientRect();
    const bubbleRect = bubbleRef.current.getBoundingClientRect();
    const viewportPadding = 12;
    const gap = 10;

    let left = targetRect.left;
    if (activeTooltip.align === 'center') {
      left = targetRect.left + targetRect.width / 2 - bubbleRect.width / 2;
    } else if (activeTooltip.align === 'end') {
      left = targetRect.right - bubbleRect.width;
    }

    let top = activeTooltip.side === 'bottom'
      ? targetRect.bottom + gap
      : targetRect.top - gap - bubbleRect.height;

    left = clamp(left, viewportPadding, window.innerWidth - viewportPadding - bubbleRect.width);
    top = clamp(top, viewportPadding, window.innerHeight - viewportPadding - bubbleRect.height);

    const targetCenter = targetRect.left + targetRect.width / 2;
    const arrowLeft = clamp(targetCenter - left, 14, bubbleRect.width - 14);

    setPosition({
      left,
      top,
      arrowLeft,
      side: activeTooltip.side,
    });
  }, [activeTooltip, hideTooltip]);

  const scheduleRefresh = useCallback(() => {
    cancelFrame();
    if (typeof window === 'undefined') return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      refreshPosition();
    });
  }, [cancelFrame, refreshPosition]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.dataset.tooltipPortal = 'true';
    return () => {
      delete document.body.dataset.tooltipPortal;
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleMouseOver = (event: MouseEvent) => {
      showTooltipForTarget(resolveTooltipTarget(event.target));
    };

    const handleFocusIn = (event: FocusEvent) => {
      showTooltipForTarget(resolveTooltipTarget(event.target));
    };

    const handleMouseOut = (event: MouseEvent) => {
      if (!activeTooltip) return;
      const nextTarget = resolveTooltipTarget(event.relatedTarget);
      if (nextTarget === activeTooltip.target) return;
      if (event.relatedTarget instanceof Node && activeTooltip.target.contains(event.relatedTarget)) return;
      hideTooltip();
    };

    const handleFocusOut = (event: FocusEvent) => {
      if (!activeTooltip) return;
      const nextTarget = resolveTooltipTarget(event.relatedTarget);
      if (nextTarget === activeTooltip.target) return;
      if (event.relatedTarget instanceof Node && activeTooltip.target.contains(event.relatedTarget)) return;
      hideTooltip();
    };

    const handlePointerDown = (event: Event) => {
      if (!activeTooltip) return;
      if (event.target instanceof Node && activeTooltip.target.contains(event.target)) return;
      hideTooltip();
    };

    document.addEventListener('mouseover', handleMouseOver);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('mouseout', handleMouseOut);
    document.addEventListener('focusout', handleFocusOut);
    document.addEventListener('pointerdown', handlePointerDown);

    return () => {
      document.removeEventListener('mouseover', handleMouseOver);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('mouseout', handleMouseOut);
      document.removeEventListener('focusout', handleFocusOut);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [activeTooltip, hideTooltip, showTooltipForTarget]);

  useLayoutEffect(() => {
    if (!activeTooltip) return;
    setPosition(null);
    scheduleRefresh();
  }, [activeTooltip, scheduleRefresh]);

  useEffect(() => {
    if (!activeTooltip || typeof window === 'undefined') return;
    const handleViewportChange = () => scheduleRefresh();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [activeTooltip, scheduleRefresh]);

  useEffect(() => () => cancelFrame(), [cancelFrame]);

  if (!activeTooltip || typeof document === 'undefined') return null;

  const activeSide = position?.side ?? activeTooltip.side;
  const bubbleClassName = [
    'tooltip-bubble',
    `tooltip-bubble-${activeSide}`,
    activeTooltip.detail ? 'is-detail' : '',
    position ? 'is-visible' : '',
  ].filter(Boolean).join(' ');

  const tooltip = (
    <div className="tooltip-layer" aria-hidden="true">
      <div
        ref={bubbleRef}
        className={bubbleClassName}
        style={position ? {
          position: 'fixed',
          left: position.left,
          top: position.top,
        } : {
          position: 'fixed',
          left: 0,
          top: 0,
          visibility: 'hidden',
        }}
      >
        {activeTooltip.detail ? (
          <div className="tooltip-detail">
            <div className="tooltip-detail-title">
              {activeTooltip.detail.title}
            </div>
            {activeTooltip.detail.sections.map((section, sectionIndex) => (
              <div
                className="tooltip-detail-section"
                key={`${section.title ?? 'section'}-${sectionIndex}`}
              >
                {section.title ? (
                  <div className="tooltip-detail-section-title">
                    {section.title}
                  </div>
                ) : null}
                {section.rows.map((row, rowIndex) => (
                  <div
                    className="tooltip-detail-row"
                    key={`${row.label}-${rowIndex}`}
                  >
                    <span className="tooltip-detail-label">{row.label}</span>
                    <strong
                      className={`tooltip-detail-value is-${row.tone ?? 'default'}`}
                    >
                      {row.value}
                    </strong>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : activeTooltip.text}
        <span
          className={`tooltip-bubble-arrow tooltip-bubble-arrow-${activeSide}`}
          style={position ? { left: position.arrowLeft } : undefined}
        />
      </div>
    </div>
  );

  return createPortal(tooltip, document.body);
}
