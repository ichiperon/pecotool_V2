import type { FC } from "react";

export const STEPS = [
  { label: "欄を定義", number: 1 },
  { label: "OCR 適用", number: 2 },
  { label: "確認", number: 3 },
  { label: "CSV 出力", number: 4 },
] as const;

export type StepNumber = 1 | 2 | 3 | 4;

interface StepBarProps {
  activeStep: StepNumber;
  /** 各ステップのクリック可否。省略すると全ステップがクリック不可（表示のみ）。 */
  stepEnabled?: Readonly<Record<StepNumber, boolean>>;
  /** ステップクリック時のコールバック */
  onStepSelect?: (step: StepNumber) => void;
  /** 各ステップの完了状態。省略時は activeStep より小さい番号を完了とみなす。 */
  stepCompleted?: Readonly<Partial<Record<StepNumber, boolean>>>;
  /** 無効ステップの理由（title 表示用）。省略したステップは title なし。 */
  stepDisabledTitle?: Readonly<Partial<Record<StepNumber, string>>>;
}

const StepBar: FC<StepBarProps> = ({
  activeStep,
  stepEnabled,
  onStepSelect,
  stepCompleted,
  stepDisabledTitle,
}) => {
  return (
    <nav className="step-bar" aria-label="作業ステップ">
      <ol className="step-bar__list">
        {STEPS.map((step, index) => {
          const num = step.number as StepNumber;
          const isActive = num === activeStep;
          const isCompleted =
            stepCompleted != null
              ? (stepCompleted[num] ?? false)
              : num < activeStep;

          const isEnabled = stepEnabled != null ? stepEnabled[num] : false;
          const isClickable = isEnabled && onStepSelect != null && !isActive;

          const statusClass = isActive
            ? "step-bar__item--active"
            : isCompleted
              ? "step-bar__item--completed"
              : "step-bar__item--pending";

          const numberContent = isCompleted ? (
            <>
              <span aria-hidden="true">✓</span>
              <span className="sr-only">完了</span>
            </>
          ) : (
            num
          );

          return (
            <li
              key={num}
              className={`step-bar__item ${statusClass}`}
              title={!isEnabled ? stepDisabledTitle?.[num] : undefined}
            >
              {index > 0 && (
                <span className="step-bar__connector" aria-hidden="true" />
              )}
              {isClickable ? (
                <button
                  type="button"
                  className="step-bar__step-btn"
                  onClick={() => onStepSelect(num)}
                  aria-current={isActive ? "step" : undefined}
                  aria-label={`ステップ ${num}: ${step.label}`}
                >
                  <span className="step-bar__number" aria-hidden="true">
                    {numberContent}
                  </span>
                  <span className="step-bar__label">{step.label}</span>
                </button>
              ) : (
                <span
                  className="step-bar__number"
                  aria-current={isActive ? "step" : undefined}
                >
                  {numberContent}
                </span>
              )}
              {!isClickable && (
                <span className="step-bar__label">{step.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
};

export default StepBar;
