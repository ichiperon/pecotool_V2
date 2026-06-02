import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

// localStorage key for onboarding state
export const ONBOARDING_STORAGE_KEY = 'pecotool.onboardingShown';

export interface TourStep {
  title: string;
  description: string;
  /** CSS selector for the spotlight target element. null = centered modal (no spotlight) */
  targetSelector: string | null;
}

const TOUR_STEPS: TourStep[] = [
  {
    title: 'ようこそ Peco へ',
    description: '日本語 OCR + PDF 編集ツールです。\nこのツアーで基本的な操作を紹介します。',
    targetSelector: null,
  },
  {
    title: 'PDF を読み込む',
    description: 'メニューバーの「ファイル → 開く」から PDF ファイルを読み込みます。\nCtrl+O のショートカットキーも使えます。',
    targetSelector: '[data-tour="menubar-file"]',
  },
  {
    title: 'OCR を実行する',
    description: 'ツールバーの OCR ボタンをクリックすると、現在のページを OCR 解析します。\nテキストブロック（BB）が自動的に検出されます。',
    targetSelector: '[data-tour="toolbar-ocr"]',
  },
  {
    title: 'テキストを編集する',
    description: '右パネルでテキストブロックの内容を直接編集できます。\nOCR の誤認識を修正したり、テキストを追加・削除したりできます。',
    targetSelector: '[data-tour="ocr-editor"]',
  },
  {
    title: '保存とヘルプ',
    description: 'Ctrl+S で上書き保存、Ctrl+Shift+S で別名保存ができます。\n詳しい使い方はヘルプメニューの「ツールの使い方」から確認できます。',
    targetSelector: '[data-tour="menubar-help"]',
  },
];

interface SpotlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface TooltipPosition {
  top: number;
  left: number;
  placement: 'below' | 'above' | 'right' | 'left' | 'center';
}

const PADDING = 8; // spotlight padding around target element
const TOOLTIP_OFFSET = 16; // gap between spotlight and tooltip

function getSpotlightRect(selector: string): SpotlightRect | null {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return {
    top: rect.top - PADDING,
    left: rect.left - PADDING,
    width: rect.width + PADDING * 2,
    height: rect.height + PADDING * 2,
  };
}

function computeTooltipPosition(
  spotRect: SpotlightRect | null,
  tooltipWidth: number,
  tooltipHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): TooltipPosition {
  if (!spotRect) {
    return {
      top: viewportHeight / 2 - tooltipHeight / 2,
      left: viewportWidth / 2 - tooltipWidth / 2,
      placement: 'center',
    };
  }

  const spotBottom = spotRect.top + spotRect.height;
  const spotRight = spotRect.left + spotRect.width;
  const spaceBelow = viewportHeight - spotBottom;
  const spaceAbove = spotRect.top;
  const spaceRight = viewportWidth - spotRight;

  // Prefer: below → above → right
  if (spaceBelow >= tooltipHeight + TOOLTIP_OFFSET) {
    const left = Math.min(
      Math.max(spotRect.left, 8),
      viewportWidth - tooltipWidth - 8,
    );
    return {
      top: spotBottom + TOOLTIP_OFFSET,
      left,
      placement: 'below',
    };
  }
  if (spaceAbove >= tooltipHeight + TOOLTIP_OFFSET) {
    const left = Math.min(
      Math.max(spotRect.left, 8),
      viewportWidth - tooltipWidth - 8,
    );
    return {
      top: spotRect.top - tooltipHeight - TOOLTIP_OFFSET,
      left,
      placement: 'above',
    };
  }
  if (spaceRight >= tooltipWidth + TOOLTIP_OFFSET) {
    const top = Math.min(
      Math.max(spotRect.top, 8),
      viewportHeight - tooltipHeight - 8,
    );
    return {
      top,
      left: spotRight + TOOLTIP_OFFSET,
      placement: 'right',
    };
  }

  // Fallback: center of screen
  return {
    top: viewportHeight / 2 - tooltipHeight / 2,
    left: viewportWidth / 2 - tooltipWidth / 2,
    placement: 'center',
  };
}

interface OnboardingTourProps {
  onClose: () => void;
}

export function OnboardingTour({ onClose }: OnboardingTourProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [spotRect, setSpotRect] = useState<SpotlightRect | null>(null);
  // #247: Use null as initial value so the tooltip stays hidden (visibility:hidden)
  // until the first effect run computes the real position and avoids a (0,0) flash.
  const [tooltipPos, setTooltipPos] = useState<TooltipPosition | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const currentStep = TOUR_STEPS[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === TOUR_STEPS.length - 1;

  // Update spotlight rect whenever step changes
  useEffect(() => {
    const update = () => {
      const selector = currentStep.targetSelector;
      const rect = selector ? getSpotlightRect(selector) : null;
      setSpotRect(rect);

      const tooltip = tooltipRef.current;
      const tw = tooltip?.offsetWidth ?? 320;
      const th = tooltip?.offsetHeight ?? 160;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      setTooltipPos(computeTooltipPosition(rect, tw, th, vw, vh));
    };

    // Small delay to let DOM settle after step transition
    const id = window.setTimeout(update, 50);
    return () => window.clearTimeout(id);
  }, [stepIndex, currentStep.targetSelector]);

  const handleNext = () => {
    if (isLast) {
      handleFinish();
    } else {
      setStepIndex(prev => prev + 1);
    }
  };

  const handleBack = () => {
    if (!isFirst) setStepIndex(prev => prev - 1);
  };

  const handleFinish = () => {
    try {
      localStorage.setItem(ONBOARDING_STORAGE_KEY, 'true');
    } catch {
      // localStorage might be unavailable in some environments
    }
    onClose();
  };

  return (
    <div
      className="onboarding-tour-root"
      role="dialog"
      aria-modal="true"
      aria-label="チュートリアル"
    >
      {/* Overlay: 4-mask divs to create spotlight hole */}
      <AnimatePresence mode="wait">
        <motion.div
          key={`overlay-${stepIndex}`}
          className="onboarding-overlay-masks"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={handleFinish}
          aria-hidden="true"
        >
          {spotRect ? (
            <>
              <div
                className="onboarding-mask onboarding-mask--top"
                style={{ height: spotRect.top }}
              />
              <div
                className="onboarding-mask onboarding-mask--bottom"
                style={{ top: spotRect.top + spotRect.height }}
              />
              <div
                className="onboarding-mask onboarding-mask--left"
                style={{
                  top: spotRect.top,
                  height: spotRect.height,
                  width: spotRect.left,
                }}
              />
              <div
                className="onboarding-mask onboarding-mask--right"
                style={{
                  top: spotRect.top,
                  height: spotRect.height,
                  left: spotRect.left + spotRect.width,
                }}
              />
            </>
          ) : (
            <div className="onboarding-mask onboarding-mask--full" />
          )}
        </motion.div>
      </AnimatePresence>

      {/* Spotlight border highlight */}
      {spotRect && (
        <AnimatePresence mode="wait">
          <motion.div
            key={`highlight-${stepIndex}`}
            className="onboarding-spotlight-border"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{
              top: spotRect.top,
              left: spotRect.left,
              width: spotRect.width,
              height: spotRect.height,
            }}
            aria-hidden="true"
          />
        </AnimatePresence>
      )}

      {/* Tooltip card */}
      <AnimatePresence mode="wait">
        <motion.div
          key={`tooltip-${stepIndex}`}
          ref={tooltipRef}
          className="onboarding-tooltip"
          role="document"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }}
          style={{
            position: 'fixed',
            top: tooltipPos?.top ?? 0,
            left: tooltipPos?.left ?? 0,
            visibility: tooltipPos ? 'visible' : 'hidden',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Progress dots */}
          <div className="onboarding-progress">
            {TOUR_STEPS.map((_, i) => (
              <div
                key={i}
                className={`onboarding-dot${i === stepIndex ? ' active' : ''}`}
                aria-hidden="true"
              />
            ))}
          </div>

          {/* Title */}
          <h2 className="onboarding-title">{currentStep.title}</h2>

          {/* Description */}
          <p className="onboarding-description">
            {currentStep.description.split('\n').map((line, i, lines) => (
              <span key={i}>
                {line}
                {i < lines.length - 1 && <br />}
              </span>
            ))}
          </p>

          {/* Step counter */}
          <div className="onboarding-step-counter">
            {stepIndex + 1} / {TOUR_STEPS.length}
          </div>

          {/* Buttons */}
          <div className="onboarding-buttons">
            <button
              type="button"
              className="onboarding-btn onboarding-btn-skip"
              onClick={handleFinish}
            >
              スキップ
            </button>

            <div className="onboarding-btn-group">
              {!isFirst && (
                <button
                  type="button"
                  className="onboarding-btn onboarding-btn-back"
                  onClick={handleBack}
                >
                  戻る
                </button>
              )}
              <button
                type="button"
                className="onboarding-btn onboarding-btn-next"
                onClick={handleNext}
                data-autofocus
              >
                {isLast ? 'ツアーを終了' : '次へ'}
              </button>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** Returns true if the onboarding tour should be shown on first launch */
export function shouldShowOnboarding(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_STORAGE_KEY) !== 'true';
  } catch {
    return false;
  }
}

/** Resets the onboarding flag so the tour will show again */
export function resetOnboarding(): void {
  try {
    localStorage.removeItem(ONBOARDING_STORAGE_KEY);
  } catch {
    // ignore
  }
}
